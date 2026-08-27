import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenLibraryClient } from '../src/media/openlibrary.js';
import { pinWork, relevantWorks } from '../src/media/book-work.js';
import type { FetchImpl } from '../src/media/prowlarr.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * task-2026-08-27T20-23-06Z — `limit=5` truncates below the wanted book.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Real production trigger: Jeff asked *"Can you try the author maybe?"*, the
 * model searched `Richard E. Turley`, Open Library reported `numFound=30`,
 * and the wanted work (`Vengeance Is Mine`) sat at rank 9. Measured over 21
 * real book queries (`v1-parity-corpus` + `data/audit.jsonl`'s real
 * `search_ebook`/`search_audiobook` calls) plus a mutation on a synthetic
 * case: raising the fetch limit only ever helps or does nothing, never hurts
 * — full method in `knowledge/jedd-relevantworks-premise-overturned-2026-08-27.md`
 * (media-bot space) and the task's completion notes.
 *
 * `limit=20` was also measured and bought nothing beyond `limit=10` on
 * either population, so 10 is the shipped number.
 */

const json = async (body: unknown): Promise<Response> =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

const doc = (key: string, title: string, author: string) => ({
  key,
  title,
  author_name: [author],
  first_publish_year: 2020,
  edition_count: 1,
});

test('OpenLibraryClient.works defaults to limit=10, not 5', async () => {
  let capturedUrl = '';
  const fetchImpl: FetchImpl = (async (url: string) => {
    capturedUrl = url;
    return json({ docs: [] });
  }) as FetchImpl;
  const client = new OpenLibraryClient({ fetchImpl });
  await client.works('anything');
  const limit = new URL(capturedUrl).searchParams.get('limit');
  assert.equal(limit, '10');
});

test(
  'MUTATION PROOF: a well-formed title+author query whose exact match sits at rank 7 ' +
    'behind 6 same-author decoys is MISSED at limit=5 and auto-picked at limit=10, unchanged at limit=20',
  async () => {
    // Titles deliberately share no tokens with the author's name, so
    // pinWork's author-token strip cannot accidentally eat a title word —
    // see book-work.ts's `pinWork` for why that matters.
    const allDocs = [
      doc('/works/OL1W', 'Falling Light', 'Cara Voss'),
      doc('/works/OL2W', 'The Longest Winter', 'Cara Voss'),
      doc('/works/OL3W', 'Nine Rivers', 'Cara Voss'),
      doc('/works/OL4W', 'Salt and Ember', 'Cara Voss'),
      doc('/works/OL5W', 'The Quiet Harbor', 'Cara Voss'),
      doc('/works/OL6W', 'Glass Country', 'Cara Voss'),
      doc('/works/OL7W', 'Distant Shores', 'Cara Voss'), // the wanted work, rank 7
    ];
    const query = 'Distant Shores Cara Voss';

    async function outcomeAt(limit: number) {
      const fetchImpl: FetchImpl = (async (url: string) => {
        const requestedLimit = Number(new URL(url).searchParams.get('limit'));
        return json({ docs: allDocs.slice(0, requestedLimit) });
      }) as FetchImpl;
      const client = new OpenLibraryClient({ fetchImpl });
      const res = await client.works(query, limit);
      assert.equal(res.state, 'works');
      if (res.state !== 'works') throw new Error('unreachable');
      const pinned = pinWork(query, res.works);
      if (pinned) return { picked: pinned.title };
      const presented = relevantWorks(query, res.works).slice(0, 5);
      return { presented: presented.map((w) => w.title) };
    }

    // RED at the old default: five decoys fill the presented list, the real
    // book (rank 7, never fetched) is nowhere in it.
    const at5 = await outcomeAt(5);
    assert.deepEqual(at5, {
      presented: ['Falling Light', 'The Longest Winter', 'Nine Rivers', 'Salt and Ember', 'The Quiet Harbor'],
    });
    assert.ok(!('picked' in at5), 'must NOT auto-pick at limit=5 — the check would be vacuous otherwise');

    // GREEN at the shipped default: pinWork scans the full (unsliced) fetch
    // and finds the exact match, so it auto-picks silently — no
    // disambiguation question is asked at all.
    const at10 = await outcomeAt(10);
    assert.deepEqual(at10, { picked: 'Distant Shores' });

    // limit=20 changes nothing further — same auto-pick.
    const at20 = await outcomeAt(20);
    assert.deepEqual(at20, { picked: 'Distant Shores' });
  },
);

test(
  'DOCUMENTED LIMITATION: an author-only query (the real Turley trigger) is NOT rescued ' +
    'by raising the limit — pinWork needs a title in the query, and the disambiguation list is ' +
    'independently capped at slice(0,5) in Open Library relevance order',
  async () => {
    // Six other books by the same author outrank the wanted one in Open
    // Library's own relevance order for an author-only search — exactly the
    // shape of the real "Richard E. Turley" query.
    const allDocs = [
      doc('/works/OL1W', 'Falling Light', 'Cara Voss'),
      doc('/works/OL2W', 'The Longest Winter', 'Cara Voss'),
      doc('/works/OL3W', 'Nine Rivers', 'Cara Voss'),
      doc('/works/OL4W', 'Salt and Ember', 'Cara Voss'),
      doc('/works/OL5W', 'The Quiet Harbor', 'Cara Voss'),
      doc('/works/OL6W', 'Glass Country', 'Cara Voss'),
      doc('/works/OL7W', 'Distant Shores', 'Cara Voss'),
    ];
    const query = 'Cara Voss'; // author only — no title tokens at all

    async function presentedAt(limit: number) {
      const fetchImpl: FetchImpl = (async (url: string) => {
        const requestedLimit = Number(new URL(url).searchParams.get('limit'));
        return json({ docs: allDocs.slice(0, requestedLimit) });
      }) as FetchImpl;
      const client = new OpenLibraryClient({ fetchImpl });
      const res = await client.works(query, limit);
      assert.equal(res.state, 'works');
      if (res.state !== 'works') throw new Error('unreachable');
      assert.equal(pinWork(query, res.works), undefined, 'an author-only query must never auto-pick a specific book');
      return relevantWorks(query, res.works)
        .slice(0, 5)
        .map((w) => w.title);
    }

    const at5 = await presentedAt(5);
    const at10 = await presentedAt(10);
    const at20 = await presentedAt(20);
    // Identical at every limit: `Array.filter` preserves order, so five
    // already-passing higher-ranked decoys can never be dislodged by
    // lower-ranked docs a bigger fetch adds to the tail.
    assert.deepEqual(at10, at5);
    assert.deepEqual(at20, at5);
    assert.ok(!at5.includes('Distant Shores'), 'the wanted work never reaches the presented list at any limit tested');
  },
);
