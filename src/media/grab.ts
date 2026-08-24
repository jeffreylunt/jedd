import { runOnHp, type ExecImpl } from '../hp.js';
import { isValidInfoHash, magnetFor } from './prowlarr.js';

/**
 * Handing a torrent to qBittorrent.
 *
 * ── 🔴 WHY THIS GOES OVER SSH INSTEAD OF BEING AN HTTP CLIENT ────────────────
 *
 * Measured 2026-08-24: qBittorrent's API at `172.20.0.1:8080` answers **200 from
 * hp and 000 from the Mac**, where V2 runs. That address is the **docker bridge
 * gateway**, routable only on hp, because qBittorrent lives in
 * `gluetun-torrents`' network namespace. There is no route from here, and adding
 * one would mean putting a torrent client's API on the LAN.
 *
 * So the call is made ON hp, which is what the existing shed tools already do.
 *
 * ── 🔴 THE infoHash IS INTERPOLATED INTO A PRIVILEGED SHELL COMMAND ──────────
 *
 * `runOnHp` uses the ADMIN ssh identity. The convention is that a tool
 * interpolating **model-supplied** strings into a shell command belongs on the
 * unprivileged identity — this string is not model-supplied, but it is not ours
 * either: it comes from Prowlarr, which aggregates third-party indexers.
 *
 * So it is validated as exactly 40 hex characters **before** it can reach a
 * command line, the same discipline as `isValidContainerName`. That validation
 * is the entire defence on this identity, and `magnetFor` refuses rather than
 * trusting its caller.
 */

export type GrabOutcome =
  | { state: 'started'; detail: string }
  /** Already in the client. 🔴 SUCCESS — V1 read this as a failure and said "retry". */
  | { state: 'already-have'; detail: string }
  | { state: 'failed'; detail: string }
  /** The call did not complete. The grab MAY have landed. Never a "no". */
  | { state: 'unknown'; detail: string };

export interface GrabInput {
  adminSshHost: string;
  qbitBaseUrl: string;
  infoHash: string;
  /** The release's own magnet, when it has one. Carries the indexer's trackers. */
  magnetUri?: string;
  title: string;
  category: string;
  savePath?: string;
  exec?: ExecImpl;
}

/** Single-quote for the remote shell. The magnet is ours, but quote it anyway. */
function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/**
 * Make sure the category exists before using it.
 *
 * A fresh qBittorrent has no categories, and adding with an unknown one puts the
 * download in the wrong place — where the mover and the SMTP step will never
 * find it. It fails by producing a file nobody looks at, which is worse than
 * failing loudly.
 */
export async function ensureCategory(input: {
  adminSshHost: string;
  qbitBaseUrl: string;
  category: string;
  savePath?: string;
  exec?: ExecImpl;
}): Promise<void> {
  const body =
    `category=${encodeURIComponent(input.category)}` +
    (input.savePath ? `&savePath=${encodeURIComponent(input.savePath)}` : '');
  // createCategory is idempotent-ish: it errors if the category exists, which is
  // fine and deliberately ignored.
  await runOnHp(
    input.adminSshHost,
    `curl -s --max-time 10 -X POST ${shellQuote(`${input.qbitBaseUrl}/api/v2/torrents/createCategory`)} ` +
      `--data ${shellQuote(body)}`,
    20_000,
    input.exec,
  );
}

/**
 * Add a torrent and jump it to the front of the queue.
 *
 * Queue-jumping matters: an ebook is a few megabytes behind possibly hours of
 * video, and a person waiting on a book they asked for a minute ago is the case
 * this exists to serve.
 */
export async function grabTorrent(input: GrabInput): Promise<GrabOutcome> {
  if (!isValidInfoHash(input.infoHash)) {
    return {
      state: 'failed',
      detail: `Refusing to grab: "${input.infoHash}" is not a valid infoHash. Nothing was sent.`,
    };
  }
  /**
   * Prefer the release's OWN magnet — it carries the indexer's trackers, and a
   * synthesized `xt=urn:btih:` relies on DHT alone, which is much slower to find
   * peers. It is still validated: we only accept one whose infoHash matches the
   * one we validated, so a mismatched or hostile URI cannot ride along.
   */
  const supplied = input.magnetUri ?? '';
  const matchesHash = supplied.toLowerCase().includes(input.infoHash.toLowerCase());
  const magnet = supplied.startsWith('magnet:') && matchesHash
    ? supplied
    : magnetFor(input.infoHash, input.title);

  await ensureCategory({
    adminSshHost: input.adminSshHost,
    qbitBaseUrl: input.qbitBaseUrl,
    category: input.category,
    savePath: input.savePath,
    exec: input.exec,
  });

  /**
   * 🔴 A CATEGORY DOES NOT PLACE THE FILE. MEASURED THE HARD WAY.
   *
   * The `ebooks` category exists with `savePath: /downloads/ebooks`, and a
   * torrent added WITH that category still landed in `/external/Downloads` —
   * qBittorrent only applies a category's path when Automatic Torrent Management
   * is on, and otherwise uses the global default.
   *
   * The consequence is the quiet one: the download succeeds, the category looks
   * right in the UI, and **the file is somewhere the send step will never look.**
   * So `savepath` is sent EXPLICITLY and is not optional for a grab we intend to
   * read back.
   */
  const form =
    `urls=${encodeURIComponent(magnet)}` +
    `&category=${encodeURIComponent(input.category)}` +
    `&savepath=${encodeURIComponent(input.savePath ?? `/downloads/${input.category}`)}`;

  const add = await runOnHp(
    input.adminSshHost,
    `curl -s -w '\\n%{http_code}' --max-time 20 -X POST ` +
      `${shellQuote(`${input.qbitBaseUrl}/api/v2/torrents/add`)} --data ${shellQuote(form)}`,
    40_000,
    input.exec,
  );

  if (add.exitCode !== 0) {
    return {
      state: 'unknown',
      detail:
        `Could not reach qBittorrent to add "${input.title}" (exit ${add.exitCode}: ` +
        `${add.stderr.trim().slice(0, 120)}). The grab MAY have landed — check before retrying.`,
    };
  }

  const lines = add.stdout.trim().split('\n');
  const status = Number(lines[lines.length - 1]);
  const bodyText = lines.slice(0, -1).join('\n').trim();

  // 🔴 qBittorrent answers 409 for a torrent it already holds. That is SUCCESS.
  // V1's ebook path read this as a download FAILURE and told the user to retry,
  // which is the one action guaranteed never to work.
  if (status === 409 || /already in the download list/i.test(bodyText)) {
    return { state: 'already-have', detail: `"${input.title}" is already downloading or downloaded.` };
  }
  /**
   * 🔴 PARSE THE RESULT, NEVER SUBSTRING-MATCH THE BODY.
   *
   * Measured against the live API: a SUCCESSFUL add returns
   *   `{"added_torrent_ids":[...],"failure_count":0,"pending_count":0,"success_count":1}`
   * and my first version tested `/fail/i` on that body — which **matches
   * `"failure_count"`, a field whose value says there were ZERO failures.**
   *
   * So the torrent was really added and the user would have been told it failed:
   * a false negative on a WRITE, which then invites a retry of something that
   * already worked. Same shape as a `\bn't\b` guard that misses "isn't", and as
   * a filter on `mail` matching every `@gmail.com` — **the word appears inside
   * the thing that says the opposite.**
   *
   * Newer qBittorrent answers JSON with counts; older answers `Ok.` / `Fails.`.
   * Both are handled explicitly, and neither by looking for a word.
   */
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed['success_count'] === 'number') {
    const ok = Number(parsed['success_count']) > 0;
    const failed = Number(parsed['failure_count'] ?? 0) > 0;
    const pending = Number(parsed['pending_count'] ?? 0) > 0;
    if (!ok && !failed && pending) {
      // The documented silent failure: accepted but never materialises. V1 saw
      // exactly this when handed a Prowlarr URL qBittorrent could not fetch.
      return {
        state: 'failed',
        detail: `qBittorrent accepted "${input.title}" but left it PENDING and never started it.`,
      };
    }
    if (!ok) {
      return { state: 'failed', detail: `qBittorrent added nothing (${bodyText.slice(0, 120)}).` };
    }
  } else if (status !== 200 || /^Fails\.?$/i.test(bodyText.trim())) {
    return {
      state: 'failed',
      detail: `qBittorrent refused the add (http ${status}${bodyText ? `: ${bodyText.slice(0, 120)}` : ''}).`,
    };
  }

  // Best effort — a failure to prioritise is not a failure to grab, so it is
  // reported but never downgrades the outcome.
  const bumped = await runOnHp(
    input.adminSshHost,
    `curl -s --max-time 10 -X POST ${shellQuote(`${input.qbitBaseUrl}/api/v2/torrents/topPrio`)} ` +
      `--data ${shellQuote(`hashes=${input.infoHash.toLowerCase()}`)}`,
    20_000,
    input.exec,
  );

  return {
    state: 'started',
    detail:
      `"${input.title}" handed to qBittorrent in category ${input.category}` +
      (bumped.exitCode === 0 ? ' and moved to the front of the queue.' : ' (could not change its queue position).'),
  };
}

/**
 * Where a grab has got to.
 *
 * 🔴 Four states, and `missing` is NOT `unknown`. A torrent qBittorrent has
 * never heard of means the grab did not land — actionable, and different from
 * "I could not ask", which means try again later. V1's ebook path collapsed
 * these and told a user to retry something that had already succeeded.
 */
export type GrabStatus =
  | { state: 'complete'; contentPath: string; name: string }
  | { state: 'downloading'; progress: number; name: string; detail: string }
  | { state: 'missing'; detail: string }
  | { state: 'unknown'; detail: string };

/**
 * ⚠️ `content_path` is used VERBATIM.
 *
 * It is qBittorrent's own view of where the file is, and that view is inside its
 * container's mount namespace. Any consumer must resolve it against the SAME
 * mount, or it will look in a path that does not exist and report a missing file
 * for a download that completed. V1 mounted `/home/jeff/gluetun/downloads` as
 * `/downloads:ro` precisely so the two agreed.
 */
export async function grabStatus(input: {
  adminSshHost: string;
  qbitBaseUrl: string;
  infoHash: string;
  exec?: ExecImpl;
}): Promise<GrabStatus> {
  if (!isValidInfoHash(input.infoHash)) {
    return { state: 'unknown', detail: `"${input.infoHash}" is not a valid infoHash.` };
  }
  const out = await runOnHp(
    input.adminSshHost,
    `curl -s --max-time 10 ${shellQuote(
      `${input.qbitBaseUrl}/api/v2/torrents/info?hashes=${input.infoHash.toLowerCase()}`,
    )}`,
    20_000,
    input.exec,
  );
  if (out.exitCode !== 0) {
    return {
      state: 'unknown',
      detail: `Could not ask qBittorrent (exit ${out.exitCode}). Not a finding that it is absent.`,
    };
  }
  let rows: unknown;
  try {
    rows = JSON.parse(out.stdout.trim() || '[]');
  } catch {
    return { state: 'unknown', detail: 'qBittorrent returned something that is not JSON.' };
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      state: 'missing',
      detail:
        'qBittorrent has no torrent with that hash. The grab did not land — this is actionable, ' +
        'and different from being unable to check.',
    };
  }
  const t = rows[0] as Record<string, unknown>;
  const name = String(t['name'] ?? 'the download');
  const progress = Number(t['progress'] ?? 0);
  const contentPath = String(t['content_path'] ?? '');
  const state = String(t['state'] ?? '');
  // `progress` is 0..1. Trust it over the state string, which has many spellings
  // for finished (uploading, stalledUP, pausedUP, forcedUP...).
  if (progress >= 1 && contentPath) {
    return { state: 'complete', contentPath, name };
  }
  return {
    state: 'downloading',
    progress,
    name,
    detail: `"${name}" is ${Math.round(progress * 100)}% done (qBittorrent state: ${state}).`,
  };
}

/**
 * Translate qBittorrent's path into one that exists where V2 can read it.
 *
 * ── 🔴 MEASURED, NOT INFERRED (2026-08-24) ───────────────────────────────────
 *
 * qBittorrent reports, live:
 *   `/downloads/ebooks/Red Rising Trilogy by Pierce Brown EPUB`
 * and **`/downloads` does not exist on hp's filesystem.** It is a path inside
 * qBittorrent's own container.
 *
 * V1 never had to care: its container mounted the same host directory at
 * `/downloads`, so the two views agreed by construction — that is exactly what
 * its config comment means by *"mounting it anywhere else silently breaks every
 * send with 'file not found' while the download itself looks perfectly
 * healthy."*
 *
 * **V2 reaches the file over ssh and therefore sees the HOST filesystem, so the
 * agreement is gone and the translation has to be explicit.** Without it every
 * send fails as a missing file while the download is plainly complete — the same
 * defect V1 warned about, arriving through a different door.
 *
 * ⚠️ Prefix-aware on purpose: sonarr's torrents report `/external/Downloads/…`,
 * a different mount entirely, so a blanket string replace would corrupt them.
 */
export interface MountMap {
  /** What qBittorrent calls it, e.g. `/downloads`. */
  containerPrefix: string;
  /** What it is on hp, e.g. `/home/jeff/gluetun/downloads`. */
  hostPrefix: string;
}

export function toHostPath(contentPath: string, mounts: MountMap[]): string | null {
  if (!contentPath) return null;
  for (const m of mounts) {
    // Match on a path BOUNDARY so `/downloads` never matches `/downloads-old`.
    if (contentPath === m.containerPrefix || contentPath.startsWith(`${m.containerPrefix}/`)) {
      return m.hostPrefix + contentPath.slice(m.containerPrefix.length);
    }
  }
  // 🔴 Unmapped is NULL, not the original. Returning the container path would
  // hand the next step something that cannot exist on this filesystem, and the
  // failure would read as a missing download rather than a missing mapping.
  return null;
}
