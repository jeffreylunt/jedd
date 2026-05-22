// Proactive download-status updates for the scheduler — decided in CODE, no LLM call.
//
// WHY: the Ollama backend is a fixed native-tool loop geared to inbound user requests; it has
// no DONE/SKIP follow-up contract. So the scheduler doesn't ask the model whether a download is
// ready — it reads the real Sonarr/Radarr state here and decides + words the update with a
// template. Deterministic, no model call.

import { config, type DownloadJob } from './config.js';
import {
  getRadarrMovie, getRadarrQueue, triggerMovieSearch,
  getSonarrSeries, getSonarrQueue, getAllEpisodeStatus, triggerMissingEpisodeSearch,
} from './arr-client.js';

export type StatusAction = 'skip' | 'progress' | 'done' | 'research' | 'import_stuck';

export interface StatusObservation {
  hasFile: boolean;        // movie file present / at least one monitored episode downloaded
  fullyDownloaded: boolean; // movie hasFile, or ALL monitored episodes have files
  queueActive: boolean;    // something in the arr queue for this job
  progressPct: number | null; // 0-100 if measurable from the queue, else null
  monitored: boolean;      // arr still monitoring this title
  // True when the download FINISHED but Radarr/Sonarr can't import it into the library: queue
  // item(s) in a completed/pending-import/blocked state, no active progress, hasFile still false.
  // Distinct from "still downloading" (has progress) and "still searching" (empty queue).
  importStuck: boolean;
}

export interface StatusDecision {
  action: StatusAction;
  message?: string;        // user-facing text (templated) for progress/done/research/import_stuck
  newProgress?: number;    // value to persist into job.lastProgress
  notifiedStuckImport?: boolean; // value to persist into job.notifiedStuckImport
}

// Only message about progress when it moved by at least this much since the last report,
// so the user isn't pinged for 31% -> 33%. Completion (100%/hasFile) always reports.
const PROGRESS_REPORT_STEP = 25;

/**
 * Pure decision function — given what the arr API reported and the job's last-reported
 * progress, decide whether/what to proactively tell the user. No I/O, fully unit-testable.
 */
export function decideStatusUpdate(
  job: DownloadJob,
  obs: StatusObservation,
  // True only on the FIRST check where nothing has appeared yet — used to re-trigger a search
  // that silently came back empty exactly once, instead of re-triggering on every tick.
  allowResearch: boolean,
): StatusDecision {
  const title = job.title;

  // 1. DONE — the file is on disk. Always tell the user; this is the news they're waiting for.
  if (obs.fullyDownloaded || obs.hasFile) {
    const verb = job.type === 'movie' ? 'is ready to watch' : 'has episodes ready to watch';
    return { action: 'done', message: `Good news — "${title}" ${verb}! 🍿` };
  }

  // 2. PROGRESS — actively downloading with a measurable, materially-changed percentage.
  if (obs.queueActive && obs.progressPct !== null) {
    const last = job.lastProgress ?? -1;
    const moved = obs.progressPct - last;
    if (last < 0 || moved >= PROGRESS_REPORT_STEP) {
      return {
        action: 'progress',
        message: `Quick update — "${title}" is downloading, about ${obs.progressPct}% done.`,
        newProgress: obs.progressPct,
      };
    }
    // Downloading but not enough new progress to bother the user.
    return { action: 'skip', newProgress: obs.progressPct };
  }

  // 2b. STUCK AT IMPORT — the download finished but arr can't import it into the library
  //     (the Eternity 2026-05-22 case: 17 grabbed releases all "completed" but import-blocked,
  //     hasFile stays false). Tell the user ONCE so Jedd doesn't go dark, then stay silent. The
  //     scheduler keeps the job alive in this state (no premature 24h/15-check expiry) so that
  //     when the import is fixed and the file lands, the next check reports DONE automatically.
  if (obs.importStuck) {
    if (!job.notifiedStuckImport) {
      return {
        action: 'import_stuck',
        message: `Quick update — "${title}" finished downloading but is having trouble importing into your library. I'm keeping an eye on it and will let you know the moment it's ready.`,
        notifiedStuckImport: true,
      };
    }
    // Already told them — don't spam. Stay flagged so we never re-notify.
    return { action: 'skip', notifiedStuckImport: true };
  }

  // 3. SILENT SEARCH FAILURE — nothing queued, no file, still monitored, and nothing has
  //    ever been seen for this job (no history of a release). Radarr/Sonarr do NOT auto-retry
  //    a search that came back empty (the About Time incident, decisions.md 2026-05-03).
  //    Re-trigger the search and let the user know we're on it.
  if (!obs.queueActive && obs.monitored && allowResearch) {
    return {
      action: 'research',
      message: `Quick update on "${title}" — the first search came up empty, so I'm re-running it. Should know more soon.`,
    };
  }

  // 4. SKIP — genuinely still searching / queued with no real change. Don't ping.
  return { action: 'skip' };
}

// A queue item is "downloaded but not yet imported" when its status/state indicates the download
// finished and arr is waiting on (or blocked from) import. Radarr/Sonarr surface this as
// status="completed" with a trackedDownloadState of importPending/importBlocked/importing, and/or
// trackedDownloadStatus="warning"/"error". We detect on the status/state strings.
function isPendingImport(item: { status?: string; trackedDownloadState?: string; trackedDownloadStatus?: string }): boolean {
  const state = (item.trackedDownloadState || '').toLowerCase();
  const status = (item.status || '').toLowerCase();
  if (/import(pending|blocked|ing)|failedpending/.test(state)) return true;
  // "completed" download status with no active downloading = sitting at the import step.
  if (status === 'completed') return true;
  return false;
}

// Stuck-at-import = at least one queue item is pending/blocked import, the file isn't on disk yet,
// and nothing is still actively downloading with measurable progress.
function computeImportStuck(queue: Array<{ status?: string; trackedDownloadState?: string; trackedDownloadStatus?: string; size?: number; sizeleft?: number }>, hasFile: boolean, progressPct: number | null): boolean {
  if (hasFile) return false;
  if (queue.length === 0) return false;
  const anyActivelyDownloading = queue.some(q => (q.status || '').toLowerCase() === 'downloading');
  if (anyActivelyDownloading && progressPct !== null) return false;
  return queue.some(isPendingImport);
}

/** Observe real Radarr/Sonarr state for a movie job. */
async function observeMovie(job: DownloadJob): Promise<StatusObservation> {
  const [movie, queue] = await Promise.all([
    getRadarrMovie(job.arrId).catch(() => null),
    getRadarrQueue(job.arrId).catch(() => [] as Awaited<ReturnType<typeof getRadarrQueue>>),
  ]);
  const item = queue[0];
  const progressPct = item && item.size > 0
    ? Math.max(0, Math.min(100, Math.round(100 * (1 - item.sizeleft / item.size))))
    : null;
  const hasFile = movie?.hasFile === true;
  return {
    hasFile,
    fullyDownloaded: hasFile,
    queueActive: queue.length > 0,
    progressPct,
    monitored: movie?.monitored !== false,
    importStuck: computeImportStuck(queue, hasFile, progressPct),
  };
}

/** Observe real Sonarr state for a TV job. */
async function observeTv(job: DownloadJob): Promise<StatusObservation> {
  const [series, episodes, queue] = await Promise.all([
    getSonarrSeries(job.arrId).catch(() => null),
    getAllEpisodeStatus(job.arrId).catch(() => [] as Awaited<ReturnType<typeof getAllEpisodeStatus>>),
    getSonarrQueue(job.arrId).catch(() => [] as Awaited<ReturnType<typeof getSonarrQueue>>),
  ]);
  const monitoredEps = episodes.filter(e => e.monitored && e.seasonNumber > 0);
  const withFile = monitoredEps.filter(e => e.hasFile);
  const hasFile = withFile.length > 0;
  const fullyDownloaded = monitoredEps.length > 0 && withFile.length === monitoredEps.length;

  // Aggregate queue progress across episode downloads.
  let size = 0, left = 0;
  for (const q of queue) { size += q.size || 0; left += q.sizeleft || 0; }
  const progressPct = size > 0
    ? Math.max(0, Math.min(100, Math.round(100 * (1 - left / size))))
    : null;

  return {
    hasFile,
    fullyDownloaded,
    queueActive: queue.length > 0,
    progressPct,
    monitored: series?.monitored !== false,
    importStuck: computeImportStuck(queue, hasFile, progressPct),
  };
}

/** Re-trigger a stalled/silent-failed search. */
async function retriggerSearch(job: DownloadJob): Promise<void> {
  if (job.type === 'movie') {
    await triggerMovieSearch(job.arrId);
  } else {
    await triggerMissingEpisodeSearch(job.arrId);
  }
}

export interface LocalStatusResult {
  action: StatusAction;
  message?: string; // user-facing message to send (undefined when skip)
  done: boolean;    // true => scheduler should mark the job complete
  importStuck: boolean; // true => downloaded-but-not-imported; scheduler must NOT expire the job
}

/**
 * Full backend-agnostic status check for one local-backend job: read real arr state, decide,
 * perform any silent re-trigger, and persist progress on the job. Returns the message (if any)
 * for the scheduler to send via BlueBubbles. No LLM involved.
 */
export async function localStatusCheck(
  job: DownloadJob,
  allowResearch: boolean,
): Promise<LocalStatusResult> {
  const obs = job.type === 'movie' ? await observeMovie(job) : await observeTv(job);
  const decision = decideStatusUpdate(job, obs, allowResearch);

  if (decision.newProgress !== undefined) job.lastProgress = decision.newProgress;
  if (decision.notifiedStuckImport !== undefined) job.notifiedStuckImport = decision.notifiedStuckImport;

  if (decision.action === 'research') {
    try {
      await retriggerSearch(job);
    } catch (err) {
      console.error(`[local-status] re-trigger search failed for "${job.title}":`, err);
    }
  }

  return {
    action: decision.action,
    message: decision.message,
    done: decision.action === 'done',
    importStuck: obs.importStuck,
  };
}

export const __test = { config, PROGRESS_REPORT_STEP };
