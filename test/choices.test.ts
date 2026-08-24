import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CHOICE_TTL_MS, ChoiceStore } from '../src/choices.js';

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'jedd-choice-')), 'choices.jsonl');
}

const OPTIONS = [
  { n: 1, label: 'Dune (2021)', value: { tmdbId: 438631 } },
  { n: 2, label: 'Dune (1984)', value: { tmdbId: 841 } },
  { n: 3, label: 'Dune: Part Two (2024)', value: { tmdbId: 693134 } },
];

function present(store: ChoiceStore, handle = '+18015550123', now?: Date) {
  return store.present({
    senderHandle: handle,
    subject: 'Dune',
    kind: 'movie-disambiguation',
    options: OPTIONS,
    now,
  });
}

// ── the defect this exists for ───────────────────────────────────────────────

test('🔴 a list presented in one turn is resolvable by a bare ordinal in the NEXT — across a restart', () => {
  // V1 opened a new conversation id per inbound message, so "Number 1 is great"
  // arrived in a session that had never seen the list: "I lost track of those
  // options." The restart here is the stand-in for that discontinuity.
  const path = tempFile();
  present(new ChoiceStore(path));

  const afterRestart = new ChoiceStore(path);
  const r = afterRestart.resolve('+18015550123', 1);
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error('unreachable');
  assert.deepEqual(r.option.value, { tmdbId: 438631 });
});

test('🔴 resolution returns the stored OBJECT, never a re-parse of the label', () => {
  const store = new ChoiceStore(tempFile());
  present(store);
  const r = store.resolve('+18015550123', 3);
  if (!r.ok) throw new Error('expected a resolution');
  assert.deepEqual(r.option.value, { tmdbId: 693134 }, 'the id must come from the store, not the text');
});

// ── every failure path re-asks and never guesses ─────────────────────────────

test('🔴 no list waiting → re-ask, never a fabricated pick', () => {
  const r = new ChoiceStore(tempFile()).resolve('+18015550123', 1);
  assert.equal(r.ok, false);
  if (r.ok) throw new Error('unreachable');
  assert.equal(r.reason, 'none');
  assert.match(r.detail, /do not guess/i);
});

test('🔴 an EXPIRED list is refused rather than picked from', () => {
  const path = tempFile();
  const store = new ChoiceStore(path);
  const t0 = new Date('2026-08-24T10:00:00Z');
  present(store, '+18015550123', t0);
  const justAfter = new Date(t0.getTime() + CHOICE_TTL_MS + 1);
  const r = store.resolve('+18015550123', 1, justAfter);
  assert.equal(r.ok, false);
  if (r.ok) throw new Error('unreachable');
  assert.equal(r.reason, 'expired');
});

test('a list just inside the TTL still resolves — the control for expiry', () => {
  // Without this, "expired" would be equally consistent with the store never
  // resolving anything.
  const store = new ChoiceStore(tempFile());
  const t0 = new Date('2026-08-24T10:00:00Z');
  present(store, '+18015550123', t0);
  const justBefore = new Date(t0.getTime() + CHOICE_TTL_MS - 1000);
  assert.equal(store.resolve('+18015550123', 1, justBefore).ok, true);
});

test('🔴 an out-of-range ordinal names the real options instead of picking one', () => {
  const store = new ChoiceStore(tempFile());
  present(store);
  const r = store.resolve('+18015550123', 9);
  assert.equal(r.ok, false);
  if (r.ok) throw new Error('unreachable');
  assert.equal(r.reason, 'out-of-range');
  assert.match(r.detail, /Dune \(2021\)/);
});

// ── isolation and replacement ────────────────────────────────────────────────

test("🔴 one person's list cannot be resolved by another person", () => {
  const store = new ChoiceStore(tempFile());
  present(store, '+18015550123');
  assert.equal(store.resolve('+18015559999', 1).ok, false);
});

test('a new list REPLACES the old one for that sender', () => {
  // Two live lists would make a bare "2" ambiguous with no honest way to choose.
  const store = new ChoiceStore(tempFile());
  present(store);
  store.present({
    senderHandle: '+18015550123',
    subject: 'Whiplash',
    kind: 'movie-disambiguation',
    options: [{ n: 1, label: 'Whiplash (2014)', value: { tmdbId: 244786 } }],
  });
  const r = store.resolve('+18015550123', 1);
  if (!r.ok) throw new Error('expected a resolution');
  assert.equal(r.choice.subject, 'Whiplash');
  assert.equal(store.resolve('+18015550123', 3).ok, false, 'the old 3-option list is gone');
});

test('resolving does NOT consume the list — people change their minds', () => {
  // "Actually, number 2." A store that consumed on first use would break the
  // second pick. Idempotency for a repeated pick belongs in the acting tool,
  // whose outcome enum already separates ALREADY_HAVE from STARTED.
  const store = new ChoiceStore(tempFile());
  present(store);
  assert.equal(store.resolve('+18015550123', 1).ok, true);
  assert.equal(store.resolve('+18015550123', 2).ok, true);
});

test('clear() forgets the list, and survives a restart', () => {
  const path = tempFile();
  const store = new ChoiceStore(path);
  present(store);
  store.clear('+18015550123');
  assert.equal(store.resolve('+18015550123', 1).ok, false);
  assert.equal(new ChoiceStore(path).resolve('+18015550123', 1).ok, false);
});

test('pending() reports what is waiting, and nothing once expired', () => {
  const store = new ChoiceStore(tempFile());
  const t0 = new Date('2026-08-24T10:00:00Z');
  present(store, '+18015550123', t0);
  assert.equal(store.pending('+18015550123', t0)?.subject, 'Dune');
  assert.equal(store.pending('+18015550123', new Date(t0.getTime() + CHOICE_TTL_MS + 1)), undefined);
});
