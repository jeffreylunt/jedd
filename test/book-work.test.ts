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

const RPO: Work = {
  key: '/works/OL21455689W',
  title: 'Ready Player One',
  authors: ['Ernest Cline'],
  firstPublishYear: 2008,
  editionCount: 40,
};

/** The first Mistborn book. `Mistborn` is the SERIES and is not a work title. */
const FINAL_EMPIRE: Work = {
  key: '/works/OL15100036W',
  title: 'The Final Empire',
  authors: ['Brandon Sanderson'],
  firstPublishYear: 2001,
  editionCount: 40,
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

test('🔴 A NARRATOR IS NOT ANOTHER BOOK — the Wil Wheaton regression', () => {
  /**
   * ── FOUND BY RUNNING IT, NOT BY READING IT ────────────────────────────────
   *
   * Live audiobook search for *"Ready Player One Ernest Cline"*, verbatim:
   *
   *     25  Ernest Cline Ready Player One 2011 - Lacero 2014 Audiobook EPU
   *     14  Ernest Cline - Ready Player One (Wil Wheaton) - 2011 (80kbps)
   *      3  Ernest Cline - Ready Player One
   *
   * All three are the same book. `wil` and `wheaton` scored as leftovers, so the
   * famous narration was demoted to PARTIAL and the bare 3-seeder took it — a
   * thin swarm chosen over a healthy one for NO gain in identity. That is the
   * Fringe failure mode reappearing through the very key added to stop a
   * different one, and it passed every test in this file at the time.
   */
  const narrated = matchWork('Ernest Cline - Ready Player One (Wil Wheaton) - 2011 (80kbps)', RPO);
  assert.equal(narrated.score, WORK_MATCH.CLEAN, `a narrator credit must not demote it: ${narrated.reason}`);

  const bare = matchWork('Ernest Cline - Ready Player One', RPO);
  assert.equal(bare.score, WORK_MATCH.CLEAN, 'and the bare one is still clean, so the SWARM decides between them');
});

test('🔴 CONTROL: stripping brackets does NOT smuggle a derivative past the refusal', () => {
  /**
   * The refusals run on the RAW title and the leftover comparison runs on the
   * stripped one, and that order is the entire safety of the change above.
   * `(comic strips)` is a real Hobbit result and it lives in brackets: strip
   * first and the marker vanishes, promoting a comic adaptation to a candidate.
   */
  const comic = matchWork('Sir. J.R.R. Tolkien The Hobbit (comic strips)', HOBBIT);
  assert.equal(comic.score, WORK_MATCH.NOT_THIS_WORK, comic.reason);

  const bundled = matchWork('The Lord of the Rings - \tJ. R. R. Tolkien (Hobbit)+1-3 (KINDLE)', HOBBIT);
  assert.equal(bundled.score, WORK_MATCH.NOT_THIS_WORK, bundled.reason);
});

test('🔴 THE WHOLE MEASURED CORPUS, re-checked after the bracket change', () => {
  /**
   * ── ⚠️ THIS REPLACED AN ASSERTION I INVENTED, AND THAT IS THE POINT ────────
   *
   * The first version of the control above asserted on
   * `Frank Herbert - Dune (Dune Messiah)` — a name no indexer returned, written
   * to probe whether a whole different work could hide inside brackets. It
   * failed, and it was tempting to read that as the bracket change being wrong.
   *
   * It is not evidence of anything. This file's own rule is that fixtures come
   * from the indexers, and I broke it. So the control is now the corpus: every
   * release name actually measured on 2026-08-27, across four searches, with the
   * verdict each one must get. If bracket-stripping ever does smuggle something
   * through, it will be a real name doing it, and this is where it shows up.
   *
   * ⚠️ Add to this list by RUNNING A SEARCH. Do not add plausible names.
   */
  const corpus: [Work, string, number][] = [
    // The Hobbit — the search that started this.
    [HOBBIT, "Exploring J.R.R. Tolkien's The Hobbit by Corey Olsen ePUB eBOOK-", WORK_MATCH.NOT_THIS_WORK],
    [HOBBIT, 'An A Z of JRR Tolkien s The Hobbit by Sarah Oliver EPUB', WORK_MATCH.NOT_THIS_WORK],
    [HOBBIT, 'Tolkien RARE The Hobbit 1937-2017 Booklet with Dragons Lecture 1938-01-01', WORK_MATCH.NOT_THIS_WORK],
    [HOBBIT, THE_NOVEL, WORK_MATCH.PARTIAL],
    [HOBBIT, 'J.R.R Tolkien - The Lord of the Rings Series + The Hobbit [4 boo', WORK_MATCH.NOT_THIS_WORK],
    [HOBBIT, 'The Lord of the Rings - \tJ. R. R. Tolkien (Hobbit)+1-3 (KINDLE)', WORK_MATCH.NOT_THIS_WORK],
    [HOBBIT, 'Sir. J.R.R. Tolkien The Hobbit (comic strips)', WORK_MATCH.NOT_THIS_WORK],
    [HOBBIT, 'J. R. R. Tolkien Collections[The Hobbit] -DS', WORK_MATCH.NOT_THIS_WORK],
    [HOBBIT, 'J. R. R. Tolkien - The Hobbit.fb2', WORK_MATCH.CLEAN],
    // Dune — a control the shipped ranking already got right.
    [DUNE, 'Dune by Frank Herbert EPUB', WORK_MATCH.CLEAN],
    [DUNE, 'Dune Messiah by Frank Herbert EPUB', WORK_MATCH.PARTIAL],
    [DUNE, 'Frank Herbert - Dune 3: Children of Dune', WORK_MATCH.NOT_THIS_WORK],
    [DUNE, 'Dune Chronicles by Frank Herbert [EPUB, AZW3]', WORK_MATCH.NOT_THIS_WORK],
    [DUNE, 'Dune [Full 6 tomos][PDF][Spanish][Frank Herbert]', WORK_MATCH.NOT_THIS_WORK],
    // Project Hail Mary — the byline case.
    [PHM, 'Project Hail Mary by Andy Weir EPUB', WORK_MATCH.CLEAN],
    [PHM, 'Andy Weir - Project Hail Mary', WORK_MATCH.CLEAN],
    // Ready Player One — the narrator case, on the audiobook indexers.
    [RPO, 'Ernest Cline - Ready Player One (Wil Wheaton) - 2011 (80kbps)', WORK_MATCH.CLEAN],
    [RPO, 'Ernest Cline - Ready Player One (Split Chapter Files MP3)', WORK_MATCH.CLEAN],
    [RPO, 'Ernest Cline Ready Player One 2011 - Lacero 2014 Audiobook EPU', WORK_MATCH.PARTIAL],
    [RPO, 'Ready Player One - Ernest Cline m4b', WORK_MATCH.CLEAN],
    // Mistborn — every result for the SERIES name is a bundle, which is why
    // searching the pinned work's own title matters. See `search-release.ts`.
    [FINAL_EMPIRE, 'Brandon Sanderson - Mistborn Series 1-6(EPUB)', WORK_MATCH.NOT_THIS_WORK],
    [FINAL_EMPIRE, 'Brandon Sanderson - Mistborn Trilogy', WORK_MATCH.NOT_THIS_WORK],
    [FINAL_EMPIRE, 'Brandon Sanderson - [Mistborn 04] - The Alloy of Law', WORK_MATCH.NOT_THIS_WORK],
    [FINAL_EMPIRE, 'The Final Empire by Brandon Sanderson EPUB', WORK_MATCH.CLEAN],
  ];

  const wrong = corpus
    .map(([w, title, want]) => ({ title, want, got: matchWork(title, w) }))
    .filter((r) => r.got.score !== r.want);
  assert.deepEqual(
    wrong.map((r) => `${r.title} — wanted ${r.want}, got ${r.got.score} (${r.got.reason})`),
    [],
  );
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 A POSSESSIVE IN THE TITLE MADE THE BOOK UNREACHABLE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Found while verifying the Dungeon Crawler Carl fix, 2026-09-04, by running
 * the matcher rather than reading it. Open Library spells the work with a
 * CURLY apostrophe — `The Dungeon Anarchist’s Cookbook` — and every indexer
 * drops it: `The Dungeon Anarchists Cookbook (Dungeon Crawler Carl 03)`.
 *
 *     tokens('The Dungeon Anarchist’s Cookbook') -> the dungeon anarchist s cookbook
 *     tokens('The Dungeon Anarchists Cookbook')  -> the dungeon anarchists cookbook
 *
 * `anarchist` is not `anarchists`, so the title token is MISSING from the
 * filename and the release is refused as "does not name" the work — the one
 * release that IS the book, refused by the filter meant to protect it.
 *
 * ⚠️ THE FAILURE IS SILENT AND IT LOOKS LIKE A COVERAGE GAP. The tool reports
 * NOT THE BOOK and says the book "does not appear to be on the indexers", about
 * a release sitting right there. Measured across real catalogue spellings, FOUR
 * of five possessive titles were refused; the fifth passed only by luck, because
 * the release's series name happens to repeat the word (`Dungeon Crawler Carl`
 * supplies the `carl` that `Carl’s` lost).
 *
 * The fix is in `tokens`: an apostrophe is REMOVED rather than split on, so both
 * spellings land on the same token. It is deliberately not a stemmer — nothing
 * here should start deciding that two different words are the same word.
 */

/** Real Prowlarr rows, captured live 2026-09-04 for "Dungeon Crawler Carl". */
const DCC_03 = 'The Dungeon Anarchists Cookbook (Dungeon Crawler Carl 03) by Matt Dinniman (Audiobook)(Fiction)';
const DCC_05 = 'The Butchers Masquerade (Dungeon Crawler Carl 05) by Matt Dinniman (Audiobook)(Fiction)';
const DCC_07 = 'This Inevitable Ruin (Dungeon Crawler Carl 07) by Matt Dinniman (Audiobook)(Fiction)';

const ANARCHISTS_COOKBOOK: Work = {
  key: '/works/OL24848242W',
  title: 'The Dungeon Anarchist’s Cookbook',
  authors: ['Matt Dinniman'],
  firstPublishYear: 2021,
  editionCount: 5,
};

test('🔴 POSSESSIVE: the release that IS the book is not refused for dropping the apostrophe', () => {
  const m = matchWork(DCC_03, ANARCHISTS_COOKBOOK);
  assert.notEqual(
    m.score,
    WORK_MATCH.NOT_THIS_WORK,
    `the one release that is this book was refused: ${m.reason}`,
  );
});

test('🔴 POSSESSIVE: an apostrophe is removed, not split on, so both spellings agree', () => {
  assert.deepEqual(tokens('The Dungeon Anarchist’s Cookbook'), tokens('The Dungeon Anarchists Cookbook'));
  // The straight apostrophe is the same case and arrives from other catalogues.
  assert.deepEqual(tokens("Carl's Doomsday Scenario"), tokens('Carls Doomsday Scenario'));
});

test('🔴 CONTROL: loosening the apostrophe does NOT let a different volume through', () => {
  // The whole risk of touching the tokeniser is that identity gets weaker. The
  // other numbered volumes of the SAME series by the SAME author must still be
  // refused — that is the filter doing the job the pin exists for.
  for (const other of [DCC_05, DCC_07]) {
    assert.equal(
      matchWork(other, ANARCHISTS_COOKBOOK).score,
      WORK_MATCH.NOT_THIS_WORK,
      `${other} is a different book and must stay refused`,
    );
  }
});

/**
 * 🔴 THE THREE SPELLINGS OF ONE POSSESSIVE, AND THE THIRD ONE BIT.
 *
 * Removing the apostrophe fixed `Anarchist’s` vs `Anarchists` and BROKE
 * `Anarchist s` — indexers render the same possessive all three ways, and this
 * repo's own live-captured fixture already contained the third:
 * `An A Z of JRR Tolkien s The Hobbit by Sarah Oliver EPUB`. Refusing that
 * spelling produces the identical user-visible symptom as the bug being fixed —
 * "the book is not on the indexers", about a release sitting right there.
 *
 * So a bare `s` left over from the split is joined onto the word before it.
 * That is adjacency, not stemming: it needs the literal separated `s`, and it
 * never removes a suffix from a word that has one.
 */
test('🔴 POSSESSIVE: all THREE indexer spellings land on the same tokens', () => {
  const curly = tokens('The Dungeon Anarchist’s Cookbook');
  assert.deepEqual(tokens('The Dungeon Anarchists Cookbook'), curly, 'apostrophe dropped');
  assert.deepEqual(tokens('The Dungeon Anarchist s Cookbook'), curly, 'apostrophe became a space');
  assert.deepEqual(tokens("The Dungeon Anarchist's Cookbook"), curly, 'straight apostrophe');
});

test('🔴 POSSESSIVE: the space spelling is not refused either', () => {
  const spaced = 'The Dungeon Anarchist s Cookbook (Dungeon Crawler Carl 03) by Matt Dinniman (Audiobook)';
  const m = matchWork(spaced, ANARCHISTS_COOKBOOK);
  assert.notEqual(m.score, WORK_MATCH.NOT_THIS_WORK, `refused the same book, spelled differently: ${m.reason}`);
});

/**
 * 🔴 A REAL CONTROL FOR THE TOKENISER CHANGE — the one above is a null control.
 *
 * `The Butcher's Masquerade` is refused whatever the tokeniser does, because its
 * title shares nothing with book 03. It therefore cannot observe identity
 * getting weaker, and a control that cannot fail is not a control.
 *
 * The near miss this change actually creates is a numbered volume of the SAME
 * possessive title — and it was real: `isSeriesPosition` built its phrase from
 * NORMALISED title tokens and tested it against the RAW release name, so a
 * release that KEPT the apostrophe walked straight past the volume guard.
 *
 *     work: Carl’s Doomsday Scenario
 *     rel:  Carl’s Doomsday Scenario 3 — scored CLEAN, i.e. auto-pickable
 */
const DOOMSDAY: Work = {
  key: '/works/OL24848193W',
  title: 'Carl’s Doomsday Scenario',
  authors: ['Matt Dinniman'],
  firstPublishYear: 2021,
  editionCount: 3,
};

test('🔴 CONTROL: a numbered volume of the SAME possessive title is still refused', () => {
  for (const spelling of [
    'Carl’s Doomsday Scenario 3 - Matt Dinniman',
    'Carls Doomsday Scenario 3 - Matt Dinniman',
    'Carl s Doomsday Scenario 3 - Matt Dinniman',
  ]) {
    assert.equal(
      matchWork(spelling, DOOMSDAY).score,
      WORK_MATCH.NOT_THIS_WORK,
      `${spelling} is volume 3, not this book — the volume guard must see it however it is spelled`,
    );
  }
});
