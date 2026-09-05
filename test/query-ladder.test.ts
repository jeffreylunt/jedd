import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChoiceStore } from '../src/choices.js';
import { searchTerms } from '../src/media/book-work.js';
import type { FetchImpl } from '../src/media/prowlarr.js';
import { makeSearchAudiobook, makeSearchEbook } from '../src/tools/search-release.js';
import type { ToolContext } from '../src/tools/types.js';
import { testConfig } from './helpers.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 AN ABSENCE IN OUR SEARCH IS NOT AN ABSENCE IN THE WORLD.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Jedd, live, 2026-09-04, asked for the Dungeon Crawler Carl book 3 audiobook:
 *
 *   "Found the right book — The Dungeon Anarchist's Cookbook by Matt Dinniman —
 *    but Prowlarr still has no audiobook release for it. So I can't pull it in.
 *    Want me to try it as an ebook instead, or leave it?"
 *
 * The release was on 1337x at 14 seeders the whole time. It is worse than an
 * ordinary miss because it is stated as settled fact AND offered a fallback,
 * which retires the question: a person reading that concludes the audiobook
 * does not exist.
 *
 * ── THE MEASUREMENT THIS FILE ENCODES ───────────────────────────────────────
 *
 * Live Prowlarr, category 3030, one variable — how the same title was spelt:
 *
 *     "The Dungeon Anarchist’s Cookbook"                 0 rows
 *     "The Dungeon Anarchists Cookbook"                  0 rows
 *     "Dungeon Anarchists Cookbook"                      1 row  <- THE BOOK
 *     "The Dungeon Anarchist’s Cookbook Matt Dinniman"   0 rows
 *     "The Dungeon Anarchists Cookbook Matt Dinniman"    1 row  <- THE BOOK
 *
 * **The leading article and the apostrophe each break the match on their own.**
 * The fake indexer below is that behaviour, narrowed to its sharpest form: it
 * answers ONE exact term and nothing else. A tool that asks once cannot reach
 * it; a tool that walks a ladder can.
 *
 * ⚠️ MUTATION-CHECKED. Collapsing `searchTerms` to `return [out[0]!]` — one
 * query form, the code as it was — turns the three ladder tests below RED and
 * leaves the two controls green, which is the point of having the controls.
 */

const tempFile = () => join(mkdtempSync(join(tmpdir(), 'jedd-ladder-')), 'choices.jsonl');
const JEFF = '+18015550123';

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  role: 'guest',
  senderHandle: JEFF,
  config: testConfig({ readOnly: false }),
  choices: new ChoiceStore(tempFile()),
  ...over,
});

const json = async (body: unknown): Promise<Response> =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

/** The real Open Library work, verbatim — note the CURLY apostrophe. */
const OL_DCC03 = {
  docs: [
    {
      key: '/works/OL24848242W',
      title: 'The Dungeon Anarchist’s Cookbook',
      author_name: ['Matt Dinniman'],
      first_publish_year: 2021,
      edition_count: 5,
    },
  ],
};
const openLibrary = (body: unknown) => ({ fetchImpl: (async () => json(body)) as FetchImpl });

/** The real 1337x row for book 3, verbatim. */
const DCC03 = {
  title: 'The Dungeon Anarchists Cookbook (Dungeon Crawler Carl 03) by Matt Dinniman (Audiobook)(Fiction)',
  infoHash: 'f'.repeat(40),
  seeders: 14,
  size: 970 * 1024 ** 2,
  indexer: '1337x',
};

/** A DIFFERENT volume of the same series by the same author — the near miss. */
const DCC02 = {
  title: 'Carls Doomsday Scenario (Dungeon Crawler Carl 02) by Matt Dinniman (Audiobook)(Fiction)',
  infoHash: 'e'.repeat(40),
  seeders: 32,
  size: 900 * 1024 ** 2,
  indexer: '1337x',
};

const termOf = (url: string): string =>
  decodeURIComponent(new URL(url).searchParams.get('query') ?? '');

/**
 * An indexer that answers EXACTLY ONE spelling. Every other term — including
 * the exact title the catalogue resolves to — comes back empty, which is the
 * measured behaviour above with the variance taken out of it.
 */
const onlyAnswers = (spelling: string, rows: unknown[], seen: string[]): FetchImpl =>
  async (url: string) => {
    const term = termOf(String(url));
    seen.push(term);
    return json(term.toLowerCase() === spelling.toLowerCase() ? rows : []);
  };

// ═══ 1. THE CASE ═══════════════════════════════════════════════════════════

test('🔴 DCC 03: the book is found through a LATER rung, not the first', async () => {
  const seen: string[] = [];
  const r = await makeSearchAudiobook(
    onlyAnswers('Dungeon Anarchists Cookbook', [DCC03], seen),
    openLibrary(OL_DCC03),
  ).run({ query: 'The Dungeon Anarchists Cookbook' }, ctx());

  assert.equal(r.ok, true);
  assert.match(r.content, /^CHOSE — /, `the ladder never reached the book: ${r.content}`);
  assert.match(r.content, /Dungeon Anarchists Cookbook \(Dungeon Crawler Carl 03\)/);

  // 🔴 THE FIRST FORM REALLY DID MISS. Without this the test could pass on an
  // indexer that answered rung one, which would prove nothing about a ladder.
  assert.ok(seen.length > 1, `only one form was ever tried: ${JSON.stringify(seen)}`);
  assert.equal(seen[0], 'The Dungeon Anarchists Cookbook Matt Dinniman');
  assert.ok(seen.includes('Dungeon Anarchists Cookbook'), JSON.stringify(seen));
});

test('🔴 and the reply SAYS a later form is what found it', async () => {
  const seen: string[] = [];
  const r = await makeSearchAudiobook(
    onlyAnswers('Dungeon Anarchists Cookbook', [DCC03], seen),
    openLibrary(OL_DCC03),
  ).run({ query: 'The Dungeon Anarchists Cookbook' }, ctx());
  assert.match(r.content, /the first 1 way\(s\) of asking found nothing/);
  assert.match(r.content, /Dungeon Anarchists Cookbook/);
});

test('the pick that reaches add_audiobook is the one the ladder found', async () => {
  const path = tempFile();
  const seen: string[] = [];
  await makeSearchAudiobook(
    onlyAnswers('Dungeon Anarchists Cookbook', [DCC03], seen),
    openLibrary(OL_DCC03),
  ).run({ query: 'The Dungeon Anarchists Cookbook' }, { ...ctx(), choices: new ChoiceStore(path) });
  const picked = new ChoiceStore(path).resolve(JEFF, 1);
  assert.ok(picked.ok);
  assert.equal(picked.option.value['infoHash'], DCC03.infoHash);
});

// ═══ 2. THE CONTROLS ═══════════════════════════════════════════════════════
//
// 🔴 WITHOUT THESE, A MATCHER THAT RETURNS EVERYTHING PASSES SECTION 1.

test('CONTROL POSITIVE: a term the indexer DOES answer comes back on the first ask', async () => {
  // The same fake, pointed at the form the tool sends first. One request, and
  // the ladder is never walked — which is the whole latency argument for it.
  const seen: string[] = [];
  const r = await makeSearchAudiobook(
    onlyAnswers('The Dungeon Anarchists Cookbook Matt Dinniman', [DCC03], seen),
    openLibrary(OL_DCC03),
  ).run({ query: 'The Dungeon Anarchists Cookbook' }, ctx());
  assert.match(r.content, /^CHOSE — /);
  assert.equal(seen.length, 1, `a working search must still cost one request: ${JSON.stringify(seen)}`);
  assert.doesNotMatch(r.content, /way\(s\) of asking found nothing/);
});

test('CONTROL NEGATIVE: an indexer that answers NOTHING still reports nothing', async () => {
  // The fake cannot be satisfied by any rung. If the ladder "found" something
  // here it would be inventing it.
  const seen: string[] = [];
  const r = await makeSearchAudiobook(
    onlyAnswers('a term no rung will ever build', [DCC03], seen),
    openLibrary(OL_DCC03),
  ).run({ query: 'The Dungeon Anarchists Cookbook' }, ctx());
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.content, /CHOSE/);
  assert.match(r.content, /^NOT FOUND/);
});

// ═══ 3. THE ANSWER WHEN NOTHING MATCHED ════════════════════════════════════

test('🔴 a no-results answer NEVER claims the release does not exist', async () => {
  const seen: string[] = [];
  const r = await makeSearchAudiobook(
    onlyAnswers('nothing matches this', [DCC03], seen),
    openLibrary(OL_DCC03),
  ).run({ query: 'The Dungeon Anarchists Cookbook' }, ctx());

  // It names every form it tried, verbatim, so a person can see the search that
  // ran and try one it did not.
  assert.equal(seen.length, 3, `every rung should have been tried: ${JSON.stringify(seen)}`);
  for (const term of seen) assert.ok(r.content.includes(term), `"${term}" is not named in the reply`);
  assert.match(r.content, /NOT a finding that the audiobook does not exist/);
  assert.match(r.content, /Do NOT say there is no audiobook release/);
  assert.match(r.content, /do NOT say it is not on the indexers/);
  // 🔴 The fallback that retired the question last time is explicitly gated.
  assert.match(r.content, /do NOT settle the question by offering something else/i);
});

test('🔴 NOT THE BOOK no longer says the book is not on the indexers', async () => {
  // Every rung answers — with the WRONG volume of the right series. The old
  // wording told the model to say "the book itself does not appear to be on the
  // indexers", which is the same claim one branch over.
  const seen: string[] = [];
  const r = await makeSearchAudiobook(
    async (url: string) => {
      seen.push(termOf(String(url)));
      return json([DCC02]);
    },
    openLibrary(OL_DCC03),
  ).run({ query: 'The Dungeon Anarchists Cookbook' }, ctx());

  assert.match(r.content, /^NOT THE BOOK/);
  assert.doesNotMatch(r.content, /does not appear to be on the indexers/);
  assert.match(r.content, /Do NOT say the book is not on the indexers/);
  assert.match(r.content, /Carls Doomsday Scenario/, 'and it shows what it did find');
});

// ═══ 4. THE LADDER CANNOT SMUGGLE IN A DIFFERENT BOOK ══════════════════════

test('🔴 a broader rung that finds a DIFFERENT book is refused, not offered', async () => {
  /**
   * The whole risk of broadening: rungs two and three drop words, so they match
   * more things. The guarantee is that nothing here decides identity —
   * `matchWork` still scores every release against the pinned work.
   */
  const seen: string[] = [];
  const r = await makeSearchAudiobook(
    onlyAnswers('Dungeon Anarchists Cookbook', [DCC02], seen),
    openLibrary(OL_DCC03),
  ).run({ query: 'The Dungeon Anarchists Cookbook' }, ctx());

  assert.ok(seen.length > 1, 'the broad rung was never reached, so nothing was tested');
  assert.doesNotMatch(r.content, /^CHOSE/);
  assert.doesNotMatch(r.content, /Call add_audiobook now/);
  assert.match(r.content, /^NOT THE BOOK/);
});

test('🔴 the ladder does NOT climb past an indexer that could not be reached', async () => {
  // UNKNOWN is a failure to LOOK. Asking a failing service two more questions
  // answers nothing and walks into its per-indexer backoff.
  let calls = 0;
  const r = await makeSearchAudiobook(async () => {
    calls += 1;
    throw new Error('ECONNREFUSED');
  }, openLibrary(OL_DCC03)).run({ query: 'The Dungeon Anarchists Cookbook' }, ctx());
  assert.equal(calls, 1, 'a dead indexer was asked more than once');
  assert.equal(r.ok, false);
  assert.match(r.content, /^UNKNOWN/);
});

// ═══ 5. THE RUNGS THEMSELVES ═══════════════════════════════════════════════

const WORK = {
  key: '/works/OL24848242W',
  title: 'The Dungeon Anarchist’s Cookbook',
  authors: ['Matt Dinniman'],
  firstPublishYear: 2021,
  editionCount: 5,
};

test('the rungs are: title+author, title without the article, author+distinctive word', () => {
  const terms = searchTerms('whatever they typed', WORK).map((t) => t.term);
  assert.deepEqual(terms, [
    'The Dungeon Anarchists Cookbook Matt Dinniman',
    'Dungeon Anarchists Cookbook',
    'dinniman anarchists',
  ]);
});

test('🔴 no rung ever carries an apostrophe onto the wire', () => {
  for (const t of searchTerms("Carl's Doomsday Scenario", WORK)) {
    assert.doesNotMatch(t.term, /['’ʼ]/, `rung "${t.form}" sent ${JSON.stringify(t.term)}`);
  }
});

test('a duplicate rung is dropped, so nothing is asked twice', () => {
  // No leading article and no author: rungs one and two would be the same
  // string, and a repeated question is a wasted 35-45s request.
  const terms = searchTerms('x', { key: '/works/X', title: 'Wool', authors: [], editionCount: 1 }).map((t) => t.term);
  assert.deepEqual(terms, ['Wool']);
});

test('🔴 with NO work pinned the ladder stops one rung short', () => {
  // Nothing filters what comes back, so broadening on a catalogue title and
  // author we do not have would be how a different book gets offered.
  const terms = searchTerms('The Anarchists Cookbook').map((t) => t.term);
  assert.deepEqual(terms, ['The Anarchists Cookbook', 'Anarchists Cookbook']);
});

test('the ebook half of the factory walks the same ladder', async () => {
  const seen: string[] = [];
  const r = await makeSearchEbook(
    onlyAnswers('Dungeon Anarchists Cookbook', [{ ...DCC03, title: 'The Dungeon Anarchists Cookbook by Matt Dinniman.epub' }], seen),
    undefined,
    openLibrary(OL_DCC03),
  ).run({ query: 'The Dungeon Anarchists Cookbook' }, ctx());
  assert.ok(seen.length > 1, 'search_ebook asked only once');
  assert.match(r.content, /^CHOSE — /);
});
