import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchWork, pinWork, surname, tokens, WORK_MATCH, type Work } from '../src/media/book-work.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY RELEASE NAME IN THIS FILE IS A REAL PROWLARR RESULT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Captured 2026-08-27 against the live indexers, verbatim including the
 * truncation and the mangled punctuation. Invented filenames would have been the
 * more comfortable fixture and a useless one: the matcher's whole job is to cope
 * with how release groups actually name things, and every hard case here — the
 * subtitle in `Hobbit_ Or There and Back Again, The`, the `+1-3` bundling, the
 * byline crediting a guide's own author — is one I would not have thought to
 * invent. Two of them falsified a rule I had already written.
 *
 * ⚠️ If you need more fixtures, GO AND FETCH THEM. Do not write plausible ones.
 */

const HOBBIT: Work = {
  key: '/works/OL27482W',
  title: 'The Hobbit',
  authors: ['J.R.R. Tolkien'],
  firstPublishYear: 1937,
  editionCount: 481,
};

const DUNE: Work = {
  key: '/works/OL893414W',
  title: 'Dune',
  authors: ['Frank Herbert'],
  firstPublishYear: 1965,
  editionCount: 161,
};

const PHM: Work = {
  key: '/works/OL21745884W',
  title: 'Project Hail Mary',
  authors: ['Andy Weir'],
  firstPublishYear: 2021,
  editionCount: 32,
};

// ── 🔴 THE HOBBIT, ALL ELEVEN, AS THEY CAME BACK ────────────────────────────

/** seeders, title — exactly as Prowlarr returned them. */
const HOBBIT_RELEASES: [number, string][] = [
  [24, "Exploring J.R.R. Tolkien's The Hobbit by Corey Olsen ePUB eBOOK-"],
  [13, 'An A Z of JRR Tolkien s The Hobbit by Sarah Oliver EPUB'],
  [10, 'Tolkien RARE The Hobbit 1937-2017 Booklet with Dragons Lecture 1938-01-01'],
  [8, 'Hobbit_ Or There and Back Again, The - J. R. R. Tolkien-viny'],
  [8, 'J.R.R Tolkien - The Lord of the Rings Series + The Hobbit [4 boo'],
  [6, 'The Lord of the Rings - \tJ. R. R. Tolkien (Hobbit)+1-3 (KINDLE)'],
  [3, 'Sir. J.R.R. Tolkien The Hobbit (comic strips)'],
  [2, 'J.R.R. Tolkien - The Hobbit, The Simarillion Illustrated (2nd Ed'],
  [0, 'J. R. R. Tolkien Collections[The Hobbit] -DS'],
  [0, 'Lord of the Rings(Hobbit Included)-J. R. R. Tolkien {Rahul Pr.}'],
  [0, 'J. R. R. Tolkien - The Hobbit.fb2'],
];

const THE_NOVEL = 'Hobbit_ Or There and Back Again, The - J. R. R. Tolkien-viny';

test('🔴 THE HOBBIT: both study guides are refused, and they are the two best-seeded results', () => {
  /**
   * This is the defect, stated as an assertion. The 24-seeder and 13-seeder
   * releases are what a swarm-health ranking takes, and neither is the book.
   */
  const guide = matchWork("Exploring J.R.R. Tolkien's The Hobbit by Corey Olsen ePUB eBOOK-", HOBBIT);
  assert.equal(guide.score, WORK_MATCH.NOT_THIS_WORK, guide.reason);

  const az = matchWork('An A Z of JRR Tolkien s The Hobbit by Sarah Oliver EPUB', HOBBIT);
  assert.equal(az.score, WORK_MATCH.NOT_THIS_WORK, az.reason);
});

test('🔴 THE HOBBIT: the actual novel survives, subtitle and all', () => {
  /**
   * ⚠️ THIS IS THE ASSERTION THAT KILLED THE FIRST DESIGN.
   *
   * The rule was "the leftover tokens must be empty". Open Library's work title
   * is `The Hobbit`; this release carries the full title, so `there`, `back` and
   * `again` are leftovers and it was REJECTED — the one release the whole
   * exercise exists to reach. Hence PARTIAL: a band below a clean match rather
   * than a refusal.
   */
  const m = matchWork(THE_NOVEL, HOBBIT);
  assert.ok(m.score > WORK_MATCH.NOT_THIS_WORK, `the novel must not be refused: ${m.reason}`);
  assert.equal(m.score, WORK_MATCH.PARTIAL, 'and it is a partial match, because of the subtitle');
});

test('🔴 THE HOBBIT: ranking on identity FIRST puts the novel top, from fourth on seeders', () => {
  /**
   * The whole fix in one assertion, run over the real result set. Identity is
   * the first key; the swarm decides only among releases that are the book.
   */
  const scored = HOBBIT_RELEASES.filter(([s]) => s > 0)
    .map(([seeders, title]) => ({ seeders, title, m: matchWork(title, HOBBIT) }))
    .filter((r) => r.m.score > WORK_MATCH.NOT_THIS_WORK)
    .sort((a, b) => b.m.score - a.m.score || b.seeders - a.seeders);

  assert.ok(scored.length > 0, 'something must survive, or the flow dead-ends');
  assert.equal(scored[0]!.title, THE_NOVEL, `chose ${scored[0]!.title}`);

  // And the control: on seeders alone, which is what shipped, the answer is the
  // study guide. The two orderings must disagree or this proves nothing.
  const bySeeders = [...HOBBIT_RELEASES].filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]);
  assert.match(bySeeders[0]![1], /Exploring/, 'seeders-first takes the study guide — that is the bug');
  assert.notEqual(bySeeders[0]![1], scored[0]!.title, 'the two orderings DISAGREE on this fixture');
});

test('🔴 THE HOBBIT: the bundles are refused, including the two that bundle with punctuation', () => {
  const four = matchWork('J.R.R Tolkien - The Lord of the Rings Series + The Hobbit [4 boo', HOBBIT);
  assert.equal(four.score, WORK_MATCH.NOT_THIS_WORK, four.reason);

  /**
   * ⚠️ `(Hobbit)+1-3` announces its bundling in PUNCTUATION and no word list
   * would have caught it. It names the work, credits the right author, and is
   * not a guide — every word-based rule passes it.
   */
  const plus = matchWork('The Lord of the Rings - \tJ. R. R. Tolkien (Hobbit)+1-3 (KINDLE)', HOBBIT);
  assert.equal(plus.score, WORK_MATCH.NOT_THIS_WORK, plus.reason);

  const coll = matchWork('J. R. R. Tolkien Collections[The Hobbit] -DS', HOBBIT);
  assert.equal(coll.score, WORK_MATCH.NOT_THIS_WORK, coll.reason);
});

test('THE HOBBIT: the booklet and the comic strips are refused too', () => {
  const booklet = matchWork('Tolkien RARE The Hobbit 1937-2017 Booklet with Dragons Lecture 1938-01-01', HOBBIT);
  assert.equal(booklet.score, WORK_MATCH.NOT_THIS_WORK, booklet.reason);

  const comic = matchWork('Sir. J.R.R. Tolkien The Hobbit (comic strips)', HOBBIT);
  assert.equal(comic.score, WORK_MATCH.NOT_THIS_WORK, comic.reason);
});

test('THE HOBBIT: a bare, correctly-named copy is a CLEAN match', () => {
  const clean = matchWork('J. R. R. Tolkien - The Hobbit.fb2', HOBBIT);
  assert.equal(clean.score, WORK_MATCH.CLEAN, clean.reason);
});

// ── 🔴 THE CONTROLS: BOOKS THE SHIPPED CODE ALREADY GOT RIGHT ───────────────

/**
 * 🔴 A FIX THAT BREAKS THE WORKING CASES IS NOT A FIX.
 *
 * Both of these were measured live and the seeders-first ranking already
 * returned the correct release. The new rule has to agree with it, or it has
 * traded one wrong answer for a different one.
 */

test('🔴 CONTROL — PROJECT HAIL MARY: "by Andy Weir" is the RIGHT author and must pass', () => {
  /**
   * ⚠️ THE SECOND ASSERTION THAT KILLED A RULE. `by <name>` is the shape both
   * Hobbit study guides used, and banning the shape would have refused all three
   * genuine Project Hail Mary releases. The shape is not the signal — WHOSE NAME
   * FOLLOWS IT is.
   */
  for (const t of [
    'Project Hail Mary by Andy Weir EPUB',
    'Project Hail Mary by Andy Weir AZW3',
    'Andy Weir - Project Hail Mary',
  ]) {
    const m = matchWork(t, PHM);
    assert.equal(m.score, WORK_MATCH.CLEAN, `${t}: ${m.reason}`);
  }
});

test('🔴 CONTROL — DUNE: the novel is a clean match and DUNE MESSIAH is not', () => {
  /**
   * Live: `Dune by Frank Herbert EPUB` at 78 seeders and `Dune Messiah by Frank
   * Herbert EPUB` at 20. Both name the work's only significant title token, both
   * credit Herbert, neither is a guide or a bundle. The leftover token `messiah`
   * is the entire difference — without it, the sequel is a clean match for its
   * own predecessor and only the seeder gap keeps it out.
   */
  const dune = matchWork('Dune by Frank Herbert EPUB', DUNE);
  assert.equal(dune.score, WORK_MATCH.CLEAN, dune.reason);

  const messiah = matchWork('Dune Messiah by Frank Herbert EPUB', DUNE);
  assert.equal(messiah.score, WORK_MATCH.PARTIAL, messiah.reason);
  assert.ok(messiah.score < dune.score, 'the sequel ranks BELOW the book that was asked for');
});

test('🔴 CONTROL — DUNE: identity-first agrees with seeders-first where seeders-first was right', () => {
  const DUNE_RELEASES: [number, string][] = [
    [78, 'Dune by Frank Herbert EPUB'],
    [20, 'Dune Messiah by Frank Herbert EPUB'],
    [14, 'Frank Herbert - Dune 3: Children of Dune'],
    [11, 'Dune Messiah by Frank Herbert MOBI'],
    [11, 'Dune Chronicles by Frank Herbert [EPUB, AZW3]'],
    [8, 'Frank Herbert - Dune 5: Heretics of Dune'],
    [7, 'Frank Herbert - Dune 2: Dune Messiah'],
    [4, 'Frank Herbert - Dune 6: Chapterhouse Dune'],
    [4, "Dune - the first book in Frank Herbert's Sience Fiction cycle"],
    [4, 'Dune [Full 6 tomos][PDF][Spanish][Frank Herbert]'],
  ];
  const top = DUNE_RELEASES.map(([seeders, title]) => ({ seeders, title, m: matchWork(title, DUNE) }))
    .filter((r) => r.m.score > WORK_MATCH.NOT_THIS_WORK)
    .sort((a, b) => b.m.score - a.m.score || b.seeders - a.seeders)[0];

  assert.equal(top?.title, 'Dune by Frank Herbert EPUB', 'unchanged from what already shipped');
});

// ── 🔴 PINNING THE WORK ─────────────────────────────────────────────────────

test('🔴 pinWork settles the three queries that were measured, author or no author', () => {
  const hobbitWorks: Work[] = [
    HOBBIT,
    { key: '/works/OL219602W', title: 'The Hobbit', authors: ['Charles Dixon'], editionCount: 10 },
    { key: '/works/OL24269837W', title: 'The hobbit, J.R.R. Tolkien', authors: ['Spark Publishing'], editionCount: 1 },
  ];
  assert.equal(pinWork('The Hobbit J.R.R. Tolkien', hobbitWorks)?.key, HOBBIT.key);

  // Live Open Library ordering for "Dune": the novel at 161 editions, the sequel
  // at 101. Not a margin any threshold could act on; the TITLE separates them.
  const duneWorks: Work[] = [
    DUNE,
    { key: '/works/OL893461W', title: 'Dune Messiah', authors: ['Frank Herbert'], editionCount: 101 },
  ];
  assert.equal(pinWork('Dune', duneWorks)?.key, DUNE.key);

  assert.equal(pinWork('Project Hail Mary Andy Weir', [PHM])?.key, PHM.key);
});

test('🔴 MUTATION: an edition-count margin would have to ask about "Dune"', () => {
  /**
   * The control for the rule above, and the reason it is not the obvious one.
   * 161 against 101 is a margin of 1.6x. Any threshold high enough to separate
   * the Hobbit novel (481) from the Spark Publishing guide (1) with confidence
   * refuses to pin "Dune" — and "Dune" is not an ambiguous request.
   */
  const margin = 161 / 101;
  assert.ok(margin < 2, `edition-count margin for Dune is only ${margin.toFixed(2)}x`);
  assert.equal(pinWork('Dune', [DUNE, { ...DUNE, key: '/x', title: 'Dune Messiah', editionCount: 101 }])?.key, DUNE.key);
});

test('a query that names no work exactly is NOT pinned — asking is the right answer', () => {
  assert.equal(pinWork('something about hobbits maybe', [HOBBIT]), undefined);
  assert.equal(pinWork('The Hobbit', []), undefined, 'and nothing to pin from is not a pin');
});

test('the helpers do what the rules above assume', () => {
  assert.equal(surname('J.R.R. Tolkien'), 'tolkien');
  assert.equal(surname('Andy Weir'), 'weir');
  assert.deepEqual(tokens('Hobbit_ Or There and Back Again, The'), [
    'hobbit', 'or', 'there', 'and', 'back', 'again', 'the',
  ]);
});
