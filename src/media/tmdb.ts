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

  /** One GET, three-state, sharing every failure rule `popular()` established. */
  private async get(path: string): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; detail: string }> {
    const url = `${BASE_URL}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${this.opts.readToken}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      return { ok: false, detail: `could not reach ${url}: ${(e as Error).message}` };
    }
    let raw: string;
    try {
      raw = await res.text();
    } catch (e) {
      return { ok: false, detail: `the response from ${url} could not be read: ${(e as Error).message}` };
    }
    let body: unknown = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    if (!res.ok) {
      const why = res.status === 401 ? ' (the TMDB token was rejected)' : '';
      // ⚠️ 404 is NOT "no such title" in a useful sense here: we only ask for ids
      // TMDB itself gave us, so a 404 means the id is wrong or the title was
      // removed. Either way it is a gap, reported as one.
      return { ok: false, detail: `http ${res.status} from ${url}${why}` };
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, detail: `${url} returned ${res.status} but the body is not an object (starts "${raw.slice(0, 40)}")` };
    }
    return { ok: true, body: body as Record<string, unknown> };
  }

  /**
   * Everything TMDB knows about one title, in one request.
   *
   * `append_to_response=credits` folds the cast in, so this is a single call
   * rather than a fan-out — the same "one value, one endpoint" shape as
   * `popular()`.
   */
  async details(ref: TitleRef): Promise<DetailsAnswer> {
    if (!Number.isFinite(ref.tmdbId) || ref.tmdbId <= 0) {
      return { state: 'unknown', detail: `"${ref.tmdbId}" is not a usable TMDB id.` };
    }
    const kind = ref.media === 'film' ? 'movie' : 'tv';
    const got = await this.get(`/${kind}/${ref.tmdbId}?append_to_response=credits`);
    if (!got.ok) return { state: 'unknown', detail: got.detail };

    const b = got.body;
    const title = String(b['title'] || b['name'] || '').trim();
    const id = Number(b['id']);
    /**
     * 🔴 A RESPONSE THAT PARSES TO NOTHING IS UNKNOWN, NOT "NO INFORMATION".
     *
     * The same two-zeros rule as `popular()`: TMDB answering 200 with a shape we
     * cannot read is a gap in what we know. Rendering it as an empty record
     * would say "there is nothing to tell you about this", which is a finding we
     * have not made.
     */
    if (!title || !Number.isFinite(id)) {
      return {
        state: 'unknown',
        detail:
          `TMDB answered for ${kind} ${ref.tmdbId} but the body carried no title or id ` +
          `(fields: ${Object.keys(b).slice(0, 12).join(', ')}), so its shape has changed.`,
      };
    }

    const credits = (b['credits'] ?? {}) as Record<string, unknown>;
    const castRows = Array.isArray(credits['cast']) ? (credits['cast'] as Record<string, unknown>[]) : [];
    const cast: CastMember[] = [];
    for (const c of castRows) {
      const name = String(c['name'] ?? '').trim();
      if (!name) continue;
      cast.push({ name, character: String(c['character'] ?? '').trim() });
      if (cast.length >= CAST_SHOWN) break;
    }

    const crew = Array.isArray(credits['crew']) ? (credits['crew'] as Record<string, unknown>[]) : [];
    const madeBy =
      ref.media === 'film'
        ? crew.filter((c) => c['job'] === 'Director').map((c) => String(c['name'] ?? '')).filter(Boolean)
        : names(b['created_by']);

    const date = String(b['release_date'] || b['first_air_date'] || '');
    const voted = Number(b['vote_average']);
    const runtime = Number(b['runtime']);
    const seasons = Number(b['number_of_seasons']);
    const episodes = Number(b['number_of_episodes']);

    return {
      state: 'details',
      details: {
        title,
        year: /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null,
        media: ref.media,
        tmdbId: id,
        rating: Number.isFinite(voted) && voted > 0 ? Math.round(voted * 10) / 10 : null,
        votes: Number(b['vote_count']) || 0,
        genres: names(b['genres']),
        status: String(b['status'] ?? '').trim() || null,
        tagline: String(b['tagline'] ?? '').trim() || null,
        // Passed through whole. See the field's own note: never an ellipsis.
        overview: String(b['overview'] ?? '').trim(),
        runtimeMinutes: ref.media === 'film' && Number.isFinite(runtime) && runtime > 0 ? runtime : null,
        seasons: ref.media === 'show' && Number.isFinite(seasons) ? seasons : null,
        episodes: ref.media === 'show' && Number.isFinite(episodes) ? episodes : null,
        networks: ref.media === 'show' ? names(b['networks']) : [],
        madeBy,
        cast,
        castTotal: castRows.length,
      },
    };
  }

  /**
   * A title → a TYPED reference.
   *
   * 🔴 THIS IS THE ONLY WAY A SHOW EVER GETS AN ID IN THIS CODEBASE.
   *
   * `whats_popular` deliberately emits no id for a show, because a show's TMDB
   * id is a valid and wrong argument to `add_movie`. That decision stands, so a
   * show is looked up here by name — one extra request, and the model never
   * holds a TMDB id for a show at any point.
   *
   * `alternates` is reported rather than swallowed: "Lioness" is measured to
   * match one show and three films, and a caller that said nothing about the
   * others would sound certain about a coin toss.
   */
  async find(query: string, kind?: 'film' | 'show', year?: number | null): Promise<FindAnswer> {
    const term = query.trim();
    if (!term) return { state: 'none', detail: 'no title to look up' };
    const got = await this.get(`/search/multi?query=${encodeURIComponent(term)}`);
    if (!got.ok) return { state: 'unknown', detail: got.detail };
    const results = got.body['results'];
    if (!Array.isArray(results)) {
      return {
        state: 'unknown',
        detail: `TMDB's search for "${term}" answered with no results array, so its shape has changed.`,
      };
    }

    type Hit = { ref: TitleRef; title: string; year: number | null };
    const hits: Hit[] = [];
    for (const r of results as Record<string, unknown>[]) {
      const t = r['media_type'];
      const media = t === 'movie' ? 'film' : t === 'tv' ? 'show' : null;
      if (!media) continue; // people, collections
      if (kind && media !== kind) continue;
      const id = Number(r['id']);
      const title = String(r['title'] || r['name'] || '').trim();
      if (!Number.isFinite(id) || id <= 0 || !title) continue;
      const d = String(r['release_date'] || r['first_air_date'] || '');
      hits.push({ ref: { media, tmdbId: id }, title, year: /^\d{4}/.test(d) ? Number(d.slice(0, 4)) : null });
    }
    if (hits.length === 0) {
      return { state: 'none', detail: `TMDB has nothing called "${term}"${kind ? ` of that kind` : ''}.` };
    }
    // A year, when we have one, is a real discriminator and not a guess — it
    // came from the same TMDB row the title did.
    const exact = year ? hits.find((h) => h.year === year) : undefined;
    const best = exact ?? hits[0]!;
    return { state: 'found', ref: best.ref, title: best.title, year: best.year, alternates: hits.length - 1 };
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

// ── DETAILS ─────────────────────────────────────────────────────────────────

/**
 * A title, identified in a way that cannot be misread across id spaces.
 *
 * 🔴 THE MEDIA TYPE TRAVELS WITH THE NUMBER, ALWAYS. TMDB's movie and tv ids are
 * independent sequences, so `1396` is a real film AND a real show. A bare id is
 * therefore not an identifier at all — it is half of one, and the missing half
 * is the difference between the right answer and a confidently wrong one.
 */
export interface TitleRef {
  media: 'film' | 'show';
  tmdbId: number;
}

export interface CastMember {
  name: string;
  character: string;
}

export interface TitleDetails {
  title: string;
  year: number | null;
  media: 'film' | 'show';
  tmdbId: number;
  rating: number | null;
  votes: number;
  genres: string[];
  status: string | null;
  tagline: string | null;
  /**
   * 🔴 THE WHOLE THING, OR NOTHING. NEVER AN ELLIPSIS.
   *
   * A truncated overview and a genuinely short one are indistinguishable to the
   * model, and only one of them is safe: shown the first half of a plot it will
   * complete the rest, which is a fabrication we would have supplied the seed
   * for. TMDB overviews are one paragraph. They are passed through intact.
   *
   * Empty string is a real answer — TMDB has no overview for this title — and is
   * a different thing from not having been able to ask.
   */
  overview: string;
  /** Films only. */
  runtimeMinutes: number | null;
  /** Shows only. */
  seasons: number | null;
  episodes: number | null;
  networks: string[];
  /** Directors for a film, creators for a show. */
  madeBy: string[];
  cast: CastMember[];
  /** How many cast members TMDB listed, so a capped list is never a silent cut. */
  castTotal: number;
}

export type DetailsAnswer =
  | { state: 'details'; details: TitleDetails }
  | { state: 'unknown'; detail: string };

/** What a title lookup found. `none` is a real answer; `unknown` is not. */
export type FindAnswer =
  | { state: 'found'; ref: TitleRef; title: string; year: number | null; alternates: number }
  | { state: 'none'; detail: string }
  | { state: 'unknown'; detail: string };

/** How many cast members to carry. A LIST cap, always reported alongside the total. */
const CAST_SHOWN = 8;

/** `[{name}]` → `[name]`, for TMDB's many name-carrying arrays. */
function names(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String((x as Record<string, unknown>)?.['name'] ?? '').trim()).filter(Boolean);
}
