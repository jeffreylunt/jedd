/**
 * "What is downloading right now?"
 *
 * ── 🔴 ONE SOURCE OF TRUTH, AND IT IS THE ARR QUEUE ──────────────────────────
 *
 * V1 gave two different answers to the same question depending on how it was
 * phrased. A query naming a title hit the real Sonarr queue; a subject-less
 * *"what is downloading right now?"* was answered from Jedd's own in-memory job
 * store, which can only see downloads Jedd itself started. It reported an EMPTY
 * QUEUE while Sonarr had 26 active downloads.
 *
 * The defect is not the stale cache. The defect is **two sources of truth for
 * one fact**, and the cure is not "invalidate the cache better" — it is that the
 * second source does not exist. There is no local job store in V2 and one must
 * not be added, not even as an optimisation. The arr queue is a single HTTP call
 * that answers in well under a second; there is nothing here worth caching and
 * everything to lose.
 *
 * The phrasing split is closed structurally too: `snapshot()` is the only way to
 * obtain queue state, and a named title is applied by FILTERING what it
 * returned. There is no title-specific fetch path that could drift from the
 * general one, so the two questions cannot disagree — see `matching()` below.
 */

export type QueueService = 'sonarr' | 'radarr';

/**
 * 🔴 A RELEASE, NOT A ROW. The per-row array never escapes this module.
 *
 * A season pack expands into N per-episode rows in the arr queue, all sharing
 * one `downloadId` because they are one torrent. V1 counted rows and tripped a
 * depth threshold on the wrong unit — it woke Jeff at 3:32am over "nine stuck
 * downloads" that were one grab of nine episodes, none of them stuck.
 *
 * Grouping is done at PARSE time rather than at report time, so nothing
 * downstream is in a position to count episodes even by accident. `rows` is kept
 * only to say "9 episodes" in prose; it is never a threshold input.
 */
export interface Release {
  /** The download client's id for the torrent. One release, one id. */
  releaseId: string;
  /** The release/torrent name, e.g. `Fringe.S02E18.720p.HDTV.X264-DIMENSION`. */
  releaseTitle: string;
  /** The SERIES or MOVIE title — what a person would have asked for. */
  subject: string;
  service: QueueService;
  /** How many arr rows this one release expands into. Prose only, never a threshold. */
  rows: number;
  /**
   * 🔴 THE ARR QUEUE ROW IDS — every one of them, because a removal needs them ALL.
   *
   * A season pack is ONE torrent expanded into N arr rows sharing a
   * `downloadId`. `DELETE /queue/{id}` takes a ROW id, not a release id, so
   * deleting a single row of a nine-episode pack removes the torrent from the
   * client and leaves EIGHT arr rows pointing at a download that no longer
   * exists. Keeping every id is what makes a removal complete.
   *
   * ⚠️ This is a list for the same reason `rows` exists and is not a threshold:
   * the release is the unit, and the rows are an implementation detail of the
   * arr's own bookkeeping.
   */
  rowIds: number[];
  /** Total bytes. **0 means the torrent metadata has not resolved** — not "empty". */
  size: number;
  /** Bytes remaining. `sizeleft === size` means nothing has EVER moved. */
  sizeleft: number;
  /** The download client's own word: queued | paused | downloading | completed | warning | ... */
  status: string;
  /** ok | warning | error — the arr's view of the IMPORT, not of the download. */
  trackedStatus: string;
  /** downloading | importPending | importing | imported | failedPending — the IMPORT lifecycle. */
  trackedState: string;
  /** When the arr first saw it. The age gate's input. */
  addedAt: string;
  /** Import warnings the arr attached, deduplicated across the grouped rows. */
  messages: string[];
}

/**
 * 🔴 `status` AND `trackedDownloadState` ANSWER DIFFERENT QUESTIONS. NEITHER
 *    ANSWERS "IS IT PROGRESSING".
 *
 * The harvested rule from six months of V1 sweeps was *"trust
 * `trackedDownloadStatus`/`trackedDownloadState` over the bare `status` — the
 * compact list lies."* That rule is real and it has an inverted twin, which was
 * live on this homelab while this file was being written:
 *
 *   15 Sonarr queue rows, every one of them
 *     status: "paused",  trackedDownloadStatus: "ok",  trackedDownloadState: "downloading"
 *   and in qBittorrent, all 15 `stoppedDL`, 0%, 0 seeds, for two days.
 *
 * Following the harvested rule literally produces **"15 episodes of Fringe are
 * downloading, all healthy"** — confidently, about fifteen torrents that had
 * moved zero bytes since Saturday.
 *
 * They are not contradicting each other. They are on different axes:
 *   `status`       → what the DOWNLOAD CLIENT is doing with the torrent.
 *   `trackedState` → where the arr's IMPORT PIPELINE thinks the item is.
 * A stopped torrent is legitimately "still in the downloading stage of import".
 *
 * So progress is read from the only fields that measure it — `size`, `sizeleft`
 * and `addedAt` — and the two state words are reported, never trusted.
 */
export type Verdict =
  /** Bytes have moved. The only positive progress evidence a single reading can carry. */
  | { kind: 'progressing'; percent: number }
  /** Downloaded; the arr is moving it into the library. A different pipeline entirely. */
  | { kind: 'importing' }
  /** Downloaded, but the import is refusing. The download is NOT the problem. */
  | { kind: 'import-blocked' }
  /** Explicitly stopped in the download client. Not a stall — somebody or something stopped it. */
  | { kind: 'stopped' }
  /** No bytes yet, but young enough that this is what a normal start looks like. */
  | { kind: 'starting' }
  /** Old, and not one byte has ever arrived. */
  | { kind: 'stalled' }
  /** Old, and not even the torrent METADATA arrived — it has found no peers at all. */
  | { kind: 'no-peers' };

/**
 * 🔴 THE REMEDY IS A FIELD OF THE VERDICT, DECIDED WHERE THE CLASS IS DECIDED.
 *
 * V1 woke Jeff at 3:32am about nine metadata-lagged episodes and then offered a
 * remedy that could not possibly have fixed them. That is not a wording bug: it
 * happens whenever choosing the failure class and choosing the response are two
 * separate steps, because the second step can be pointed at the wrong output of
 * the first.
 *
 * Here there is no second step. `classify()` returns the class and its response
 * together, so a remedy cannot be attached to a class it does not resolve.
 *
 * And `jeddCanFix` is **`false` for every class**, on purpose. `check_status` is
 * read-only; naming the action a person would take is not the same as taking it,
 * and the honest answer for a torrent with no peers is that no action available
 * anywhere in Jedd will make peers appear.
 */
export interface Response {
  jeddCanFix: false;
  /** What would actually resolve THIS class. Rendered always — never omitted. */
  wouldResolve: string;
}

export interface Assessment {
  release: Release;
  verdict: Verdict;
  response: Response;
  ageHours: number;
}

/**
 * How long a release may sit at zero bytes before it is called stalled.
 *
 * Sized generously on purpose. The cost of being late is that Jeff hears about a
 * dead grab a few hours after it died; the cost of being early is a 3:32am alert
 * about a download that was about to start, which is the exact V1 failure this
 * gate exists to prevent. A healthy torrent resolves metadata in seconds and
 * moves its first bytes in minutes, so nothing legitimate is anywhere near six
 * hours.
 */
export const STALL_AGE_HOURS = 6;

/** Parse an arr `/queue` body into RELEASES. Rows are grouped here and nowhere else. */
export function parseQueue(body: unknown, service: QueueService): Release[] {
  const records = Array.isArray((body as { records?: unknown })?.records)
    ? ((body as { records: unknown[] }).records as Record<string, unknown>[])
    : [];
  const byRelease = new Map<string, Record<string, unknown>[]>();
  for (const r of records) {
    // A row with no downloadId is its own release — falling back to the arr's
    // own row id keeps it visible rather than collapsing every such row into one
    // phantom "release" under the empty-string key.
    const key = typeof r['downloadId'] === 'string' && r['downloadId'] ? r['downloadId'] : `row:${r['id']}`;
    const existing = byRelease.get(key);
    if (existing) existing.push(r);
    else byRelease.set(key, [r]);
  }

  const out: Release[] = [];
  for (const [releaseId, rows] of byRelease) {
    const first = rows[0]!;
    const subjectField = service === 'sonarr' ? 'series' : 'movie';
    const subjectRow = first[subjectField] as Record<string, unknown> | undefined;
    const messages = new Set<string>();
    for (const r of rows) {
      const sm = Array.isArray(r['statusMessages']) ? (r['statusMessages'] as Record<string, unknown>[]) : [];
      for (const m of sm) {
        if (typeof m['title'] === 'string' && m['title']) messages.add(m['title']);
        for (const d of Array.isArray(m['messages']) ? (m['messages'] as unknown[]) : []) {
          if (typeof d === 'string' && d) messages.add(d);
        }
      }
      if (typeof r['errorMessage'] === 'string' && r['errorMessage']) messages.add(r['errorMessage']);
    }
    out.push({
      releaseId,
      releaseTitle: String(first['title'] ?? '(untitled release)'),
      // Falls back to the release name so a title question can still match
      // something when includeSeries/includeMovie did not resolve a subject.
      subject: String(subjectRow?.['title'] ?? first['title'] ?? '(unknown)'),
      service,
      rows: rows.length,
      rowIds: rows.map((r) => Number(r['id'])).filter((n) => Number.isInteger(n)),
      size: numberOr(first['size'], 0),
      sizeleft: numberOr(first['sizeleft'], 0),
      status: String(first['status'] ?? 'unknown'),
      trackedStatus: String(first['trackedDownloadStatus'] ?? 'unknown'),
      trackedState: String(first['trackedDownloadState'] ?? 'unknown'),
      addedAt: String(first['added'] ?? ''),
      messages: [...messages],
    });
  }
  return out;
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Hours since the arr first saw this release. `NaN`-safe: an unparseable date reads as age 0. */
export function ageHours(release: Release, now: Date): number {
  const t = Date.parse(release.addedAt);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (now.getTime() - t) / 3_600_000);
}

/**
 * Classify one release, and decide with it what would resolve that class.
 *
 * Order matters and is not alphabetical:
 *  1. The IMPORT stages come first, because a downloaded item's problem is never
 *     the download, and every download-shaped remedy below is wrong for it.
 *  2. `stopped` outranks `stalled`, because a deliberately stopped torrent and a
 *     torrent nobody is seeding look identical in the byte fields and want
 *     opposite responses.
 *  3. Progress outranks the age gate, so a slow-but-moving download is never
 *     called stalled no matter how long it has been running.
 */
export function classify(release: Release, now: Date): Assessment {
  const age = ageHours(release, now);
  const moved = release.size > 0 && release.sizeleft < release.size;
  const percent = release.size > 0 ? Math.floor(((release.size - release.sizeleft) / release.size) * 100) : 0;

  // ── import stages ─────────────────────────────────────────────────────────
  if (release.trackedStatus === 'warning' || release.trackedStatus === 'error') {
    return {
      release,
      verdict: { kind: 'import-blocked' },
      response: {
        jeddCanFix: false,
        wouldResolve:
          'The file has downloaded — the IMPORT is what is stuck, so nothing about the download ' +
          'needs fixing. Someone has to look at the arr\'s queue message and either fix the path ' +
          'or import it manually.',
      },
      ageHours: age,
    };
  }
  if (release.trackedState === 'importPending' || release.trackedState === 'importing') {
    return {
      release,
      verdict: { kind: 'importing' },
      response: { jeddCanFix: false, wouldResolve: 'Nothing — it has downloaded and is being moved into the library.' },
      ageHours: age,
    };
  }

  // ── download stages ───────────────────────────────────────────────────────
  if (release.status === 'paused') {
    return {
      release,
      verdict: { kind: 'stopped' },
      response: {
        jeddCanFix: false,
        wouldResolve:
          'It was STOPPED in the download client, so it is not going to restart on its own and ' +
          'nothing is wrong with the release. Someone has to start it again in qBittorrent — and ' +
          'somebody may have stopped it deliberately, so ask before restarting it.',
      },
      ageHours: age,
    };
  }
  if (moved) {
    return {
      release,
      verdict: { kind: 'progressing', percent },
      response: { jeddCanFix: false, wouldResolve: 'Nothing — it is downloading.' },
      ageHours: age,
    };
  }
  if (age < STALL_AGE_HOURS) {
    return {
      release,
      verdict: { kind: 'starting' },
      response: { jeddCanFix: false, wouldResolve: 'Nothing yet — this is what a normal start looks like. Give it time.' },
      ageHours: age,
    };
  }
  if (release.size === 0) {
    return {
      release,
      verdict: { kind: 'no-peers' },
      response: {
        jeddCanFix: false,
        wouldResolve:
          'Not even the torrent metadata has arrived, which means it has found NO PEERS at all. ' +
          'Retrying the same release cannot fix that — the only thing that helps is grabbing a ' +
          'DIFFERENT release.',
      },
      ageHours: age,
    };
  }
  return {
    release,
    verdict: { kind: 'stalled' },
    response: {
      jeddCanFix: false,
      wouldResolve:
        'It connected but has never received a byte. Usually that is a release with no live ' +
        'seeders; a different release is what fixes it.',
    },
    ageHours: age,
  };
}

/**
 * Does this release answer a question about `title`?
 *
 * 🔴 THIS IS WHY THE TWO PHRASINGS CANNOT DISAGREE. A named title does not
 * select a different endpoint, a different cache or a different code path — it
 * filters the ONE snapshot that the subject-less question also returns. The
 * general answer is the specific answer's superset by construction.
 */
export function matching(releases: Release[], title: string): Release[] {
  const needle = normalise(title);
  if (!needle) return releases;
  return releases.filter((r) => normalise(r.subject).includes(needle) || normalise(r.releaseTitle).includes(needle));
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
