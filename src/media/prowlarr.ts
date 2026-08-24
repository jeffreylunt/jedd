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
  /**
   * 🔴 THE BARE ROOT, e.g. `http://192.168.1.7:9696` — no path prefix.
   *
   * Unlike Sonarr/Radarr, Prowlarr has none. `/api/v1` is appended HERE rather
   * than being baked into the base, so the two halves of that fact live in one
   * place: I changed the config default once without changing this line, and the
   * result was a URL missing `/api/v1` that failed as UNKNOWN.
   */
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
  /**
   * The release's OWN magnet URI when it has one.
   *
   * ⚠️ Prefer it over a synthesized magnet: it carries the indexer's TRACKERS,
   * and a bare `xt=urn:btih:` relies on DHT alone, which is markedly slower to
   * find peers. Measured on real Prowlarr output — the `guid` field is itself a
   * full magnet for these indexers.
   */
  magnetUri?: string;
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
      `${this.opts.baseUrl}/api/v1/search?query=${encodeURIComponent(term)}` +
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
      const guid = typeof r['guid'] === 'string' ? r['guid'] : '';
      releases.push({
        title: String(r['title'] ?? ''),
        infoHash,
        ...(guid.startsWith('magnet:') ? { magnetUri: guid } : {}),
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

/**
 * Rank AUDIOBOOK releases.
 *
 * ── 🔴 THE PREFERENCE IS A PARAMETER. THE CLASSIFICATION IS NOT. ─────────────
 *
 * These are different things and V1 conflated them:
 *
 * - **Classifying a RELEASE** as GraphicAudio or abridged reads the indexer's
 *   own title. That is data, structured by convention, and matching it is the
 *   same kind of act as reading a file extension.
 * - **Deciding what the PERSON WANTS** must never be mined from conversation.
 *   V1 ran `/graphic\s*audio/i` over the WHOLE session **including Jedd's own
 *   prior turns**, so *"no, NOT the graphic audio version"* turned the
 *   preference ON by negation-blindness, and Jedd's own listing text then
 *   **re-asserted it for the rest of the window** — a detector reading its own
 *   output and latching.
 *
 * So `wantGraphicAudio` arrives here as a boolean the MODEL set from what the
 * person actually said. Nothing in this file reads a conversation.
 */
export interface AudiobookPrefs {
  /** Set by the model from the person's own words. Never inferred here. */
  wantGraphicAudio: boolean;
}

const GRAPHIC_AUDIO = /graphic\s*audio/i;
const ABRIDGED = /\babridged\b/i;
const UNABRIDGED = /\bunabridged\b/i;

export function classifyAudiobook(title: string): {
  graphicAudio: boolean;
  abridged: boolean;
} {
  // ⚠️ "unabridged" contains "abridged". Check the negation FIRST, or every
  // unabridged release is classified as abridged — the \bn't\b trap in a new
  // costume, and this one is a substring rather than a contraction.
  const unabridged = UNABRIDGED.test(title);
  return {
    graphicAudio: GRAPHIC_AUDIO.test(title),
    abridged: !unabridged && ABRIDGED.test(title),
  };
}

export function rankAudiobooks(releases: Release[], prefs: AudiobookPrefs): Release[] {
  const score = (r: Release): number[] => {
    const c = classifyAudiobook(r.title);
    return [
      r.seeders > 0 ? 1 : 0, // alive before dead: a 0-seeder release never completes
      c.graphicAudio === prefs.wantGraphicAudio ? 1 : 0, // matches what they asked for
      c.abridged ? 0 : 1, // unabridged unless they said otherwise
      r.seeders, // tiebreak
    ];
  };
  return [...releases].sort((a, b) => {
    const x = score(a);
    const y = score(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i]! - x[i]!;
    return 0;
  });
}
