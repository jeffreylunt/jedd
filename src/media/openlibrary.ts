/**
 * Open Library — turning free text into a WORK.
 *
 * ── WHY THIS SOURCE ─────────────────────────────────────────────────────────
 *
 * It is free, needs no key, and — measured 2026-08-27, before any of this was
 * written — it answers the exact question that swarm health cannot:
 *
 *     "The Hobbit J.R.R. Tolkien"  →  /works/OL27482W  The Hobbit
 *                                     J.R.R. Tolkien, 1937, 481 editions
 *
 * and the Corey Olsen study guide that outranked the novel on seeders is a
 * SEPARATE WORK in the same response, under its own author with one edition. The
 * distinction the release names blur is one this catalogue already draws.
 *
 * ── 🔴 A FAILURE TO REACH IT IS `unknown`, NEVER "no such book" ─────────────
 *
 * Same three-state discipline as `ProwlarrClient`, and it matters more here
 * because of what the caller does with the answer. `none` means the catalogue
 * was read and has no such work; `unknown` means we could not read it. Collapsing
 * them would let a DNS failure decide that a book does not exist — and the
 * caller's fallback for `unknown` is to go back to asking, which is right,
 * whereas its response to `none` is different. A source that was never asked is
 * not evidence of absence.
 *
 * ── ⚠️ ONE REQUEST, A SHORT TIMEOUT, NO RETRY ───────────────────────────────
 *
 * This sits in front of a Prowlarr search that already takes 35–45 s on a cold
 * cache, inside a turn somebody is waiting on. It is a nicety that improves the
 * answer, not a dependency the flow needs: if it is slow or down, the caller
 * degrades to asking which book. So the timeout is short on purpose, and a
 * retry loop would spend a guest's turn on a lookup that has a working fallback.
 */

import type { Work } from './book-work.js';

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export type WorkSearch =
  | { state: 'works'; works: Work[] }
  | { state: 'none'; detail: string }
  | { state: 'unknown'; detail: string };

/**
 * ⚠️ Open Library asks callers to identify themselves so they can be contacted
 * about traffic rather than simply blocked. Naming the software is the part that
 * serves that; a default agent string is how a self-hosted tool becomes
 * indistinguishable from a scraper.
 *
 * 🔴 IT NAMES THE SOFTWARE AND NOT A PERSON, and the repo's own invariant is
 * what insisted on that: `owner-config-fail-closed.test.ts` refused the first
 * version of this line because the repository URL in it carried the owner's
 * name. That rule exists for model-facing strings, and it lands even harder
 * here — this string LEAVES THE MACHINE, on every deployment of a public
 * project, announcing one particular person's identity to a third party from
 * somebody else's homelab.
 */
const USER_AGENT = 'jedd/2 (self-hosted homelab agent)';

/** Enough to tell works apart in a list a person will read. Nothing more. */
const FIELDS = 'key,title,author_name,first_publish_year,edition_count';

export interface OpenLibraryOptions {
  fetchImpl?: FetchImpl;
  /** Short: there is a working fallback, and a guest is waiting. */
  timeoutMs?: number;
  /** Overridable so a test never reaches the real service. */
  baseUrl?: string;
}

export class OpenLibraryClient {
  private readonly fetchImpl: FetchImpl;

  private readonly timeoutMs: number;

  private readonly baseUrl: string;

  constructor(opts: OpenLibraryOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.baseUrl = opts.baseUrl ?? 'https://openlibrary.org';
  }

  /** Candidate works for a free-text query, best first as Open Library ranks them. */
  async works(query: string, limit = 5): Promise<WorkSearch> {
    const url =
      `${this.baseUrl}/search.json?q=${encodeURIComponent(query)}` +
      `&fields=${encodeURIComponent(FIELDS)}&limit=${limit}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      return {
        state: 'unknown',
        detail: `could not reach the book catalogue (${(e as Error).message})`,
      };
    }
    if (!res.ok) return { state: 'unknown', detail: `the book catalogue returned http ${res.status}` };

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { state: 'unknown', detail: 'the book catalogue returned a body that is not JSON' };
    }
    const docs = (body as { docs?: unknown })?.docs;
    if (!Array.isArray(docs)) return { state: 'unknown', detail: 'the book catalogue returned an unexpected shape' };

    const works: Work[] = [];
    for (const d of docs as Record<string, unknown>[]) {
      const key = typeof d['key'] === 'string' ? d['key'] : '';
      const title = typeof d['title'] === 'string' ? d['title'].trim() : '';
      // 🔴 A work with no key cannot be pinned to anything and a work with no
      // title cannot be matched against a filename. Either way it is not a
      // candidate — dropping it is not the same as pretending it matched.
      if (!key || !title) continue;
      const authors = Array.isArray(d['author_name'])
        ? (d['author_name'] as unknown[]).filter((a): a is string => typeof a === 'string')
        : [];
      const year = Number(d['first_publish_year']);
      works.push({
        key,
        title,
        authors,
        ...(Number.isFinite(year) ? { firstPublishYear: year } : {}),
        editionCount: Number(d['edition_count'] ?? 0),
      });
    }

    if (works.length === 0) {
      return { state: 'none', detail: `the book catalogue has nothing for "${query}"` };
    }
    return { state: 'works', works };
  }
}

/** How a work reads in a numbered list somebody has to choose from. */
export function describeWork(w: Work): string {
  const who = w.authors.length ? ` by ${w.authors.slice(0, 2).join(' & ')}` : '';
  const when = w.firstPublishYear ? `, ${w.firstPublishYear}` : '';
  return `${w.title}${who}${when}`;
}
