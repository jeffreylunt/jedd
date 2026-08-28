import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  readsAsCapabilityDenial,
  SECOND_LOOK_NOTE,
  turnLicensedTheDenial,
} from '../src/capability-denial.js';

/**
 * EVERY turn in `data/audit.jsonl` at the time the guard was built, scrubbed of
 * handles, names, addresses and hosts.
 *
 * 🔴 ALL 262, NOT THE ONES A GREP ALREADY SELECTED — and that is the whole
 * reason the file is this big. The first version of this measurement labelled
 * only the 67 turns a wide "I can't" grep matched, and reported recall against
 * THAT population. It was wrong in a way the number could not show: the wide
 * grep itself missed a real denial ("For now I can only read the indexer
 * health, not change it"), so the denominator excluded a case the detector was
 * supposed to be judged on. A recall figure computed over a pre-filtered
 * population measures the filter, not the detector.
 *
 * `capabilityDenial` is a hand label over all 262: does the reply assert a limit
 * on JEDD'S INSTRUMENTS, rather than report the outcome of something it tried?
 * `verdict` is a second, harder judgement made by cross-referencing the registry
 * as it stood at that timestamp — was the assertion TRUE?
 */
const CORPUS: {
  at: string;
  role: string;
  capabilityDenial: boolean;
  verdict: 'false' | 'true' | 'identity' | 'n/a';
  whyFalse?: string;
  licensed: boolean;
  reply: string;
}[] = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/denial-corpus.json', import.meta.url)), 'utf8'),
);

/**
 * 🔴 THE TWO TURNS THE WHOLE THING EXISTS FOR, AND BOTH MUST FIRE.
 *
 * They are the two GENERATOR SHAPES, and a guard that catches only the first is
 * the failure this design was warned about: a defence covering one instance of a
 * class, described in words that imply it covers the class.
 *
 *  NAMED   — names a tool class. A registry cross-check could have caught it.
 *  UNNAMED — names nothing at all. A registry cross-check has no handle on it,
 *            and this is the one that cost Jeff a spurious feature request.
 */
const NAMED_SHAPE =
  "I can't — I have no write tool for Prowlarr, only read. I can't enable either indexer, and I " +
  "won't try to route around that.";
const UNNAMED_SHAPE =
  'I can only see live sessions, not watch history — and right now there\'s nobody playing ' +
  'anything (2 sessions connected, both idle). So I can\'t tell you whether <name> has watched ' +
  "anything, or even whether he's used the invite yet.\n\nIf you want to know what's been " +
  "watched, that's not something I can pull.";

test('🔴 THE UNNAMED SHAPE FIRES — the 2026-08-28 turn, which names no tool at all', () => {
  assert.equal(readsAsCapabilityDenial(UNNAMED_SHAPE), true);
  // The reason this case is the point: nothing in it is a tool name, so the
  // structural fix originally proposed on the defect task could not see it.
  const registry = ['homelab_read', 'jellyfin_sessions', 'library_search', 'find_gaps'];
  assert.equal(
    registry.some((name) => UNNAMED_SHAPE.includes(name)),
    false,
    'if this ever becomes true the fixture has been edited and stops testing the unnamed shape',
  );
});

test('the NAMED shape fires too — the 2026-08-26 Prowlarr turn', () => {
  assert.equal(readsAsCapabilityDenial(NAMED_SHAPE), true);
});

test('the 2026-08-24 add_season denial fires — the instance Jedd retracted itself', () => {
  assert.equal(
    readsAsCapabilityDenial(
      "And I don't have a tool to flip monitoring on for an existing season. So I can't get S3 " +
        'started for you from here.',
    ),
    true,
  );
});

/**
 * ⚠️ THE PRECISION CASES, AND WHY THEY ARE A SEPARATE TEST RATHER THAN A NUMBER.
 *
 * These are the honest replies the guard must NOT spend a model round on. Every
 * one of them says "I can't" — which is exactly why matching on the negation
 * alone is not good enough: it fires on 26% of real turns and most of those are
 * a truthful report of what a tool came back with.
 */
test('an OUTCOME report does not fire, however much it sounds like a refusal', () => {
  for (const honest of [
    "No channels are listed for it yet, so I can't say where to watch.",
    "The search timed out — that's a failure to look, not a finding that nothing exists, so I " +
      "can't tell you what's available for those episodes yet.",
    "I can't confirm that. The guide search for that window came back with no channels listed yet.",
    'Nothing came back — Prowlarr found no audiobook for that title.',
  ]) {
    assert.equal(readsAsCapabilityDenial(honest), false, `should not fire on: ${honest}`);
  }
});

test('MEASURED over all 262 real turns: what the detector actually does', () => {
  const fires = CORPUS.filter((t) => readsAsCapabilityDenial(t.reply));
  const labelled = CORPUS.filter((t) => t.capabilityDenial);
  const caught = fires.filter((t) => t.capabilityDenial);

  // Pinned so that widening the phrase list to chase one new phrasing cannot
  // quietly cost precision, and narrowing it cannot quietly cost recall.
  assert.equal(CORPUS.length, 262, 'the corpus is the whole log, not a grep of it');
  assert.equal(labelled.length, 35, '35 of 262 turns assert a limit on Jedd’s instruments');

  const recall = caught.length / labelled.length;
  const precision = caught.length / fires.length;
  const triggerRate = fires.length / CORPUS.length;

  assert.ok(recall >= 0.75, `recall ${(recall * 100).toFixed(0)}% — was 79% when measured`);
  assert.ok(precision >= 0.85, `precision ${(precision * 100).toFixed(0)}% — was 93% when measured`);
  // 🔴 THE COST LINE. Every fire is one extra model round, and on this hardware
  // that is tens of seconds. If a future edit pushes this past a fifth of all
  // turns, the guard has stopped being cheap and that is a decision for Jeff,
  // not something to discover from the latency.
  assert.ok(
    triggerRate <= 0.2,
    `fires on ${(triggerRate * 100).toFixed(0)}% of turns — was 11% when measured`,
  );
});

test('🔴 every denial CONFIRMED FALSE against the registry is caught — this is the bug', () => {
  const falseDenials = CORPUS.filter((t) => t.verdict === 'false');
  assert.equal(falseDenials.length, 12, 'twelve turns denied a capability the registry held');
  const missed = falseDenials.filter((t) => !readsAsCapabilityDenial(t.reply));
  assert.deepEqual(
    missed.map((t) => t.at),
    [],
    `false denials the detector would let through: ${missed.map((t) => t.reply.slice(0, 80))}`,
  );
});

/**
 * ⚠️ A TEST THAT ASSERTS THE GUARD'S OWN BLIND SPOT, ON PURPOSE.
 *
 * A phrase list cannot catch a register. This pins one paraphrase it genuinely
 * misses, so nobody reads the numbers above as coverage of the class. If someone
 * later widens the list and this flips, that is fine — DELETE this test and say
 * so; do not let it pass by accident and leave the comment claiming a blind spot
 * that is no longer there.
 */
test('KNOWN BLIND SPOT: a paraphrase with no capability vocabulary walks straight past', () => {
  assert.equal(
    readsAsCapabilityDenial("<name>'s viewing simply isn't visible from where I'm sitting."),
    false,
    'documented limitation — the detector is lexical and fails OPEN, leaving the turn as it is today',
  );
});

test('the identity denials are NOT this guard’s job and are left alone', () => {
  // "I can't tell who I'm talking to over here" was a different defect, fixed at
  // its root by stating the role as a fact in the system prompt. Catching it
  // here would have been a second guard masking the first — neither could then
  // be shown to work on its own.
  const identity = CORPUS.filter((t) => t.verdict === 'identity');
  assert.equal(identity.length, 2);
});

test('a turn where a tool FAILED or was REFUSED is licensed, and is left alone', () => {
  assert.equal(turnLicensedTheDenial([{ ok: false }]), true);
  assert.equal(turnLicensedTheDenial([{ ok: false, refused: true }]), true);
  assert.equal(turnLicensedTheDenial([{ ok: true }, { ok: false }]), true);
  // The defect's shape: every tool this turn succeeded, and the denial rests on
  // nothing but the model's belief about its own list.
  assert.equal(turnLicensedTheDenial([{ ok: true }]), false);
  assert.equal(turnLicensedTheDenial([]), false);
});

test('the note tells the model to LOOK, and never that it is wrong', () => {
  // If it asserted the denial was mistaken, a compliant model would manufacture
  // a capability rather than check for one — turning a guard against a wrong
  // sentence into a generator of them.
  assert.match(SECOND_LOOK_NOTE, /read your tool list again/i);
  assert.match(SECOND_LOOK_NOTE, /say the same thing again/i);
  assert.doesNotMatch(SECOND_LOOK_NOTE, /you are wrong|you're wrong|probably wrong/i);
  // And it must name the inference that produced the 2026-08-28 failure: a tool
  // result bounding the tool, not the system.
  assert.match(SECOND_LOOK_NOTE, /describes THAT TOOL/);
});
