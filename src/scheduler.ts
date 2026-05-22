import { type AppState, type DownloadJob, saveState } from './config.js';
import { localStatusCheck } from './local-status.js';
import { sendMessage } from './send.js';

const CHECK_INTERVAL = 60 * 1000; // Check every 60 seconds if any jobs are due

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startScheduler(state: AppState): void {
  console.log(`[scheduler] Starting with ${state.activeJobs.filter((j) => j.status === 'downloading').length} active jobs`);

  intervalId = setInterval(() => tick(state), CHECK_INTERVAL);
  // Run immediately on start
  tick(state);
}

export function stopScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

async function tick(state: AppState): Promise<void> {
  const now = new Date();
  const dueJobs = state.activeJobs.filter(
    (j) => j.status === 'downloading' && new Date(j.nextCheckAt) <= now
  );

  for (const job of dueJobs) {
    try {
      await checkJob(job, state);
    } catch (error) {
      console.error(`[scheduler] Error checking job ${job.id}:`, error);
      // Reschedule for later
      job.nextCheckAt = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
      job.checkCount++;
    }
  }

  // Clean up completed jobs older than 24h
  try {
    const cutoff = now.getTime() - 24 * 60 * 60 * 1000;
    state.activeJobs = state.activeJobs.filter(
      (j) => j.status === 'downloading' || new Date(j.requestedAt).getTime() > cutoff
    );

    // Trim conversation history older than 24h
    if (state.conversationHistory) {
      for (const phone of Object.keys(state.conversationHistory)) {
        state.conversationHistory[phone] = state.conversationHistory[phone].filter(
          (m) => new Date(m.timestamp).getTime() > cutoff
        );
        if (state.conversationHistory[phone].length === 0) {
          delete state.conversationHistory[phone];
        }
      }
    }

    saveState(state);
  } catch (error) {
    console.error(`[scheduler] Error saving state:`, error);
  }
}

async function checkJob(job: DownloadJob, state: AppState): Promise<void> {
  job.checkCount++;
  console.log(`[scheduler] Checking ${job.type} "${job.title}" (check #${job.checkCount})`);

  // Proactive status updates are backend-agnostic and TEMPLATED: read the arr state directly and
  // decide/word the update in code (the Ollama native-tool loop has no DONE/SKIP contract, so the
  // scheduler never asks the model). See local-status.ts.
  // Re-trigger a silently-failed search only on the first check, not every tick.
  const allowResearch = job.checkCount <= 1;
  const result = await localStatusCheck(job, allowResearch);
  if (result.message) {
    console.log(`[scheduler] sending ${result.action} update for "${job.title}": "${result.message}"`);
    await sendMessage(job.requestedBy, result.message);
  } else {
    console.log(`[scheduler] ${result.action} for "${job.title}" — nothing to report`);
  }
  if (result.done) {
    job.status = 'complete';
    console.log(`[scheduler] Job "${job.title}" marked complete — status reports ready`);
  } else {
    const elapsed = Date.now() - new Date(job.requestedAt).getTime();
    // While STUCK AT IMPORT, shouldExpireJob keeps the job alive (up to a 72h hard cap) so Jedd
    // doesn't go dark — it was told once and will report DONE when the file finally imports.
    if (shouldExpireJob(elapsed, job.checkCount, result.importStuck)) {
      job.status = 'complete';
      const why = result.importStuck ? 'still stuck at import after 72h hard cap' : `timeout after ${job.checkCount} checks`;
      console.log(`[scheduler] Job "${job.title}" marked complete — ${why}`);
    } else {
      const nextDelay = getNextDelay(elapsed);
      job.nextCheckAt = new Date(Date.now() + nextDelay).toISOString();
      console.log(`[scheduler] Next check for "${job.title}" in ${nextDelay / 60000}min${result.importStuck ? ' (stuck at import — keeping watch)' : ''}`);
    }
  }
  saveState(state);
}

// Decide whether a local-backend job should stop being checked. Normal jobs expire after 24h OR
// 15 checks. A job STUCK AT IMPORT is exempt from the normal expiry (so Jedd keeps watching until
// the import is fixed and the file lands) but still hits a hard 72h cap so a genuinely dead job
// eventually stops. Pure + unit-tested.
export function shouldExpireJob(elapsedMs: number, checkCount: number, importStuck: boolean): boolean {
  const hardExpiry = elapsedMs > 72 * 60 * 60 * 1000;
  if (hardExpiry) return true;
  if (importStuck) return false; // keep watching while downloaded-but-not-imported
  return elapsedMs > 24 * 60 * 60 * 1000 || checkCount >= 15;
}

function getNextDelay(elapsedMs: number): number {
  const mins = elapsedMs / 60000;
  if (mins < 60) return 30 * 60 * 1000;      // First hour: every 30 min
  if (mins < 180) return 60 * 60 * 1000;     // 1-3 hours: every hour
  return 2 * 60 * 60 * 1000;                  // 3+ hours: every 2 hours
}
