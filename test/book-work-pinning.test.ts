import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChoiceStore } from '../src/choices.js';
import type { FetchImpl } from '../src/media/prowlarr.js';
import type { IrcEbooks } from '../src/media/irc-ebooks.js';
import { makeSearchAudiobook, makeSearchEbook } from '../src/tools/search-release.js';
import { makeSendEbook } from '../src/tools/send-ebook.js';
import { KindleRegistry } from '../src/kindle.js';
import type { ToolContext } from '../src/tools/types.js';
import { testConfig } from './helpers.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE WORK IS SETTLED FIRST, AND THEN NOBODY IS ASKED ABOUT A TORRENT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `book-work.test.ts` pins the matcher against real release names. This file
 * runs the TOOL — what the model is actually handed, what reaches the choice
 * store, and which release a person would end up with.
 *
 * ── 🔴 EVERY FIXTURE HERE WAS CAPTURED LIVE ON 2026-08-27 ───────────────────
 *
 * The Prowlarr rows are the eleven real results for *"The Hobbit J.R.R.
 * Tolkien"*. The Open Library rows are the real response for the same string.
 * Neither was invented, and the whole point of the exercise is that the two
 * disagree about what the best answer is: seeders say the Corey Olsen study
 * guide, the catalogue says `/works/OL27482W`.
 */

const tempFile = () => join(mkdtempSync(join(tmpdir(), 'jedd-pin-')), 'choices.jsonl');
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

// ── the real Open Library response for "The Hobbit J.R.R. Tolkien" ──────────

const OL_HOBBIT = {
  docs: [
    { key: '/works/OL27482W', title: 'The Hobbit', author_name: ['J.R.R. Tolkien'], first_publish_year: 1937, edition_count: 481 },
    { key: '/works/OL219602W', title: 'The Hobbit', author_name: ['Charles Dixon', 'Sean Deming', 'J.R.R. Tolkien'], first_publish_year: 1990, edition_count: 10 },
    { key: '/works/OL16059606W', title: "J.R.R. Tolkien's The hobbit", author_name: ['Patsey Gray'], first_publish_year: 1968, edition_count: 3 },
    { key: '/works/OL24269837W', title: 'The hobbit, J.R.R. Tolkien', author_name: ['Spark Publishing'], first_publish_year: 2007, edition_count: 1 },
  ],
};

/** A stubbed catalogue. Never reaches the network; `testConfig` points at `.invalid`. */
const openLibrary = (body: unknown) => ({ fetchImpl: (async () => json(body)) as FetchImpl });
const openLibraryDown = () => ({
  fetchImpl: (async () => {
    throw new Error('ENOTFOUND openlibrary.invalid');
  }) as FetchImpl,
});

// ── the real Prowlarr rows, verbatim ────────────────────────────────────────

const hash = (n: number) => n.toString(16).padStart(40, '0');
const rel = (title: string, seeders: number, i: number) => ({
  title,
  infoHash: hash(i + 1),
  seeders,
  size: 2 * 1024 ** 2,
  indexer: 'SomeIndexer',
});

const HOBBIT_ROWS = [
  ["Exploring J.R.R. Tolkien's The Hobbit by Corey Olsen ePUB eBOOK-", 24],
  ['An A Z of JRR Tolkien s The Hobbit by Sarah Oliver EPUB', 13],
  ['Tolkien RARE The Hobbit 1937-2017 Booklet with Dragons Lecture 1938-01-01', 10],
  ['Hobbit_ Or There and Back Again, The - J. R. R. Tolkien-viny', 8],
  ['J.R.R Tolkien - The Lord of the Rings Series + The Hobbit [4 boo', 8],
  ['The Lord of the Rings - \tJ. R. R. Tolkien (Hobbit)+1-3 (KINDLE)', 6],
  ['Sir. J.R.R. Tolkien The Hobbit (comic strips)', 3],
  ['J.R.R. Tolkien - The Hobbit, The Simarillion Illustrated (2nd Ed', 2],
].map(([t, s], i) => rel(t as string, s as number, i));

const THE_NOVEL = 'Hobbit_ Or There and Back Again, The - J. R. R. Tolkien-viny';
const NOVEL_HASH = hash(4);
const GUIDE_HASH = hash(1);

const hobbitProwlarr: FetchImpl = async () => json(HOBBIT_ROWS);
const QUERY = 'The Hobbit J.R.R. Tolkien';

// ═══ 1. THE WHOLE FIX, END TO END ═══════════════════════════════════════════

test('🔴 HOBBIT: the work is pinned, the guides are refused, and the NOVEL is chosen', async () => {
  const path = tempFile();
  const r = await makeSearchEbook(hobbitProwlarr, undefined, openLibrary(OL_HOBBIT)).run(
    { query: QUERY },
    ctx({ choices: new ChoiceStore(path) }),
  );

  assert.equal(r.ok, true, r.content);
  assert.match(r.content, /^CHOSE — /);
  assert.match(r.content, /The Hobbit by J\.R\.R\. Tolkien, 1937/, 'it names the book it settled on');
  assert.match(r.content, /Hobbit_ Or There and Back Again/, 'and the release it took is the novel');

  // 🔴 The defect, asserted absent by NAME rather than by count.
  assert.doesNotMatch(r.content, /Corey Olsen/, 'the 24-seeder study guide is not the answer');
  assert.doesNotMatch(r.content, /Sarah Oliver/, 'nor the 13-seeder one');
  assert.match(r.content, /do NOT ask which torrent/i, "Jeff's rule is back on this path");

  // And what a consumer would actually grab is the novel, not just what the
  // prose says: option 1 is the thing that gets fetched.
  const stored = new ChoiceStore(path).resolve(JEFF, 1);
  assert.ok(stored.ok);
  assert.equal(stored.option.value['infoHash'], NOVEL_HASH, 'option 1 IS the novel');
  assert.equal(stored.choice.kind, 'ebook-release');
});

test('🔴 MUTATION: take the pin away and the same fixture yields the STUDY GUIDE', async () => {
  /**
   * The control that makes the test above mean something. Same Prowlarr rows,
   * same tool, catalogue unreachable — so nothing is pinned, the identity key
   * goes inert, and the ranking is what shipped in 2.0.0: the study guide first.
   *
   * If this ever stops putting Corey Olsen at the top, the fixture has stopped
   * reproducing the defect and the test above proves nothing.
   */
  const path = tempFile();
  const r = await makeSearchEbook(hobbitProwlarr, undefined, openLibraryDown()).run(
    { query: QUERY },
    ctx({ choices: new ChoiceStore(path) }),
  );
  assert.equal(r.ok, true, r.content);
  assert.doesNotMatch(r.content, /^CHOSE/, 'with no work pinned it must NOT choose');

  const stored = new ChoiceStore(path).resolve(JEFF, 1);
  assert.ok(stored.ok);
  assert.equal(
    stored.option.value['infoHash'],
    GUIDE_HASH,
    'unpinned, option 1 is the study guide — which is exactly the shipped defect',
  );
});

// ═══ 2. THE DEGRADED PATH IS LABELLED AS ONE ════════════════════════════════

test('🔴 an unreachable catalogue degrades to asking, and SAYS the catalogue failed', async () => {
  /**
   * ⚠️ A failure to LOOK must never read as a finding. The fallback prose is the
   * only place the difference is visible to the model, so it is asserted here
   * rather than trusted.
   */
  const r = await makeSearchEbook(hobbitProwlarr, undefined, openLibraryDown()).run({ query: QUERY }, ctx());
  assert.match(r.content, /^FOUND /);
  assert.match(r.content, /could not settle which book/);
  assert.match(r.content, /could not reach the book catalogue/, 'and why');
  assert.match(r.content, /ASK WHICH BOOK THEY MEANT/);
  assert.doesNotMatch(r.content, /no such book/i, 'unreachable is not absence');
});

test('a catalogue that knows no such book degrades the same way, with a different reason', async () => {
  const r = await makeSearchEbook(hobbitProwlarr, undefined, openLibrary({ docs: [] })).run(
    { query: QUERY },
    ctx(),
  );
  assert.match(r.content, /^FOUND /);
  assert.match(r.content, /has nothing for/);
});

// ═══ 3. THE ONE QUESTION WORTH ASKING ═══════════════════════════════════════

const OL_AMBIGUOUS = {
  docs: [
    { key: '/works/OL893414W', title: 'Dune', author_name: ['Frank Herbert'], first_publish_year: 1965, edition_count: 161 },
    { key: '/works/OL893461W', title: 'Dune Messiah', author_name: ['Frank Herbert'], first_publish_year: 1969, edition_count: 101 },
  ],
};

test('🔴 a query that names no work exactly asks WHICH BOOK — with authors and years', async () => {
  const path = tempFile();
  const r = await makeSearchEbook(hobbitProwlarr, undefined, openLibrary(OL_AMBIGUOUS)).run(
    { query: 'that dune book' },
    ctx({ choices: new ChoiceStore(path) }),
  );
  assert.equal(r.ok, true);
  assert.match(r.content, /^WHICH BOOK — /);
  assert.match(r.content, /1\. Dune by Frank Herbert, 1965/);
  assert.match(r.content, /2\. Dune Messiah by Frank Herbert, 1969/);
  assert.match(r.content, /Do NOT ask about torrents/);

  // The list stored is a BOOK list, not a release list. A consumer that wanted
  // a release must not be able to resolve it — see the fail-closed test below.
  const stored = new ChoiceStore(path).resolve(JEFF, 1);
  assert.ok(stored.ok);
  assert.equal(stored.choice.kind, 'book-work');
});

test('🔴 candidates that share nothing with the request are NOT presented', async () => {
  /**
   * ── FOUND BY RUNNING IT AGAINST THE REAL CATALOGUE, NOT BY READING IT ──────
   *
   * Every stubbed test passed while this was broken, because a stub returns the
   * works you thought it would. Live on 2026-08-27, *"that hobbit book"* came
   * back with these five, in this order, and this is the verbatim response:
   *
   *     Hobbit Quotes Coloring Book — Steffi Buttner, 2020
   *     Final Planning Book — April Lorenz, 2021
   *     A hobbit, a wardrobe, and a great war — Joe Loconte, 2015
   *     American Film — American Film Institute, 1975
   *     The Enchanted World of Rankin/Bass — Rick Goldschmidt, 1997
   *
   * Presented whole, that asks somebody which of five wrong books they meant,
   * and two have no connection to the request at all. It failed CLOSED — picking
   * one leads to "none of these releases is that book" — but a question built
   * out of wrong answers invites the model to talk somebody into one of them.
   */
  const OL_VAGUE = {
    docs: [
      { key: '/works/OL26968807W', title: 'Hobbit Quotes Coloring Book', author_name: ['Steffi Buttner'], first_publish_year: 2020, edition_count: 1 },
      { key: '/works/OL27952147W', title: 'Final Planning Book', author_name: ['April Lorenz'], first_publish_year: 2021, edition_count: 1 },
      { key: '/works/OL17356680W', title: 'A hobbit, a wardrobe, and a great war', author_name: ['Joe Loconte'], first_publish_year: 2015, edition_count: 6 },
      { key: '/works/OL1795514W', title: 'American Film', author_name: ['American Film Institute'], first_publish_year: 1975, edition_count: 2 },
      { key: '/works/OL5720297W', title: 'The Enchanted World of Rankin/Bass', author_name: ['Rick Goldschmidt'], first_publish_year: 1997, edition_count: 2 },
    ],
  };
  const r = await makeSearchEbook(hobbitProwlarr, undefined, openLibrary(OL_VAGUE)).run(
    { query: 'that hobbit book' },
    ctx(),
  );
  assert.match(r.content, /^WHICH BOOK — /);
  assert.match(r.content, /Hobbit Quotes Coloring Book/, 'the ones that mention a hobbit stay');
  assert.match(r.content, /a wardrobe, and a great war/);
  assert.doesNotMatch(r.content, /Final Planning Book/, 'and the ones that share nothing are gone');
  assert.doesNotMatch(r.content, /American Film/);
  assert.doesNotMatch(r.content, /Rankin/);

  // 🔴 And the way OUT is named. None of the survivors is The Hobbit either, so
  // an instruction to pick one of them would still be wrong.
  assert.match(r.content, /If NONE of these is the book they want/);
  assert.match(r.content, /ask for the author/);
});

test('🔴 when NOTHING plausible survives, it says the catalogue could not settle it', async () => {
  // Not "no such book", and not a list of five unrelated ones either. This is
  // the same fallback an unreachable catalogue takes, for the same reason: the
  // question was not answered.
  const OL_IRRELEVANT = {
    docs: [
      { key: '/works/OL1795514W', title: 'American Film', author_name: ['American Film Institute'], first_publish_year: 1975, edition_count: 2 },
    ],
  };
  const r = await makeSearchEbook(hobbitProwlarr, undefined, openLibrary(OL_IRRELEVANT)).run(
    { query: 'that hobbit book' },
    ctx(),
  );
  assert.match(r.content, /^FOUND /);
  assert.match(r.content, /returned nothing that looks like/);
  assert.doesNotMatch(r.content, /American Film/, 'the irrelevant candidate is not offered as a book');
});

test('🔴 nothing is searched while the BOOK is still in question', async () => {
  /**
   * Prowlarr is slow (35–45 s cold) and repeated searches trip per-indexer
   * backoff — see `prowlarr.ts`. Asking first and searching after is not just
   * tidier, it is the difference between one indexer hit and two.
   */
  let searched = 0;
  const counting: FetchImpl = async () => {
    searched += 1;
    return json(HOBBIT_ROWS);
  };
  await makeSearchEbook(counting, undefined, openLibrary(OL_AMBIGUOUS)).run({ query: 'that dune book' }, ctx());
  assert.equal(searched, 0, 'the indexers were not touched');
});

test('🔴 THE ANSWER COMES BACK TO THIS TOOL, and it then chooses for itself', async () => {
  const path = tempFile();
  const search = makeSearchEbook(hobbitProwlarr, undefined, openLibrary(OL_HOBBIT));

  // Ask about a query that will not pin, so a list of works is stored.
  await search.run({ query: 'that hobbit thing' }, ctx({ choices: new ChoiceStore(path) }));

  // They answer "1" — the Tolkien novel.
  const r = await search.run({ query: 'that hobbit thing', choice: 1 }, ctx({ choices: new ChoiceStore(path) }));
  assert.equal(r.ok, true, r.content);
  assert.match(r.content, /^CHOSE — /);
  assert.match(r.content, /The Hobbit by J\.R\.R\. Tolkien/);
  assert.match(r.content, /Hobbit_ Or There and Back Again/);
  assert.doesNotMatch(r.content, /Corey Olsen/);
});

test('🔴 the book pick is resolved BEFORE the list is cleared — order, not luck', async () => {
  /**
   * `search_*` clears the pending list the moment a search STARTS, so a stale
   * list can never be picked from. On the re-entrant call the pending list IS
   * the thing being answered, so clearing first would destroy the answer we were
   * just handed — silently, on every ambiguous book, every time.
   *
   * The assertion that catches it: after the second call the store holds a
   * RELEASE list, which can only exist if the book pick resolved.
   */
  const path = tempFile();
  const search = makeSearchEbook(hobbitProwlarr, undefined, openLibrary(OL_HOBBIT));
  await search.run({ query: 'that hobbit thing' }, ctx({ choices: new ChoiceStore(path) }));
  await search.run({ query: 'that hobbit thing', choice: 1 }, ctx({ choices: new ChoiceStore(path) }));

  const stored = new ChoiceStore(path).resolve(JEFF, 1);
  assert.ok(stored.ok, 'a list survives');
  assert.equal(stored.choice.kind, 'ebook-release', 'and it is the RELEASE list, so the pick resolved');
  assert.equal(stored.option.value['infoHash'], NOVEL_HASH);
});

test('a pick with no list waiting is refused and says nothing was searched', async () => {
  const r = await makeSearchEbook(hobbitProwlarr, undefined, openLibrary(OL_HOBBIT)).run(
    { query: QUERY, choice: 2 },
    ctx(),
  );
  assert.equal(r.ok, false);
  assert.match(r.content, /NONE — /);
  assert.match(r.content, /Nothing was searched/);
});

test('🔴 FAIL CLOSED: send_ebook cannot resolve a pending BOOK list', async () => {
  /**
   * While the question is "which book", the stored list is a `book-work` list.
   * A model that jumps ahead and calls the consumer with a number must not get a
   * work object handed to it as though it were a release — `resolveOfKind` is
   * what stops that, and this is it doing so on the new kind.
   */
  const path = tempFile();
  await makeSearchEbook(hobbitProwlarr, undefined, openLibrary(OL_AMBIGUOUS)).run(
    { query: 'that dune book' },
    ctx({ choices: new ChoiceStore(path) }),
  );

  const kindle = new KindleRegistry(tempFile());
  kindle.save(JEFF, 'readerone@kindle.com', ['readerone@kindle.com']);
  const sent: unknown[] = [];
  const r = await makeSendEbook({
    send: async (m) => {
      sent.push(m);
      return { messageId: 'x' };
    },
  }).run({ choice: 1 }, ctx({ choices: new ChoiceStore(path), kindle }));

  assert.equal(r.ok, false);
  assert.match(r.content, /book-work/, 'it names the kind it found');
  assert.equal(sent.length, 0);
});

// ═══ 4. THE TWO WAYS THIS COULD HAVE BEEN DEFEATED SILENTLY ═════════════════

test('🔴 TRUNCATION: identity is scored BEFORE the list is cut to five', async () => {
  /**
   * The `.slice(0, 5)` used to run on the seeder ranking, before anything asked
   * whether a release was the book. On the real Hobbit search the novel came
   * FOURTH, so the defect and its fix both fitted inside five — by luck.
   *
   * Six well-seeded guides and the novel seventh is the same search on a busier
   * title, and it is what a truncate-then-filter implementation gets wrong while
   * every other test in this file still passes.
   */
  const busy = [
    ...Array.from({ length: 6 }, (_, i) =>
      rel(`Exploring The Hobbit vol ${i + 1} by Corey Olsen EPUB`, 500 - i, i),
    ),
    rel(THE_NOVEL, 8, 90),
  ];
  const r = await makeSearchEbook(async () => json(busy), undefined, openLibrary(OL_HOBBIT)).run(
    { query: QUERY },
    ctx(),
  );
  assert.match(r.content, /^CHOSE — /);
  assert.match(r.content, /Hobbit_ Or There and Back Again/, 'the seventh-ranked release is the one taken');
  assert.doesNotMatch(r.content, /Corey Olsen/);
});

test('🔴 AN IRC OFFER IS SCORED FOR IDENTITY TOO, band or no band', async () => {
  /**
   * An IRC offer is banded `healthy` because a bot either holds the file or does
   * not answer — a claim about MECHANISM. Holding it firmly says nothing about
   * WHICH BOOK it is, so an unscored IRC offer would sit above every torrent on
   * the first key and walk straight past the filter.
   */
  const irc = {
    rosterHas: () => true,
    async search() {
      return {
        state: 'ok' as const,
        detail: 'found 1',
        results: [
          {
            bot: 'Bsk',
            command: '!Bsk Exploring.epub',
            title: "Exploring J.R.R. Tolkien's The Hobbit by Corey Olsen.epub",
            ext: '.epub',
            sizeBytes: 900_000,
          },
        ],
      };
    },
    async fetch() {
      return { state: 'failed' as const, detail: 'not used here' };
    },
  } as unknown as IrcEbooks;

  const r = await makeSearchEbook(hobbitProwlarr, irc, openLibrary(OL_HOBBIT)).run({ query: QUERY }, ctx());
  assert.match(r.content, /^CHOSE — /);
  assert.match(r.content, /Hobbit_ Or There and Back Again/);
  assert.doesNotMatch(r.content, /via IRC/, 'the bot is holding a study guide, so it is not a candidate');
});

test('🔴 THE IDENTITY KEY SITS ABOVE THE SWARM BAND — a thin right book beats a fat wrong one', async () => {
  /**
   * ── ⚠️ THIS TEST EXISTS BECAUSE A MUTATION SURVIVED ────────────────────────
   *
   * Swapping the comparator to `[band, work, format, seeders]` — identity BELOW
   * the swarm — left every other test in this file green. The refusal of
   * `NOT_THIS_WORK` is a filter and runs whatever the order is, so the guides
   * disappear either way, and on the Hobbit fixture every survivor happens to
   * sit in the same band. Order never got to matter, so nothing was testing it.
   *
   * It matters here. A CLEAN match in the `thin` band against a PARTIAL match in
   * `healthy` is the one arrangement where the two orderings disagree, and it is
   * an ordinary situation: the book somebody asked for is thinly seeded and its
   * sequel is popular.
   *
   * ⚠️ THE NAMES ARE REAL AND THE SEEDER COUNTS ARE CONSTRUCTED, deliberately
   * and unlike every other fixture in this file. Both came back from the live
   * Dune search; the counts are set to put them in different bands, because that
   * is the arrangement under test. Calling that a measurement would be a lie.
   *
   * And a 3-seeder copy of the right book really is the better answer than a
   * 300-seeder copy of the wrong one: a thin swarm is slow, a different book is
   * simply not what was asked for. The dead-swarm filter still runs first, so
   * this can never choose something that will never finish.
   */
  const OL_DUNE = {
    docs: [{ key: '/works/OL893414W', title: 'Dune', author_name: ['Frank Herbert'], first_publish_year: 1965, edition_count: 161 }],
  };
  const rows = [
    rel('Dune Messiah by Frank Herbert EPUB', 300, 0),
    rel('Dune by Frank Herbert EPUB', 3, 1),
  ];
  const r = await makeSearchEbook(async () => json(rows), undefined, openLibrary(OL_DUNE)).run(
    { query: 'Dune' },
    ctx(),
  );
  assert.match(r.content, /^CHOSE — /);
  assert.match(r.content, /Dune by Frank Herbert EPUB/, 'the book that was asked for');
  assert.doesNotMatch(r.content, /Messiah/, 'not the sequel, however many people are seeding it');
});

// ═══ 5. WHEN THE BOOK SIMPLY IS NOT THERE ═══════════════════════════════════

test('🔴 pinned, and nothing on offer is that book: it says so and offers NOTHING', async () => {
  /**
   * A third kind of zero. The dangerous shape here is a fallback: "the filter
   * emptied the list, so show the unfiltered one" would fire on precisely the
   * searches where the filter was doing its job, and hand back the guides.
   */
  const guidesOnly = [
    rel("Exploring J.R.R. Tolkien's The Hobbit by Corey Olsen ePUB eBOOK-", 24, 0),
    rel('An A Z of JRR Tolkien s The Hobbit by Sarah Oliver EPUB', 13, 1),
  ];
  const path = tempFile();
  const r = await makeSearchEbook(async () => json(guidesOnly), undefined, openLibrary(OL_HOBBIT)).run(
    { query: QUERY },
    ctx({ choices: new ChoiceStore(path) }),
  );
  assert.equal(r.ok, true);
  assert.match(r.content, /^NOT THE BOOK — /);
  assert.match(r.content, /do NOT offer any of these instead/i);
  assert.match(r.content, /do not say nothing was found/i, 'and it is not reported as absence');

  /**
   * 🔴 THE GUARANTEE IS THE EMPTY STORE, NOT THE WORDING.
   *
   * The guides ARE named in the prose, because "the book is not on the indexers,
   * though there are study guides" is the useful and honest answer. What makes
   * that safe is structural rather than obedient: no numbered list was stored,
   * so if the model offers one anyway there is nothing for a consumer to
   * resolve. Asserting on the instruction alone would be trusting a reader.
   */
  assert.doesNotMatch(r.content, /^\s*\d+\.\s/m, 'no numbered list is presented');
  assert.equal(
    new ChoiceStore(path).resolve(JEFF, 1).ok,
    false,
    'and nothing is resolvable, so a pick cannot be acted on even if one is offered',
  );
});

test('ALL DEAD is still distinguishable from NOT THE BOOK', async () => {
  // Two different zeros with different next moves. The work filter must not be
  // able to masquerade as a dead swarm.
  const dead = [rel(THE_NOVEL, 0, 0)];
  const r = await makeSearchEbook(async () => json(dead), undefined, openLibrary(OL_HOBBIT)).run(
    { query: QUERY },
    ctx(),
  );
  assert.match(r.content, /^ALL DEAD/);
});

// ═══ 6. AUDIOBOOKS TAKE THE SAME RULE ═══════════════════════════════════════

test('🔴 search_audiobook pins the work too — one factory, one rule', async () => {
  const r = await makeSearchAudiobook(hobbitProwlarr, openLibrary(OL_HOBBIT)).run({ query: QUERY }, ctx());
  assert.match(r.content, /^CHOSE — /);
  assert.match(r.content, /The Hobbit by J\.R\.R\. Tolkien/);
  assert.doesNotMatch(r.content, /Corey Olsen/);
  assert.match(r.content, /Call add_audiobook now with choice 1/);
});
