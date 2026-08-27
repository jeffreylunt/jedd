/**
 * qBittorrent's view of a torrent — the GROUND TRUTH the arrs do not have.
 *
 * ── 🔴 WHY THIS EXISTS: THE ARR'S STATUS IS NOT EVIDENCE ────────────────────
 *
 * From the live `stalled-download-fix` spec, measured 2026-08-05:
 *
 *   > 10 of 18 genuinely stalled Sonarr items had NEITHER a `warning`
 *   > trackedDownloadStatus NOR a 'stalled' errorMessage. **Sonarr's status sat
 *   > at 'queued' the whole time while qBittorrent showed them at 0 seeds /
 *   > 0 dlspeed for 24h.** SONARR'S STATUS FIELD IS NOT GROUND TRUTH —
 *   > qBITTORRENT IS.
 *
 * So `classify()` in `queue.ts`, which decides from the arr record alone, is
 * blind to more than half of the real stalls. This module supplies the missing
 * half, and `classify` takes it as an optional argument so the read path
 * (`check_status`) gains the same correction for free.
 *
 * ── 🔴 THE STATE NAMES ARE A CLOSED LIST, NEVER AN INVERTED FILTER ──────────
 *
 * The spec is explicit, and it is explicit because inverting cost a false alarm:
 *
 *   > NAME THE UP STATES EXPLICITLY — do NOT write the filter as "state NOT IN
 *   > the download-side states." qBit also has `missingFiles`, which is neither
 *   > an UP state nor a DL state, so an inverted filter counts it and
 *   > FALSE-ALARMS.
 *
 * Every set below is therefore written out. If qBit gains a state we do not
 * know, it lands in `unknown` and is reported as unknown — which is the
 * fail-closed direction and the reason there is no `else` branch anywhere here.
 */

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * 🔴 STATES THAT THE SUSTAIN TEST MAY BE APPLIED TO.
 *
 * ⚠️ `queuedDL` IS DELIBERATELY ABSENT, and this is the trap that is live in the
 * queue right now. Measured 2026-08-23: 19 of 26 rows were `queuedDL` at
 * `time_active=0` — held by qBit's own queueing, never started, four of them
 * with live swarms sitting in `num_complete`. Their 0 seeds / 0 dlspeed is **the
 * absence of any observation, not a dead swarm**, and a literal reading
 * blocklist-deletes all 19.
 *
 * ⚠️ AND `time_active` DOES NOT RESCUE IT. Two `queuedDL` rows are sitting at
 * ~47 h active today (Fringe S02E14, S02E23) — they look exactly like stalls on
 * every numeric field. The state is the discriminator, not the clock, so the
 * membership test is on this set and nothing else.
 */
const SUSTAIN_TESTABLE = new Set(['downloading', 'metaDL', 'stalledDL', 'forcedDL']);

/** Every download-side state, for reporting. Wider than `SUSTAIN_TESTABLE`. */
const DOWNLOAD_STATES = new Set(['stalledDL', 'downloading', 'metaDL', 'queuedDL', 'forcedDL', 'error']);

/**
 * 🔴 FINISHED. Blocklist-deleting one of these destroys a completed download AND
 * poisons the release so the arrs will not re-grab it.
 *
 * Measured 2026-08-15: 47 of 48 torrents sat in UP states and ZERO in any
 * download-side state — a run that pattern-matched the word "stalled" would have
 * targeted 15 completed files.
 */
const UP_STATES = new Set(['queuedUP', 'stalledUP', 'uploading', 'forcedUP', 'pausedUP']);

/**
 * 🔴 A DELIBERATE HOLD, AND USUALLY A HUMAN'S. NEVER A STALL.
 *
 * qBit 5.x renamed `pausedDL` to `stoppedDL` (measured 2026-08-25) — the old
 * name was carried in the spec until then, so a filter written against
 * `pausedDL` silently matches nothing on this box.
 *
 * Measured 2026-08-25: 15 Fringe torrents sat `stoppedDL` at progress 0 and the
 * queue read as 15 stalled downloads. **A human had bulk-stopped them by hand in
 * the WebUI.** Acting would have routed around somebody's decision and destroyed
 * a live 17-peer swarm. One such torrent is in the queue as I write this, still
 * showing 17 seeds in `num_complete`.
 */
const HELD_STATES = new Set(['stoppedDL', 'pausedDL']);

/**
 * How long a torrent in a sustain-testable state may move zero bytes before it
 * is a stall. The spec's figure.
 */
export const SUSTAIN_HOURS = 24;

export interface QbitTorrent {
  /** 40 hex characters. The join key to the arr queue's `downloadId`. */
  hash: string;
  name: string;
  state: string;
  /** 0..1 */
  progress: number;
  /** Seconds qBit has had it ACTIVE. `0` means it has never started. */
  timeActiveSeconds: number;
  /**
   * 🔴 PREFER THIS OVER `numSeeds`. `num_complete` is the swarm's seed count per
   * the tracker; `num_seeds` is seeds we are CONNECTED to — and an unstarted
   * torrent has connected to nothing by definition, so `num_seeds` reads 0 for a
   * perfectly healthy swarm.
   */
  numComplete: number;
  numSeeds: number;
  dlspeed: number;
  amountLeft: number;
  size: number;
  /**
   * qBit's queue position. 0 means "not queued" (already active).
   *
   * Read so a priority change can be asserted BEFORE and AFTER — see
   * `setTopPriority`, where the HTTP status is documented as meaningless.
   */
  priority: number;
}

/**
 * What qBit says about this torrent, decided from the STATE first.
 *
 * ⚠️ Order matters and is not stylistic: held before finished before
 * not-started before the sustain test. Each earlier class contains torrents
 * whose numbers look identical to a stall.
 */
export type QbitVerdict =
  /** Explicitly stopped. Somebody's decision. Report it; do not act on it. */
  | { kind: 'held' }
  /** An UP state — downloaded, now seeding. Not a download problem at all. */
  | { kind: 'finished' }
  /** qBit's queue is holding it. Never started, so it has observed nothing. */
  | { kind: 'not-started' }
  /** Bytes are moving. */
  | { kind: 'progressing' }
  /** In an active state long enough with nothing moving. THE actionable class. */
  | { kind: 'stalled'; hoursDead: number; swarmSeeds: number }
  /** Active but young — this is what a normal start looks like. */
  | { kind: 'starting' }
  /** `missingFiles` and anything else. Not ours to touch. */
  | { kind: 'unmanaged'; state: string };

export function qbitVerdict(t: QbitTorrent): QbitVerdict {
  // 1. A hold outranks every numeric signal. See HELD_STATES.
  if (HELD_STATES.has(t.state)) return { kind: 'held' };
  // 2. Finished. An UP state is never a download fault.
  if (UP_STATES.has(t.state)) return { kind: 'finished' };
  // 3. Not a download state at all — `missingFiles` lands here, by name.
  if (!DOWNLOAD_STATES.has(t.state)) return { kind: 'unmanaged', state: t.state };
  // 4. qBit's own queueing. Excluded from the sustain test whatever the clock says.
  if (!SUSTAIN_TESTABLE.has(t.state)) return { kind: 'not-started' };

  if (t.dlspeed > 0 || t.progress > 0) return { kind: 'progressing' };

  /**
   * 🔴 `time_active` IS CHECKED BEFORE ANY SEED COUNT. The spec's wording:
   * *"Check time_active BEFORE num_seeds"* — because a young or unstarted
   * torrent's zero is the absence of an observation, not a finding.
   */
  const hours = t.timeActiveSeconds / 3600;
  if (hours < SUSTAIN_HOURS) return { kind: 'starting' };
  return { kind: 'stalled', hoursDead: Math.floor(hours), swarmSeeds: t.numComplete };
}

export type Fetched<T> = { state: 'ok'; value: T } | { state: 'unknown'; detail: string };

/**
 * Read every torrent qBittorrent holds.
 *
 * ── 🔴 THE ADDRESS IS TRANSPORT-SPECIFIC AND THERE ARE TWO OF THEM ──────────
 *
 * `config.qbittorrent.baseUrl` is `172.20.0.1:8080`, the docker bridge gateway —
 * reachable from **hp**, which is why every existing qbit tool curls it over
 * ssh. It is NOT reachable from the Mac this process runs on. Measured today:
 *
 *   http://10.0.0.10:8080/api/v2/app/version  -> 200 in 7 ms
 *   http://172.20.0.1:8080/api/v2/app/version   -> 000 after 8 s
 *
 * `homelab-read.ts` refused to invent the second URL and said to raise it as a
 * decision rather than guess. So the two are named for their TRANSPORT — neither
 * is canonical, and they are not competing values for one thing.
 */
export async function fetchTorrents(lanUrl: string, fetchImpl?: FetchImpl): Promise<Fetched<QbitTorrent[]>> {
  const doFetch = fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const url = `${lanUrl.replace(/\/$/, '')}/api/v2/torrents/info`;
  let res: Response;
  try {
    res = await doFetch(url, { signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    return {
      state: 'unknown',
      detail:
        `Could not reach qBittorrent at ${url}: ${(e as Error).message}. That is a failure to LOOK, ` +
        'not a finding that nothing is stuck — and without it the arr queue alone cannot tell a ' +
        'stall from a healthy download.',
    };
  }
  if (res.status >= 400) {
    return { state: 'unknown', detail: `qBittorrent ${url} → HTTP ${res.status}.` };
  }
  let rows: unknown;
  try {
    rows = JSON.parse(await res.text());
  } catch {
    return { state: 'unknown', detail: `qBittorrent ${url} returned a body that is not JSON.` };
  }
  if (!Array.isArray(rows)) {
    return { state: 'unknown', detail: `qBittorrent ${url} returned an unexpected shape.` };
  }
  return {
    state: 'ok',
    value: (rows as Record<string, unknown>[]).map((r) => ({
      // qBit reports the hash lower-case; the arrs report `downloadId` UPPER.
      // Normalised here so the join cannot miss on case — see `byHash`.
      hash: String(r['hash'] ?? '').toLowerCase(),
      name: String(r['name'] ?? ''),
      state: String(r['state'] ?? ''),
      progress: Number(r['progress'] ?? 0),
      timeActiveSeconds: Number(r['time_active'] ?? 0),
      numComplete: Number(r['num_complete'] ?? 0),
      numSeeds: Number(r['num_seeds'] ?? 0),
      dlspeed: Number(r['dlspeed'] ?? 0),
      amountLeft: Number(r['amount_left'] ?? 0),
      size: Number(r['size'] ?? 0),
      priority: Number(r['priority'] ?? 0),
    })),
  };
}

/**
 * Move ONE torrent to the top of qBit's queue.
 *
 * ── 🔴 THE 200 MEANS NOTHING. ASSERT THE PRIORITY YOURSELF ──────────────────
 *
 * Measured 2026-08-23 and reproduced today: `topPrio` returns **HTTP 200 on a
 * batched call that changes nothing**. `--data-urlencode 'hashes=h1|h2|…'` came
 * back 200 with EVERY priority unchanged, while per-hash calls worked instantly.
 * It is not an auth problem.
 *
 * I reproduced the same shape by accident while probing whether the LAN accepts
 * writes at all: `POST topPrio` with a **hash that cannot exist** also returned
 * 200. So the status code answers "were my credentials refused?" and nothing
 * else whatsoever.
 *
 * Hence: ONE hash per call, and the CALLER compares the priority it read before
 * against the priority it reads after. This function deliberately does not
 * report success — it reports what happened and leaves the verdict to the
 * comparison, because there is no success signal here to report.
 *
 * ⚠️ Why this matters beyond tidiness: `dont_count_slow_torrents=False`, so dead
 * torrents hold active slots indefinitely and qBit promotes by ADD ORDER rather
 * than by health. That is how the client moved zero bytes for 24 h while looking
 * fully busy — and it is why clearing slots is a real remedy rather than a tidy-up.
 */
export async function setTopPriority(
  lanUrl: string,
  hash: string,
  fetchImpl?: FetchImpl,
): Promise<Fetched<{ status: number }>> {
  if (!/^[a-fA-F0-9]{40}$/.test(hash)) {
    return { state: 'unknown', detail: `"${hash}" is not a 40-character infohash; nothing was sent.` };
  }
  const doFetch = fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const url = `${lanUrl.replace(/\/$/, '')}/api/v2/torrents/topPrio`;
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      // ONE hash. Never a `|`-joined batch — see the note above.
      body: new URLSearchParams({ hashes: hash }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    return { state: 'ok', value: { status: res.status } };
  } catch (e) {
    return {
      state: 'unknown',
      detail: `Could not reach qBittorrent at ${url}: ${(e as Error).message}. The priority may or may not have changed.`,
    };
  }
}

/**
 * Index by hash for the join.
 *
 * 🔴 CASE IS THE WHOLE POINT. qBittorrent reports `hash` lower-case and the arrs
 * report `downloadId` UPPER-CASE. A join on the raw strings matches NOTHING, and
 * the failure is silent: every arr item simply appears to have no qBit record,
 * which renders as "I could not see qBit" rather than as a bug.
 */
export function byHash(torrents: QbitTorrent[]): Map<string, QbitTorrent> {
  return new Map(torrents.map((t) => [t.hash.toLowerCase(), t]));
}
