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

/** Everything that is not a letter or a digit is a separator in a filename. */
export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** The tokens that carry meaning: not noise, not a bare initial, not a year. */
function significant(ts: string[]): string[] {
  return ts.filter((t) => t.length > 1 && !NOISE.has(t) && !/^(19|20)\d{2}$/.test(t));
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
  if (isSeriesPosition(releaseTitle, titleTokens)) {
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
