import type { Candidate } from './matching.js';
import { parseQueue, type Release } from './queue.js';

/**
 * Sonarr / Radarr.
 *
 * ── 🔴 TWO DIFFERENT QUESTIONS, TWO DIFFERENT ENDPOINTS ──────────────────────
 *
 * *"Do you have X?"* and *"Can you get X?"* are not the same question, and V1
 * answered the first using the second's endpoint.
 *
 *  - **OWNED** — `GET /series`, `GET /movie`. Returns the COMPLETE library.
 *  - **CATALOGUE** — `/series/lookup`, `/movie/lookup`. Returns what COULD be
 *    added, bounded and relevance-ordered.
 *
 * **The bound is the whole problem.** V1 answered "do you have The Office?" from
 * a bounded lookup, and the owned title sat at position 9 of 20 — outside what
 * the model was shown — so Jedd said it was not in the library. **"Not in the
 * top N results" is not "not owned".**
 *
 * The fix here is structural rather than a bigger N: the owned answer is
 * computed by filtering the COMPLETE owned set client-side, so there is no
 * result window for a title to fall outside of.
 */

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * 🔴 FOUR STATES, AND THEY ARE NEVER COLLAPSED.
 *
 * V1's ebook path read qBittorrent's duplicate-add rejection as a download
 * FAILURE and told the user to retry — the one action guaranteed never to work,
 * wearing a helpful message. **A duplicate add is the SUCCESS case.**
 *
 * `unknown` is not a failure either: it means the write may or may not have
 * happened, which is a different thing to tell a user than "it didn't".
 */
export type AddOutcome =
  | { state: 'started'; detail: string; confirmed: number[] }
  | { state: 'already-have'; detail: string }
  | { state: 'failed'; detail: string }
  | { state: 'unknown'; detail: string };

export interface ArrOptions {
  /**
   * ⚠️ Base URL INCLUDING the path prefix: `http://host:8989/sonarr/api/v3`.
   * The bare host returns something that is not the API, which reads as a
   * broken homelab when it is really a wrong URL — see `probe()`.
   */
  baseUrl: string;
  apiKey: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

/**
 * 🔴 THREE STATES, AND `unknown` IS NEVER A "NO".
 *
 * An arr that cannot be reached must produce *"I could not check"*, never
 * *"it isn't there"*. A false negative about something Jeff owns is measured as
 * MORE damaging than a false positive, because he can see the title in Jellyfin
 * and Jedd is contradicting the evidence in front of him.
 */
export type LibraryAnswer =
  | { state: 'owned'; matches: Candidate[] }
  | { state: 'absent'; searched: number }
  | { state: 'unknown'; detail: string };

export type CatalogueAnswer =
  | { state: 'results'; candidates: Candidate[] }
  | { state: 'unknown'; detail: string };

export class ArrClient {
  private readonly fetchImpl: FetchImpl;

  private readonly timeoutMs: number;

  constructor(
    private readonly opts: ArrOptions,
    /** 'series' for Sonarr, 'movie' for Radarr. Decides the endpoint names. */
    private readonly kind: 'series' | 'movie',
  ) {
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  private async call(path: string): Promise<{ ok: boolean; status: number; body: unknown; detail: string }> {
    const url = `${this.opts.baseUrl}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { 'X-Api-Key': this.opts.apiKey },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      return { ok: false, status: 0, body: null, detail: `could not reach ${url}: ${(e as Error).message}` };
    }
    let body: unknown = null;
    let raw = '';
    try {
      raw = await res.text();
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    if (!res.ok) {
      return { ok: false, status: res.status, body: null, detail: `http ${res.status} from ${url}` };
    }
    if (body === null) {
      /**
       * ⚠️ A 200 that is not JSON is the WRONG-PREFIX signature, not a broken
       * service: the bare host serves a web app, so the request "succeeds" and
       * returns HTML. Reported distinctly, because "your URL is wrong" and "the
       * homelab is down" lead to completely different actions.
       */
      return {
        ok: false,
        status: res.status,
        body: null,
        detail:
          `${url} returned ${res.status} but the body is not JSON (starts "${raw.slice(0, 40)}"). ` +
          'That is the signature of a MISSING PATH PREFIX — the base URL must include ' +
          '/sonarr/api/v3 or /radarr/api/v3 — not of an unreachable service.',
      };
    }
    return { ok: true, status: res.status, body, detail: '' };
  }

  /**
   * 🔴 THE ID IS SELECTED BY KIND, NEVER BY A `??` CHAIN ACROSS ID SPACES.
   *
   * Found against the LIVE api, not by a fixture: a real Sonarr `/series` row for
   * *The Office (US)* carries **`id: 43` (Sonarr's internal id), `tvdbId: 73244`
   * AND `tmdbId: 2316`** — all three, all different, all valid-looking integers.
   *
   * A precedence chain `tmdbId ?? tvdbId ?? id` therefore returned **2316 for a
   * SERIES**, and Sonarr's add endpoint wants the **tvdbId**. Nothing would have
   * errored: 2316 is a perfectly well-formed number that either finds nothing or,
   * worse, finds a DIFFERENT series. That is the bad-id class in its purest form.
   *
   * Worse still, the field is not even consistently present: **59 of 60 rows had
   * `tmdbId`**, so the chain would have silently changed which id space it
   * returned for one row in the same list. An identifier that is usually right is
   * the hardest kind of wrong.
   *
   * My fixtures could not catch this because each carried only ONE id field, so
   * the precedence never had to choose. A fixture that cannot express the
   * ambiguity cannot test the rule.
   */
  private toCandidates(rows: unknown): Candidate[] {
    if (!Array.isArray(rows)) return [];
    const idField = this.kind === 'series' ? 'tvdbId' : 'tmdbId';
    return rows.map((r) => {
      const row = r as Record<string, unknown>;
      const raw = row[idField];
      return {
        id: typeof raw === 'number' && Number.isFinite(raw) ? raw : 0,
        title: String(row['title'] ?? ''),
        year: typeof row['year'] === 'number' ? row['year'] : undefined,
      };
    });
  }

  /**
   * Is this title in the library?
   *
   * 🔴 Filters the COMPLETE owned set rather than asking the service to search.
   * There is no result window, so a title cannot fall outside one — which is the
   * structural version of the "The Office at position 9 of 20" fix. It costs one
   * full listing per question; the arrs return that in a single response and the
   * library is small enough that this is not the expensive part.
   */
  async owned(title: string, match: (q: string, c: Candidate[]) => Candidate[]): Promise<LibraryAnswer> {
    const res = await this.call(`/${this.kind}`);
    if (!res.ok) return { state: 'unknown', detail: res.detail };
    const all = this.toCandidates(res.body);
    const matches = match(title, all);
    if (matches.length > 0) return { state: 'owned', matches };
    return { state: 'absent', searched: all.length };
  }

  /** What COULD be added. Bounded and relevance-ordered — never used to answer "do you have". */
  async catalogue(term: string): Promise<CatalogueAnswer> {
    const res = await this.call(`/${this.kind}/lookup?term=${encodeURIComponent(term)}`);
    if (!res.ok) return { state: 'unknown', detail: res.detail };
    return { state: 'results', candidates: this.toCandidates(res.body) };
  }

  private async post(path: string, body: unknown): Promise<{ ok: boolean; status: number; body: unknown; detail: string }> {
    const url = `${this.opts.baseUrl}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'X-Api-Key': this.opts.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      // Could not reach it: the write may or may not have landed. UNKNOWN.
      return { ok: false, status: 0, body: null, detail: `could not reach ${url}: ${(e as Error).message}` };
    }
    let parsed: unknown = null;
    let raw = '';
    try {
      raw = await res.text();
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    return { ok: res.ok, status: res.status, body: parsed, detail: raw.slice(0, 300) };
  }

  /**
   * Add a series, monitoring ONLY the seasons asked for.
   *
   * 🔴 THE SEASON-SCOPING DEFECT THIS EXISTS TO NOT HAVE.
   *
   * Live instance: a guest asked for *Peppa Pig* "the first 3 seasons" and V1
   * monitored **seasons 1-9**, then grabbed S5 at 52/52 — a season nobody
   * requested — while the requested S2 and S3 sit at 0/52 five months later.
   *
   * The mechanism is `addOptions.monitor`: leaving it at Sonarr's default lets
   * the SERVICE decide, and its decision overrides the per-season flags we set.
   * So the per-season `monitored` array is authoritative AND `monitor: 'none'`
   * is sent explicitly, so nothing downstream re-expands the scope.
   */
  async addSeries(input: {
    tvdbId: number;
    title: string;
    seasons: number[];
    availableSeasons: number[];
    rootFolder: string;
    qualityProfileId: number;
  }): Promise<AddOutcome> {
    if (!input.tvdbId) {
      return { state: 'failed', detail: 'no tvdbId — a series cannot be added without one.' };
    }
    const unknownSeasons = input.seasons.filter((n) => !input.availableSeasons.includes(n));
    if (unknownSeasons.length) {
      return {
        state: 'failed',
        detail:
          `season(s) ${unknownSeasons.join(', ')} do not exist for "${input.title}" ` +
          `(it has ${input.availableSeasons.join(', ')}). Nothing was added.`,
      };
    }
    const res = await this.post('/series', {
      tvdbId: input.tvdbId,
      title: input.title,
      qualityProfileId: input.qualityProfileId,
      rootFolderPath: input.rootFolder,
      monitored: true,
      seasons: input.availableSeasons.map((n) => ({
        seasonNumber: n,
        monitored: input.seasons.includes(n),
      })),
      // 🔴 'none' so the service does not re-expand what we scoped above.
      addOptions: { monitor: 'none', searchForMissingEpisodes: true },
    });
    return this.interpretAdd(res, input.seasons, input.title);
  }

  async addMovie(input: {
    tmdbId: number;
    title: string;
    rootFolder: string;
    qualityProfileId: number;
  }): Promise<AddOutcome> {
    if (!input.tmdbId) {
      return { state: 'failed', detail: 'no tmdbId — a movie cannot be added without one.' };
    }
    const res = await this.post('/movie', {
      tmdbId: input.tmdbId,
      title: input.title,
      qualityProfileId: input.qualityProfileId,
      rootFolderPath: input.rootFolder,
      monitored: true,
      addOptions: { searchForMovie: true },
    });
    return this.interpretAdd(res, [], input.title);
  }

  /** Map an arr response onto the four states. Never collapses them. */
  private interpretAdd(
    res: { ok: boolean; status: number; body: unknown; detail: string },
    seasons: number[],
    title: string,
  ): AddOutcome {
    if (res.ok) {
      return {
        state: 'started',
        detail: `"${title}" added and searching${seasons.length ? ` (season(s) ${seasons.join(', ')})` : ''}.`,
        confirmed: seasons,
      };
    }
    // 🔴 ALREADY PRESENT IS SUCCESS, NOT FAILURE. The arrs answer 400 with a
    // validation error whose text names the collision. Telling the user to retry
    // is the one action guaranteed never to work.
    if (res.status === 400 && /already been added|already exists/i.test(res.detail)) {
      return { state: 'already-have', detail: `"${title}" is already in the library — nothing to do.` };
    }
    if (res.status === 0) {
      return {
        state: 'unknown',
        detail:
          `Could not reach the service adding "${title}", so I do NOT know whether it was added. ` +
          `This is not a "no" — check before trying again. (${res.detail})`,
      };
    }
    return { state: 'failed', detail: `Add refused (http ${res.status}): ${res.detail.slice(0, 160)}` };
  }

  /**
   * How far along is something we added? Three-state, like everything else.
   *
   * This is what a `media-add` follow-up goes and looks at, and it must be able
   * to say **"I could not check"** distinctly from **"nothing has arrived"** —
   * the second is news the user needs, the first is not something to report as
   * if it were.
   */
  async progress(
    id: number,
    seasons: number[],
  ): Promise<
    | { state: 'complete'; detail: string }
    | { state: 'partial'; detail: string; have: number; want: number }
    | { state: 'none'; detail: string }
    | { state: 'unknown'; detail: string }
  > {
    const res = await this.call(`/${this.kind}`);
    if (!res.ok) return { state: 'unknown', detail: res.detail };
    const rows = Array.isArray(res.body) ? (res.body as Record<string, unknown>[]) : [];
    const idField = this.kind === 'series' ? 'tvdbId' : 'tmdbId';
    const row = rows.find((r) => Number(r[idField]) === id);
    if (!row) {
      return {
        state: 'unknown',
        detail:
          `"${id}" is not in the library listing at all, so I cannot tell whether it was removed, ` +
          'never added, or added under a different id. Not reporting this as "nothing arrived".',
      };
    }
    const title = String(row['title'] ?? id);
    if (this.kind === 'movie') {
      const hasFile = row['hasFile'] === true;
      return hasFile
        ? { state: 'complete', detail: `"${title}" has downloaded.` }
        : { state: 'none', detail: `"${title}" is added but has not downloaded yet.` };
    }
    const all = Array.isArray(row['seasons']) ? (row['seasons'] as Record<string, unknown>[]) : [];
    const wanted = all.filter((se) => seasons.includes(Number(se['seasonNumber'])));
    if (wanted.length === 0) {
      return { state: 'unknown', detail: `could not find season data for "${title}".` };
    }
    let have = 0;
    let want = 0;
    const perSeason: string[] = [];
    for (const se of wanted) {
      const st = (se['statistics'] ?? {}) as Record<string, unknown>;
      const got = Number(st['episodeFileCount'] ?? 0);
      const tot = Number(st['totalEpisodeCount'] ?? 0);
      have += got;
      want += tot;
      perSeason.push(`S${se['seasonNumber']} ${got}/${tot}`);
    }
    const detail = `"${title}": ${perSeason.join(', ')}`;
    if (want > 0 && have >= want) return { state: 'complete', detail };
    if (have > 0) return { state: 'partial', detail, have, want };
    return { state: 'none', detail };
  }

  /**
   * The download queue, grouped into RELEASES.
   *
   * 🔴 THE ONLY SOURCE OF TRUTH FOR "WHAT IS DOWNLOADING". There is deliberately
   * no cache in front of this and no local job store beside it — see
   * `src/media/queue.ts` for why the second source is the defect rather than the
   * staleness.
   *
   * `includeSeries` / `includeMovie` are what put a human-readable SUBJECT on
   * each row. Without them the only title present is the RELEASE name
   * (`Fringe.S02E18.720p.HDTV.X264-DIMENSION`), which a person asking "is Fringe
   * downloading?" would not match.
   *
   * ⚠️ `saturated` is reported rather than swallowed. A truncated queue read
   * looks exactly like a shorter queue, and "fewer things are downloading than
   * you think" is precisely the wrong thing to say by accident.
   */
  async queue(): Promise<
    | { state: 'queue'; releases: Release[]; totalRecords: number; saturated: boolean }
    | { state: 'unknown'; detail: string }
  > {
    const pageSize = 500;
    const include =
      this.kind === 'series'
        ? 'includeUnknownSeriesItems=true&includeSeries=true'
        : 'includeUnknownMovieItems=true&includeMovie=true';
    const res = await this.call(`/queue?pageSize=${pageSize}&${include}`);
    if (!res.ok) return { state: 'unknown', detail: res.detail };
    const total = Number((res.body as { totalRecords?: unknown })?.totalRecords ?? 0);
    return {
      state: 'queue',
      releases: parseQueue(res.body, this.kind === 'series' ? 'sonarr' : 'radarr'),
      totalRecords: Number.isFinite(total) ? total : 0,
      saturated: Number.isFinite(total) && total > pageSize,
    };
  }

  /** Reachability, distinguishing a wrong URL from a dead service. */
  async probe(): Promise<{ reachable: boolean; detail: string }> {
    const res = await this.call('/system/status');
    return { reachable: res.ok, detail: res.ok ? 'reachable' : res.detail };
  }
}
