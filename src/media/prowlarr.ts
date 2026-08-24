/**
 * Prowlarr — finding a release to grab.
 *
 * ── 🔴 WHAT COMES OUT OF HERE IS AN infoHash, NEVER A URL ────────────────────
 *
 * qBittorrent lives inside `gluetun-torrents`' network namespace and **cannot
 * reach Prowlarr**. Handing it a Prowlarr proxy/download URL fails *silently* —
 * V1 saw `pending_count: 1` and a torrent that never materialised. So a release
 * is only usable if it carries an `infoHash`, and the grab builds its own magnet.
 *
 * A release without one is therefore not a candidate at all, and saying so is
 * more useful than offering something that cannot be fetched.
 *
 * ── ⚠️ PROWLARR IS SLOW AND HAMMERING IT MAKES THINGS WORSE ──────────────────
 *
 * Searches take 35–45 s on a cold cache, and repeated searches trip per-indexer
 * failure-backoff, which **temporarily disables indexers** — so a retry loop
 * degrades the thing it is retrying against. One search, a long timeout, and an
 * honest UNKNOWN on failure.
 */

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface ProwlarrOptions {
  /** Base URL including the path prefix, e.g. `http://192.168.1.7:9696/prowlarr/api/v1`. */
  baseUrl: string;
  apiKey: string;
  fetchImpl?: FetchImpl;
  /** Generous on purpose: a cold search legitimately takes 35–45 s. */
  timeoutMs?: number;
}

/** Prowlarr newznab category ids. */
export const CATEGORY = { ebook: 7020, audiobook: 3030 } as const;

export interface Release {
  title: string;
  /** 40 hex characters. The ONLY thing that makes a release grabbable. */
  infoHash: string;
  seeders: number;
  sizeBytes: number;
  indexer: string;
}

export type SearchResult =
  | { state: 'results'; releases: Release[]; discarded: number }
  | { state: 'none'; detail: string }
  | { state: 'unknown'; detail: string };

/**
 * 🔴 An infoHash is interpolated into a shell command on the PRIVILEGED ssh
 * identity, so it is validated before it can get there.
 *
 * This is the same discipline as `isValidContainerName`, and for the same
 * reason: that validation is the entire defence on that identity. Nothing that
 * is not exactly 40 hex characters ever reaches a command line.
 */
export function isValidInfoHash(v: unknown): v is string {
  return typeof v === 'string' && /^[a-fA-F0-9]{40}$/.test(v);
}

/** Build the magnet ourselves. qBittorrent cannot fetch a Prowlarr URL. */
export function magnetFor(infoHash: string, title: string): string {
  if (!isValidInfoHash(infoHash)) throw new Error(`refusing to build a magnet from "${infoHash}"`);
  return `magnet:?xt=urn:btih:${infoHash.toLowerCase()}&dn=${encodeURIComponent(title)}`;
}

export class ProwlarrClient {
  private readonly fetchImpl: FetchImpl;

  private readonly timeoutMs: number;

  constructor(private readonly opts: ProwlarrOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  /**
   * One search. No retry loop — see the backoff note above.
   *
   * Releases without a usable `infoHash` are discarded and COUNTED, so "nothing
   * found" and "found things we cannot fetch" stay distinguishable.
   */
  async search(term: string, category: number): Promise<SearchResult> {
    const url =
      `${this.opts.baseUrl}/search?query=${encodeURIComponent(term)}` +
      `&categories=${category}&type=search`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { 'X-Api-Key': this.opts.apiKey },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      return {
        state: 'unknown',
        detail:
          `Could not search Prowlarr (${(e as Error).message}). That is a failure to look, NOT a ` +
          'finding that nothing exists — say so rather than reporting no results.',
      };
    }
    if (!res.ok) {
      return { state: 'unknown', detail: `Prowlarr returned http ${res.status}. UNKNOWN, not "none".` };
    }
    let rows: unknown;
    try {
      rows = await res.json();
    } catch {
      return { state: 'unknown', detail: 'Prowlarr returned a body that is not JSON. UNKNOWN.' };
    }
    if (!Array.isArray(rows)) return { state: 'unknown', detail: 'Prowlarr returned an unexpected shape.' };

    let discarded = 0;
    const releases: Release[] = [];
    for (const r of rows as Record<string, unknown>[]) {
      const infoHash = r['infoHash'];
      if (!isValidInfoHash(infoHash)) {
        // Not grabbable: qBittorrent cannot fetch it, so offering it would be a
        // choice the user cannot actually have.
        discarded += 1;
        continue;
      }
      releases.push({
        title: String(r['title'] ?? ''),
        infoHash,
        seeders: Number(r['seeders'] ?? 0),
        sizeBytes: Number(r['size'] ?? 0),
        indexer: String(r['indexer'] ?? '?'),
      });
    }
    if (releases.length === 0) {
      return {
        state: 'none',
        detail: discarded
          ? `Prowlarr returned ${discarded} result(s), but none carried an infoHash, so none can be fetched.`
          : 'Prowlarr found nothing for that search.',
      };
    }
    return { state: 'results', releases, discarded };
  }
}

/**
 * Rank releases. Code-owned and deterministic.
 *
 * ⚠️ Ordering is a fixed rule, not a judgement — it is about seeders and file
 * size, which the model cannot see better than a comparator can. The MODEL still
 * chooses which release the person wanted; this only decides what order to
 * present them in.
 */
export function rankReleases(releases: Release[]): Release[] {
  return [...releases].sort((a, b) => {
    // Alive before dead: a zero-seeder release will never complete.
    const aAlive = a.seeders > 0 ? 1 : 0;
    const bAlive = b.seeders > 0 ? 1 : 0;
    if (aAlive !== bAlive) return bAlive - aAlive;
    return b.seeders - a.seeders;
  });
}
