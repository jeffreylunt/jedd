/**
 * WHICH BOOK — the identity question, decided before any release is ranked.
 *
 * ── 🔴 THE DEFECT THIS FILE EXISTS TO CLOSE ─────────────────────────────────
 *
 * Swarm health answers *"which copy"*, and that is only the right question
 * where the WORK is already pinned. `search_episode` pins it: a title, a season
 * and an episode resolve against Sonarr to one episode row, and the releases it
 * ranks are `/release?episodeId=…` — every candidate is an encoding of the same
 * episode. `search_ebook` and `search_audiobook` take FREE TEXT, so the
 * candidates are different WORKS and the ranking was being asked a question it
 * cannot answer.
 *
 * Measured live against Prowlarr, 2026-08-27, *"The Hobbit J.R.R. Tolkien"*,
 * eleven results, ordered by seeders:
 *
 *     24  Exploring J.R.R. Tolkien's The Hobbit by Corey Olsen ePUB eBOOK-
 *     13  An A Z of JRR Tolkien s The Hobbit by Sarah Oliver EPUB
 *     10  Tolkien RARE The Hobbit 1937-2017 Booklet with Dragons Lecture …
 *      8  Hobbit_ Or There and Back Again, The - J. R. R. Tolkien-viny   ← THE BOOK
 *      8  J.R.R Tolkien - The Lord of the Rings Series + The Hobbit [4 boo
 *      6  The Lord of the Rings - J. R. R. Tolkien (Hobbit)+1-3 (KINDLE)
 *
 * **The two best-seeded results are study guides.** The ranking was correct and
 * the answer was wrong, which is why no reordering fixes it.
 *
 * ── ⚠️ AND THE HONEST LIMIT OF WHAT THIS CAN BE ─────────────────────────────
 *
 * **There is no `releasesFor(workId)` for books.** Sonarr can scope a release
 * search to an episode id; Prowlarr and the IRC bots have no notion of a work at
 * all, and index nothing but filenames. So pinning a work does NOT hand us a set
 * of releases the way an `episodeId` does — it hands us a NAME to compare
 * filenames against, and this file is that comparison.
 *
 * That is weaker than TV's guarantee and it is important not to describe it as
 * the same thing. What it buys is a much narrower question: instead of *"which
 * of these six filenames is the book"* it asks *"is this filename a copy of THIS
 * work"*, one release at a time, against a title and an author that came from a
 * catalogue rather than from the user's phrasing.
 *
 * ── 🔴 SO THIS IS A SCORE, NOT A FILTER, AND THE DIRECTIONS DIFFER ──────────
 *
 * A hard filter fails in both directions and one of them is silent:
 *
 *  - reject the real book (its filename carries the subtitle, or no author) and
 *    the flow DEAD-ENDS on "nothing matches" while the book sits right there;
 *  - accept a guide and the original defect is back.
 *
 * `NOT_THIS_WORK` is refused outright — a release naming a different author, or
 * announcing itself as a guide or a box set, is not a copy of this book under
 * any reading. Everything else is RANKED, identity first, and the caller decides
 * what to do when nothing scores well. Falling back to asking is always
 * available; a dead end is not.
 */

/** How well a release filename matches a pinned work. Higher is better. */
export const WORK_MATCH = {
  /** Not a copy of this work: a foreign author, a guide, a bundle. REFUSED. */
  NOT_THIS_WORK: 0,
  /**
   * The work is in there, and so is something else — a subtitle, a series
   * position, another volume's name. Rankable, and below a clean match.
   *
   * ⚠️ THE REAL BOOK LANDS HERE, NOT ON A CLEAN MATCH, AND THAT IS THE POINT OF
   * HAVING THIS BAND. `Hobbit_ Or There and Back Again, The - J. R. R. Tolkien`
   * carries the subtitle that Open Library's work title omits, so a rule that
   * demanded a clean match would have rejected the one release we are trying to
   * reach. It still outranks every guide, because they score below it.
   */
  PARTIAL: 1,
  /** This work, and nothing else in the name. */
  CLEAN: 2,
} as const;

export interface Work {
  /** Open Library work key, e.g. `/works/OL27482W`. The identity itself. */
  key: string;
  title: string;
  authors: string[];
  firstPublishYear?: number;
  editionCount: number;
}

/**
 * Words that say a release is ABOUT a book rather than a copy of one.
 *
 * ⚠️ Every one of these was taken from a real Prowlarr result, not imagined.
 * `booklet` and `lecture` come from the 1937-2017 booklet; `exploring` from the
 * Corey Olsen guide; `comic` from the comic-strip release.
 */
const DERIVATIVE = new RegExp(
  [
    'exploring',
    'compan(?:ion|ions)',
    'summary',
    'summaries',
    'analysis',
    'study\\s*guide',
    'study\\s*notes',
    'sparknotes',
    'cliffs?\\s*notes',
    'workbook',
    'encyclopedia',
    'lecture',
    'booklet',
    'criticism',
    'essays',
    'unofficial',
    'comic',
    'graphic\\s*novel',
    'annotated\\s*guide',
    'a\\s*z\\s*of',
    'a\\s*to\\s*z\\s*of',
    'reading\\s*guide',
    'trivia',
    'quiz',
  ].join('|'),
  'i',
);

/**
 * Words and shapes that say a release is MORE THAN this book.
 *
 * ⚠️ `\+\s*\d` and `\d\s*-\s*\d` are here because two real results announced
 * their bundling with punctuation rather than a word: `(Hobbit)+1-3 (KINDLE)`
 * and `[4 boo…`. A word list alone would have admitted both.
 */
const BUNDLE = new RegExp(
  [
    'collections?',
    'complete\\s*(?:series|collection|works)',
    '\\bseries\\b',
    'omnibus',
    'box\\s*set',
    'boxset',
    'anthology',
    'trilogy',
    '\\bsaga\\b',
    '\\bcycle\\b',
    '\\d+\\s*[- ]?\\s*book',
    'books?\\s*\\d\\s*-\\s*\\d',
    '\\+\\s*\\d',
    '\\b\\d\\s*-\\s*\\d\\b',
    '\\btomos?\\b',
    'chronicles',
  ].join('|'),
  'i',
);

/**
 * Format, source and packaging noise — present in a filename, meaningless to
 * identity. Stripped before the leftover-token comparison so that `EPUB` and
 * `retail` do not read as "this release is about something else".
 */
const NOISE = new Set(
  ('epub azw azw3 mobi pdf fb2 lit djvu cbz cbr ebook ebooks kindle retail ' +
    'unabridged abridged audiobook audio mp3 m4b m4a flac vbr cbr128 64k 128k ' +
    'read narrated by ed edition editions vol volume rar zip iso true pdfs ' +
    'illustrated reprint anniversary hardcover paperback scan scanned ocr ' +
    'the a an of and or in on to for with').split(/\s+/),
);

/**
 * Every way a catalogue or a release group writes an apostrophe.
 *
 * ⚠️ ONE LIST, USED BY BOTH SITES. The defect this exists for was two places
 * disagreeing about punctuation; two copies of the class would let them
 * silently diverge again the first time one is edited.
 */
const APOSTROPHES = /['\u2018\u2019\u02BC\u00B4`]/g;

/**
 * The form of a name to SEND to an indexer.
 *
 * ── 🔴 THE SAME CHARACTER, THE SECOND PLACE IT HIDES A BOOK ──────────────────
 *
 * Fixing `tokens` alone was not enough, and only running the flow end to end
 * against the real services showed it. The term handed to Prowlarr is the work's
 * title AS THE CATALOGUE SPELLS IT, and Open Library spells possessives with a
 * curly apostrophe that no indexer carries. Measured 2026-09-04, one variable:
 *
 *     "The Dungeon Anarchist’s Cookbook Matt Dinniman"  ->  0 results
 *     "The Dungeon Anarchists Cookbook Matt Dinniman"   ->  1 result
 *
 * So the matcher and the search have to agree about punctuation, or the flow
 * reports "not on the indexers" at whichever of the two sites is still wrong.
 *
 * ⚠️ This is for the WIRE only. `describeWork` still shows the title the way the
 * catalogue spells it, because that is the half a person reads.
 *
 * ⚠️ KNOWN LIMIT, UNMEASURED: this glues ELISIONS as well as possessives, so
 * `L’Étranger` goes out as `LÉtranger` where indexers tend to write
 * `L Etranger`. The 0→1 measurement above is a possessive; the elision class
 * runs the other way and nobody has counted it. Fix it when a real search
 * misses, not on a hunch about French titles.
 */
export function indexerTerm(s: string): string {
  return s.replace(APOSTROPHES, '');
}

/**
 * ── 🔴 ONE QUERY FORM IS ONE CHANCE, AND THE FORM WE PREFER MISSES ──────────
 *
 * A ladder of ways to ask for the SAME book, most specific first. The caller
 * walks it and stops at the first rung that yields a candidate; the rest are
 * never sent.
 *
 * The defect, MEASURED live against Prowlarr 2026-09-04 — same indexers, same
 * minutes, the *only* variable being how the title was spelt:
 *
 *     "The Dungeon Anarchist’s Cookbook"   3 results, NONE an audiobook
 *     "The Dungeon Anarchists Cookbook"    0 results
 *     "Dungeon Anarchists Cookbook"        1 result  <- IS the audiobook
 *     "Dungeon Crawler Carl Anarchist"     4 results, one of them the audiobook
 *
 * **The apostrophe and the leading article each break the match on their own,
 * and the exact title the catalogue resolves to is the single form that finds
 * nothing.** Jedd told Jeff *"Prowlarr still has no audiobook release for it"*
 * about a release sitting at 14 seeders, and then offered an ebook instead —
 * which retires the question. An absence in OUR search is not an absence in the
 * world, and one query form makes the two impossible to tell apart.
 *
 * ── WHY "STRIP THE PUNCTUATION" IS NOT A RUNG OF ITS OWN ────────────────────
 *
 * It is applied to EVERY rung instead. `indexerTerm` already removes
 * apostrophes unconditionally, on its own measurement (0 results vs 1 for the
 * same title), so a rung that put the curly form back on the wire would spend a
 * whole request — Prowlarr answers in 35-45 s cold — on a spelling already
 * measured to return nothing.
 *
 * ── WHY THE LADDER IS THREE RUNGS AND NOT SIX ──────────────────────────────
 *
 * Every rung is a request against a service that warns about hammering, and
 * five searches in one turn produced timeouts in a probe on 2026-09-04. Rung 1
 * is exactly the term this code sent before, so **a search that works today
 * still costs exactly one request**; only a search that would otherwise have
 * reported a false absence pays for the extra ones.
 *
 * ⚠️ DUPLICATE RUNGS ARE DROPPED, so a title with no leading article and no
 * author does not ask the same question twice.
 *
 * ⚠️ THE BROAD RUNGS ARE SAFE ONLY BECAUSE OF `matchWork`. Rungs 2 and 3 drop
 * words, which means they match MORE things — including other books. Nothing
 * here decides identity: every release a rung returns is still scored against
 * the pinned work and refused if it is not a copy of it. Do not use this ladder
 * anywhere that filter does not run afterwards.
 */
export interface SearchTerm {
  /** What goes on the wire. */
  term: string;
  /** How to describe this rung to a person, so a miss can name what it tried. */
  form: string;
}

/** Only the leading one, and only when a word survives it. */
const LEADING_ARTICLE = /^(the|a|an)\s+(?=\S)/i;

/**
 * The longest significant word of a title, as a stand-in for the rarest one.
 *
 * ⚠️ AN ADMITTED PROXY. Rarity would need a corpus nobody has here; length
 * correlates with it well enough that `anarchists` wins over `dungeon` and
 * `cookbook` in the case this was built for. It is only ever used to BROADEN a
 * search whose narrower forms already found nothing, and what it returns is
 * still filtered for identity, so being wrong costs a request rather than a
 * wrong book.
 */
function mostDistinctiveWord(title: string): string {
  let best = '';
  for (const t of significantTitleTokens(title)) if (t.length > best.length) best = t;
  return best;
}

export function searchTerms(query: string, work?: Work): SearchTerm[] {
  const out: SearchTerm[] = [];
  const add = (raw: string, form: string): void => {
    const term = indexerTerm(raw).replace(/\s+/g, ' ').trim();
    if (!term) return;
    if (out.some((o) => o.term.toLowerCase() === term.toLowerCase())) return;
    out.push({ term, form });
  };

  if (!work) {
    /**
     * 🔴 NO WORK PINNED MEANS NO IDENTITY FILTER AFTERWARDS, so this half of the
     * ladder stops one rung short. The third rung is built out of a CATALOGUE
     * title and author; without a pin there is neither, and broadening a raw
     * phrase with nothing checking what comes back is how a different book gets
     * offered as though it were the one that was asked for.
     */
    add(query, 'what they said');
    add(query.replace(LEADING_ARTICLE, ''), 'what they said, without the leading "the"');
  } else {
    const author = work.authors[0] ?? '';
    add(`${work.title} ${author}`.trim(), 'the title and the author');
    add(work.title.replace(LEADING_ARTICLE, ''), 'the title alone, without the leading "the"');
    const distinctive = mostDistinctiveWord(work.title);
    const last = surname(author);
    if (distinctive && last) {
      add(`${last} ${distinctive}`, 'the author and the most distinctive word of the title');
    }
  }

  /**
   * ⚠️ NEVER EMPTY, ON EITHER PATH — AND THE EARLY `return` THAT USED TO SIT IN
   * THE FIRST BRANCH MEANT THIS DID NOT HOLD.
   *
   * `indexerTerm` strips apostrophes, so a query of nothing but `'''` produced
   * zero rungs; the caller then destructured `attempts[0]` and threw. An
   * invariant asserted in a comment above a branch that skips it is worse than
   * no invariant, because the caller trusts it.
   */
  if (out.length === 0) out.push({ term: query.trim(), form: 'what they said' });
  return out;
}

/**
 * Everything that is not a letter or a digit is a separator in a filename —
 * EXCEPT an apostrophe, which is removed, and a possessive `s` orphaned by one,
 * which is joined back on.
 *
 * ── 🔴 AN APOSTROPHE IS NOT A WORD BOUNDARY, AND SPLITTING ON ONE HID A BOOK ─
 *
 * Found by running the matcher, 2026-09-04. Open Library spells the work with a
 * CURLY apostrophe and indexers write the same possessive THREE ways:
 *
 *     'The Dungeon Anarchist’s Cookbook'   (catalogue)
 *     'The Dungeon Anarchists Cookbook'    (apostrophe dropped)
 *     'The Dungeon Anarchist s Cookbook'   (apostrophe became a space)
 *
 * Splitting on the apostrophe produced `anarchist` for the first and
 * `anarchists` for the second, so `matchWork` refused the one release that IS
 * the book as "does not name" the work, and the tool reported that the book was
 * not on the indexers — a coverage gap we manufactured about a release sitting
 * right there at 14 seeders.
 *
 * ⚠️ THE THIRD SPELLING IS WHY THE BARE `s` IS RE-JOINED, and it was a
 * regression introduced by the first version of this fix. It is not imagined:
 * this repo's own live-captured fixture carries it — `An A Z of JRR Tolkien s
 * The Hobbit by Sarah Oliver EPUB`. Removing the apostrophe alone fixes spelling
 * two and breaks spelling three, with the identical user-visible symptom.
 *
 * ⚠️ THIS IS NOT A STEMMER AND MUST NOT BECOME ONE. It joins a token that is
 * LITERALLY the single letter `s` onto the word before it; it never removes a
 * suffix from a word that has one, and it never decides two different words are
 * the same word. `matchWork`'s whole value is that it refuses near misses, and
 * the numbered volumes of one series are the near misses it exists to catch —
 * there is a control test for exactly that, on a possessive title.
 */
export function tokens(s: string): string[] {
  const split = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(APOSTROPHES, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  const out: string[] = [];
  for (const t of split) {
    if (t === 's' && out.length > 0) out[out.length - 1] += 's';
    else out.push(t);
  }
  return out;
}

/** The tokens that carry meaning: not noise, not a bare initial, not a year. */
function significant(ts: string[]): string[] {
  return ts.filter((t) => t.length > 1 && !NOISE.has(t) && !/^(19|20)\d{2}$/.test(t));
}

/**
 * The words of a TITLE that carry identity — the same filter `matchWork` uses on
 * a work's title, exported so a caller cannot drift from it.
 */
export function significantTitleTokens(title: string): string[] {
  return significant(tokens(title));
}


/**
 * A person's surname, as it appears in a filename.
 *
 * `J.R.R. Tolkien` → `tolkien`. Initials are dropped because filenames spell
 * them every way (`J.R.R`, `J. R. R.`, `JRR`) and the surname is the part that
 * survives all of them.
 */
export function surname(author: string): string {
  const ts = tokens(author).filter((t) => t.length > 1);
  return ts[ts.length - 1] ?? '';
}

/**
 * 🔴 `by <SOMEBODY ELSE>` IS THE STRONGEST SIGNAL THERE IS, AND IT IS GENERAL.
 *
 * Both study guides in the live Hobbit search named their own author in exactly
 * this shape — *"by Corey Olsen"*, *"by Sarah Oliver"* — while the genuine
 * article for other books uses the same shape with the RIGHT name: *"Project
 * Hail Mary by Andy Weir EPUB"*. So the pattern is not the signal; **whose name
 * follows it is**. A word list could never have covered this: neither `Olsen`
 * nor `Oliver` is a word anyone would think to ban.
 */
function bylineNamesSomeoneElse(releaseTitle: string, work: Work): boolean {
  const ts = tokens(releaseTitle);
  const surnames = new Set(work.authors.map(surname).filter(Boolean));
  const workTitleTokens = new Set(significant(tokens(work.title)));
  for (let i = 0; i < ts.length - 1; i++) {
    if (ts[i] !== 'by') continue;
    // The two tokens after `by` are the candidate name. If neither is one of
    // this work's surnames, and neither belongs to the title, somebody else is
    // being credited.
    const after = ts.slice(i + 1, i + 3).filter((t) => t.length > 1);
    if (after.length === 0) continue;
    const namesAuthor = after.some((t) => surnames.has(t));
    const partOfTitle = after.every((t) => workTitleTokens.has(t) || NOISE.has(t));
    if (!namesAuthor && !partOfTitle) return true;
  }
  return false;
}

/**
 * 🔴 A NARRATOR IS NOT ANOTHER BOOK — FOUND BY RUNNING IT, 2026-08-27.
 *
 * Live, *"Ready Player One Ernest Cline"* on the audiobook indexers returned:
 *
 *     25  Ernest Cline Ready Player One 2011 - Lacero 2014 Audiobook EPU
 *     14  Ernest Cline - Ready Player One (Wil Wheaton) - 2011 (80kbps)
 *      3  Ernest Cline - Ready Player One
 *
 * All three are the same book. `Wil Wheaton` is the famous narration of it. But
 * `wil` and `wheaton` are leftover tokens, so it scored PARTIAL, and the bare
 * 3-seeder scored CLEAN and **won** — a thin swarm taken over a healthy one for
 * no gain in identity whatsoever, which is the Fringe failure reappearing
 * through the very key added to prevent a different one.
 *
 * So bracketed segments come out before the leftover comparison. A release group
 * puts the narrator, the bitrate and the packaging in brackets and the WORK
 * outside them, near-universally.
 *
 * ⚠️ THIS RUNS AFTER THE REFUSALS, NOT BEFORE, AND THAT ORDER IS THE WHOLE
 * SAFETY OF IT. `Sir. J.R.R. Tolkien The Hobbit (comic strips)` is refused on
 * the RAW title, where `comic` is still visible; stripping first would hide the
 * marker and promote a comic adaptation to a candidate. Same for
 * `(Hobbit)+1-3 (KINDLE)`.
 */
function withoutEditionNoise(title: string): string {
  return title
    .replace(/[([{][^)\]}]*[)\]}]?/g, ' ')
    .replace(/\b\d+\s*kbps\b/gi, ' ')
    .replace(/\b\d+k\b/gi, ' ');
}

/**
 * 🔴 `<TITLE> <SMALL NUMBER>` IS A VOLUME OF A SERIES NAMED AFTER THE BOOK.
 *
 * ── FOUND BY A CORPUS CHECK, NOT BY THINKING ABOUT IT ──────────────────────
 *
 * One live Dune search returned FOUR of these:
 *
 *     Frank Herbert - Dune 2: Dune Messiah
 *     Frank Herbert - Dune 3: Children of Dune
 *     Frank Herbert - Dune 5: Heretics of Dune
 *     Frank Herbert - Dune 6: Chapterhouse Dune
 *
 * Each names the work, credits the right author, is not a guide and is not a
 * box set — so every rule above passes them, and they scored PARTIAL. That was
 * survivable only by luck: a CLEAN `Dune by Frank Herbert EPUB` existed and
 * outranked them. With no clean copy on the indexers, asking for *Dune* would
 * have fetched *Children of Dune* and reported success.
 *
 * ⚠️ ONE OR TWO DIGITS, NOT MORE. `The Hobbit 1937-2017 Booklet` is a real
 * release and `1937` is a year, not a volume — a wider rule would refuse
 * editions by their publication date.
 */
function isSeriesPosition(releaseTitle: string, titleTokens: string[]): boolean {
  if (titleTokens.length === 0) return false;
  const phrase = titleTokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\W+');
  return new RegExp(`\\b${phrase}\\W+\\d{1,2}\\b`, 'i').test(releaseTitle);
}

export interface WorkMatch {
  score: number;
  /** Why, in words, so a refusal is explainable rather than a bare 0. */
  reason: string;
}

/**
 * Score one release filename against the pinned work.
 *
 * ⚠️ ORDER MATTERS ONLY FOR THE EXPLANATION, not the verdict: a release can be
 * both a guide and a bundle, and the first reason found is the one reported.
 */
export function matchWork(releaseTitle: string, work: Work): WorkMatch {
  const ts = tokens(releaseTitle);
  const have = new Set(ts);
  const titleTokens = significant(tokens(work.title));

  // Nothing of the work's title in the name at all: this is not a near miss.
  const missing = titleTokens.filter((t) => !have.has(t));
  if (missing.length) {
    return { score: WORK_MATCH.NOT_THIS_WORK, reason: `does not name "${work.title}"` };
  }

  if (bylineNamesSomeoneElse(releaseTitle, work)) {
    return { score: WORK_MATCH.NOT_THIS_WORK, reason: 'credits a different author, so it is about the book' };
  }
  if (DERIVATIVE.test(releaseTitle)) {
    return { score: WORK_MATCH.NOT_THIS_WORK, reason: 'is a guide or companion, not the book' };
  }
  if (BUNDLE.test(releaseTitle)) {
    return { score: WORK_MATCH.NOT_THIS_WORK, reason: 'is a collection or box set, not this one book' };
  }
  // 🔴 NORMALISED, NOT RAW. The phrase is built from normalised title tokens, so
  // testing it against the raw name let a release that KEPT the apostrophe walk
  // past the volume guard: `Carl’s Doomsday Scenario 3` scored CLEAN.
  if (isSeriesPosition(ts.join(' '), titleTokens)) {
    return { score: WORK_MATCH.NOT_THIS_WORK, reason: 'is a numbered volume of the series, not this book' };
  }

  /**
   * What is left once the title, the author and the format noise are removed.
   *
   * 🔴 THIS IS WHAT SEPARATES `Dune` FROM `Dune Messiah`. Both name the work's
   * only significant title token, both credit Frank Herbert, and neither is a
   * guide or a bundle — measured live, they came back at 78 and 20 seeders. The
   * leftover token `messiah` is the whole difference, and without this the
   * sequel would be a clean match for its predecessor.
   */
  const authorTokens = new Set(work.authors.flatMap((a) => tokens(a)));
  const titleSet = new Set(titleTokens);
  const leftover = significant(tokens(withoutEditionNoise(releaseTitle))).filter(
    (t) => !titleSet.has(t) && !authorTokens.has(t),
  );

  if (leftover.length === 0) {
    return { score: WORK_MATCH.CLEAN, reason: 'names this work and nothing else' };
  }
  return {
    score: WORK_MATCH.PARTIAL,
    reason: `names this work plus ${leftover.slice(0, 3).join(', ')}`,
  };
}

/**
 * Pick the WORK a free-text query means, or refuse to.
 *
 * ── 🔴 THE RULE IS AN EXACT TITLE MATCH, AND NOT A POPULARITY MARGIN ────────
 *
 * `edition_count` is tempting — the Hobbit novel has 481 editions and the
 * Spark Publishing study guide has one — but it breaks on the case it most
 * needs to survive. Measured on Open Library: *"Dune"* returns Dune (161
 * editions) ahead of **Dune Messiah (101)**, which is not a dominant margin by
 * any threshold worth writing, so a margin rule would stop and ask which book
 * somebody meant by "Dune".
 *
 * The title does separate them: strip the author from the query and `dune`
 * equals `Dune` exactly, while `Dune Messiah` does not. Same for `The Hobbit
 * J.R.R. Tolkien` → `the hobbit`, and `Project Hail Mary Andy Weir` → `project
 * hail mary`. All three pin; a vaguer query does not, and asking is then the
 * correct answer rather than a failure.
 */
export function pinWork(query: string, works: Work[]): Work | undefined {
  if (works.length === 0) return undefined;

  const queryTokens = tokens(query);
  for (const w of works) {
    // Remove this candidate's own author tokens from the query, so that
    // "The Hobbit J.R.R. Tolkien" is compared as "the hobbit".
    const authorTokens = new Set(w.authors.flatMap((a) => tokens(a)));
    const asked = queryTokens.filter((t) => !authorTokens.has(t));
    if (sameTokens(asked, tokens(w.title))) return w;
  }
  return undefined;
}

/**
 * Words that carry no identity in a REQUEST for a book.
 *
 * ⚠️ Separate from `NOISE`, which is about filenames, and the overlap is the
 * reason: `book` is meaningless in *"that hobbit book"* and load-bearing in
 * `[4 books]`. One list serving both would have to choose which of those to get
 * wrong.
 */
const QUERY_NOISE = new Set(
  ('the a an of and or that this these those my his her their some any one thing ' +
    'book books novel novels story stories audiobook audiobooks ebook ebooks ' +
    'please get me want read listen about by').split(/\s+/),
);

/**
 * Works that have anything at all to do with what was asked.
 *
 * ── 🔴 FOUND BY RUNNING IT AGAINST THE REAL CATALOGUE, 2026-08-27 ───────────
 *
 * Open Library's relevance is excellent for a query that names a book and poor
 * for one that gestures at it. Live, *"that hobbit book"* returned, in order:
 *
 *     1. Hobbit Quotes Coloring Book — Steffi Buttner, 2020
 *     2. Final Planning Book — April Lorenz, 2021
 *     3. A hobbit, a wardrobe, and a great war — Joe Loconte, 2015
 *     4. American Film — American Film Institute, 1975
 *     5. The Enchanted World of Rankin/Bass — Rick Goldschmidt, 1997
 *
 * Presenting that verbatim asks somebody to choose which of five wrong books
 * they meant, and two of them have no discernible connection to the request at
 * all. The flow still failed CLOSED — picking one leads to "none of these
 * releases is that book" — but a question built entirely out of wrong answers is
 * not a question, and it invites the model to talk somebody into one.
 *
 * So a candidate has to share a real word with the request. `Final Planning
 * Book` and `American Film` do not; the two that mention a hobbit do, and the
 * caller can say plainly that none of them looks right and offer to search
 * again with an author.
 *
 * ⚠️ NOTHING HERE IMPROVES THE RANKING — it only declines to present candidates
 * that were never plausible. When nothing survives, the honest report is that
 * the catalogue could not settle the question, which is exactly what it means.
 */
export function relevantWorks(query: string, works: Work[]): Work[] {
  const asked = new Set(
    tokens(query).filter((t) => t.length > 1 && !QUERY_NOISE.has(t) && !/^(19|20)\d{2}$/.test(t)),
  );
  if (asked.size === 0) return works;
  return works.filter((w) => {
    const theirs = new Set([...tokens(w.title), ...w.authors.flatMap((a) => tokens(a))]);
    for (const t of asked) if (theirs.has(t)) return true;
    return false;
  });
}

function sameTokens(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((t, i) => t === b[i]);
}
