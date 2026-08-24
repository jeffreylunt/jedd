import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchScore, pickBest, typeVerdict, type Candidate } from '../src/media/matching.js';

const c = (id: number, title: string, year?: number): Candidate => ({ id, title, year });

// ── 🔴 the Moneyball defect ──────────────────────────────────────────────────

test('🔴 MONEYBALL: a title that exists as BOTH a film and a series is never auto-added', () => {
  // V1 added Moneyball (2021), a TV SERIES, when the ask was the 2011 FILM.
  // A code-level router picked the type and picked wrong.
  const v = typeVerdict('moneyball', [c(305, 'Moneyball', 2011)], [c(99, 'Moneyball', 2021)]);
  assert.equal(v.type, 'ambiguous', 'a cross-type title must force a question, not a pick');
  if (v.type !== 'ambiguous') throw new Error('unreachable');
  assert.equal(v.movie.best.year, 2011);
  assert.equal(v.series.best.year, 2021);
  assert.match(v.detail, /do NOT add/i);
});

test('🔴 the ambiguity rule fires on the TITLE, not on the user saying "film" or "show"', () => {
  // The modal real request is `verb + bare title` with no type marker, measured
  // over 806 turns. So the rule cannot depend on the user disambiguating.
  for (const q of ['moneyball', 'Get moneyball', 'can you add moneyball']) {
    const v = typeVerdict(q.replace(/^(get|can you add) /i, ''), [c(305, 'Moneyball', 2011)], [
      c(99, 'Moneyball', 2021),
    ]);
    assert.equal(v.type, 'ambiguous', `"${q}" should be ambiguous`);
  }
});

test('CONTROL: a title that matches only ONE catalogue resolves cleanly', () => {
  // Without this, "ambiguous" would be equally consistent with the rule firing
  // on everything, which would block every add and prove nothing.
  const movie = typeVerdict('whiplash', [c(244786, 'Whiplash', 2014)], []);
  assert.equal(movie.type, 'movie');
  const series = typeVerdict('breaking bad', [], [c(1396, 'Breaking Bad', 2008)]);
  assert.equal(series.type, 'series');
});

test('nothing resembling the query in either catalogue is NONE, not the closest thing', () => {
  const v = typeVerdict('zzzz nonexistent film', [c(1, 'Ghost Dad', 1990)], [c(2, 'Ghosts', 2021)]);
  assert.equal(v.type, 'none');
  if (v.type !== 'none') throw new Error('unreachable');
  assert.match(v.detail, /do not offer the closest/i);
});

// ── 🔴 the Ghost Dad control ─────────────────────────────────────────────────

test('🔴 GHOST DAD: results[0] is never a silent fallback', () => {
  // V1 accepted the first result when nothing matched, so a request for one
  // film could add a completely unrelated one.
  assert.equal(pickBest('the anxious generation', [c(1, 'Ghost Dad', 1990)]), null);
});

test('a genuine match is still found — the control for the Ghost Dad rule', () => {
  const p = pickBest('whiplash', [c(1, 'Ghost Dad', 1990), c(2, 'Whiplash', 2014)]);
  assert.equal(p?.best.id, 2);
});

// ── comparative, not absolute ────────────────────────────────────────────────

test('🔴 matching is COMPARATIVE — an ordinary short title is not rejected by an absolute floor', () => {
  // V1 used an absolute floor and it failed on ordinary two-word titles, so
  // nothing cleared the bar and real requests were refused.
  const p = pickBest('hook', [c(1, 'Hook', 1991), c(2, 'Captain Hook Documentary', 2019)]);
  assert.equal(p?.best.id, 1, 'the exact title must beat the longer one');
});

test('extra words on the candidate do not tie the exact match', () => {
  const p = pickBest('dune', [c(1, 'Dune: Part Two', 2024), c(2, 'Dune', 2021)]);
  assert.equal(p?.best.id, 2);
});

test('a near-tie is reported as contested rather than picked silently', () => {
  const p = pickBest('dune', [c(1, 'Dune', 2021), c(2, 'Dune', 1984)]);
  assert.equal(p?.contested, true, 'two identical titles must not be silently resolved');
});

test('a clear winner is not contested', () => {
  const p = pickBest('whiplash', [c(1, 'Whiplash', 2014), c(2, 'Ghost Dad', 1990)]);
  assert.equal(p?.contested, false);
});

// ── normalisation ────────────────────────────────────────────────────────────

test('case, punctuation and leading articles do not defeat a match', () => {
  assert.equal(matchScore('the office', 'The Office'), 1);
  assert.equal(matchScore('wall-e', 'WALL·E') > 0.4, true);
  assert.equal(matchScore("jojo's bizarre adventure", 'JoJos Bizarre Adventure'), 1);
});
