import type { Candidate } from './matching.js';

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

  /** Reachability, distinguishing a wrong URL from a dead service. */
  async probe(): Promise<{ reachable: boolean; detail: string }> {
    const res = await this.call('/system/status');
    return { reachable: res.ok, detail: res.ok ? 'reachable' : res.detail };
  }
}
