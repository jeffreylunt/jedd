import type { FetchImpl } from './arr.js';

/**
 * The Movie Database — "what is popular right now".
 *
 * ── WHY THIS IS NOT AN ARR ───────────────────────────────────────────────────
 *
 * Sonarr and Radarr answer *"do you have X"* and *"can you get X"*. Both take a
 * title and hand back matches. Neither can BROWSE: there is no arr endpoint for
 * *"what is everyone watching this week"*, which is the whole reason this file
 * exists.
 *
 * ── 🔴 TWO STATES, AND `unknown` IS NEVER "NOTHING IS POPULAR" ───────────────
 *
 * The same rule as `LibraryAnswer` and `CatalogueAnswer`, for the same reason. A
 * TMDB that cannot be reached must produce *"I could not check"*. Answering
 * *"nothing is trending"* would be a false negative wearing a real answer's
 * clothes, and it is the single defect this codebase is most built against.
 *
 * That includes the SHAPE of a 200. If TMDB answers with JSON that has no
 * `results` array, `results?.length ?? 0` would read as zero and the caller
 * would say nothing is popular. A body we cannot parse is `unknown`, not empty.
 */

/**
 * Which list to ask for. One value, one endpoint — no branching, no fan-out.
 *
 * The model picks. Deciding film-vs-show-vs-both from the person's phrasing is
 * exactly the kind of judgement it is good at and code is bad at, and unlike the
 * catalogue case a wrong pick here costs one harmless re-ask: nothing is added,
 * nothing moves.
 */
export type PopularKind =
  | 'trending'
  | 'trending_movies'
  | 'trending_shows'
  | 'popular_movies'
  | 'popular_shows';

const ENDPOINTS: Record<PopularKind, { path: string; label: string; media: 'film' | 'show' | 'mixed' }> = {
  trending: { path: '/trending/all/week', label: 'trending this week (films and shows)', media: 'mixed' },
  trending_movies: { path: '/trending/movie/week', label: 'films trending this week', media: 'film' },
  trending_shows: { path: '/trending/tv/week', label: 'shows trending this week', media: 'show' },
  popular_movies: { path: '/movie/popular', label: 'popular films right now', media: 'film' },
  popular_shows: { path: '/tv/popular', label: 'popular shows right now', media: 'show' },
};

export const POPULAR_KINDS = Object.keys(ENDPOINTS) as PopularKind[];

export function popularLabel(kind: PopularKind): string {
  return ENDPOINTS[kind].label;
}

export interface PopularItem {
  /** 1-based position in TMDB's own ordering. We do not re-rank. */
  rank: number;
  title: string;
  year: number | null;
  media: 'film' | 'show';
  /**
   * 🔴 A TMDB id. For a FILM this is the same id space Radarr uses, so it can go
   * straight to `add_movie`. For a SHOW it is **not** a tvdbId and must never be
   * handed to `add_series` — see `src/tools/trending.ts`.
   */
  tmdbId: number;
  rating: number | null;
}

export type PopularAnswer =
  | {
      state: 'results';
      kind: PopularKind;
      items: PopularItem[];
      /**
       * How many rows TMDB actually returned, before `normalise` dropped any.
       *
       * 🔴 THE CALLER NEEDS BOTH NUMBERS TO TELL TWO ZEROS APART. `items: []`
       * out of `considered: 0` is an empty list; `items: []` out of
       * `considered: 20` is a filter that rejected everything, which is a field
       * rename we have not noticed — not a finding about what is popular.
       */
      considered: number;
      /** Keys of the first row, so a rename is diagnosable from the message alone. */
      sampleKeys: string[];
    }
  | { state: 'unknown'; detail: string };

export interface TmdbOptions {
  /** The v4 read access token, sent as a bearer. Empty means TMDB is unconfigured. */
  readToken: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

const BASE_URL = 'https://api.themoviedb.org/3';

export class TmdbClient {
  private readonly fetchImpl: FetchImpl;

  private readonly timeoutMs: number;

  constructor(private readonly opts: TmdbOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async popular(kind: PopularKind, limit = 10): Promise<PopularAnswer> {
    const endpoint = ENDPOINTS[kind];
    if (!endpoint) return { state: 'unknown', detail: `no such list "${kind}"` };
    const url = `${BASE_URL}${endpoint.path}`;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${this.opts.readToken}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      return { state: 'unknown', detail: `could not reach ${url}: ${(e as Error).message}` };
    }

    // ⚠️ Two separate failures, reported separately. Folded into one `try`, a
    // connection dropped mid-body yields `raw = ''` and the message "the body is
    // not JSON", which blames TMDB's response shape for a transport fault and
    // sends whoever debugs it in the wrong direction.
    let raw: string;
    try {
      raw = await res.text();
    } catch (e) {
      return { state: 'unknown', detail: `the response from ${url} could not be read: ${(e as Error).message}` };
    }
    let body: unknown = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }

    if (!res.ok) {
      // 401 is the shape a wrong or expired token takes. Named, because "TMDB is
      // down" and "our credential is bad" lead to completely different actions.
      const why = res.status === 401 ? ' (the TMDB token was rejected)' : '';
      return { state: 'unknown', detail: `http ${res.status} from ${url}${why}` };
    }
    if (body === null) {
      return {
        state: 'unknown',
        detail: `${url} returned ${res.status} but the body is not JSON (starts "${raw.slice(0, 40)}")`,
      };
    }

    const results = (body as { results?: unknown }).results;
    if (!Array.isArray(results)) {
      // 🔴 NOT an empty list. A 200 whose shape we do not recognise is a gap in
      // what we know, and `[]` here would render as "nothing is popular".
      return {
        state: 'unknown',
        detail: `${url} returned ${res.status} with no results array (keys: ${Object.keys(
          body as object,
        ).join(', ')})`,
      };
    }

    const rows = results as Record<string, unknown>[];
    const items: PopularItem[] = [];
    for (const r of rows) {
      const item = normalise(r, endpoint.media, items.length + 1);
      if (item) items.push(item);
      if (items.length >= limit) break;
    }
    return {
      state: 'results',
      kind,
      items,
      considered: rows.length,
      sampleKeys: rows.length ? Object.keys(rows[0] ?? {}) : [],
    };
  }
}

/**
 * One TMDB row → one addable title, or nothing.
 *
 * ⚠️ `/trending/all` MIXES PEOPLE IN with films and shows — `media_type:
 * "person"` is a real and common row. A person is not something the library can
 * hold, so they are dropped here rather than offered as option 3 of a list the
 * next turn will try to add.
 */
function normalise(
  r: Record<string, unknown>,
  endpointMedia: 'film' | 'show' | 'mixed',
  rank: number,
): PopularItem | null {
  let media: 'film' | 'show';
  if (endpointMedia === 'mixed') {
    const t = r['media_type'];
    if (t === 'movie') media = 'film';
    else if (t === 'tv') media = 'show';
    else return null; // person, or something new we do not understand
  } else {
    media = endpointMedia;
  }

  const tmdbId = Number(r['id']);
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) return null;

  // Films carry `title`, shows carry `name`. Same for the date fields.
  // ⚠️ `||`, not `??`: `??` does not fire on an EMPTY STRING, so a row with
  // `title: ""` would resolve to `''` instead of falling through to `name`. The
  // same trap has its own 🔴 test in chokepoint.test.ts, for HP_SHELL_SSH_HOST.
  const title = String(r['title'] || r['name'] || '').trim();
  if (!title) return null;

  const date = String(r['release_date'] || r['first_air_date'] || '');
  const year = /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null;

  const voted = Number(r['vote_average']);
  const rating = Number.isFinite(voted) && voted > 0 ? Math.round(voted * 10) / 10 : null;

  return { rank, title, year, media, tmdbId, rating };
}
