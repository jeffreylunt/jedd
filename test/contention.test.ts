import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONTENTION_MS,
  MIN_LATENCY_SAMPLES,
  QBIT_ACTIVE_BYTES_PER_SEC,
  hostContentionVerdict,
  parseLatencySamples,
  parseQbitTransfer,
  recoveryVerdict,
  type LatencyReading,
} from '../src/safety.js';

/**
 * The diagnosis side of the safe-fix path.
 *
 * The rule these tests exist to hold: **UNKNOWN must never authorise the fix,
 * and UNKNOWN must never be reported as "nothing is wrong".** Those are two
 * separate failures. The first applies a write on no evidence; the second tells
 * a user their problem does not exist because we could not see it.
 */

/** Probe output in the exact shape the real curl loop emits. */
function probeLines(...secs: number[]): string {
  return secs.map((s) => `http=200 total=${s.toFixed(6)}`).join('\n');
}

// ── latency parsing ──────────────────────────────────────────────────────────

test('a healthy box parses to a median around 1 ms', () => {
  // These are REAL samples measured on hp on 2026-08-24, warm-up outliers included.
  const reading = parseLatencySamples(
    probeLines(0.021485, 0.017471, 0.001741, 0.001205, 0.005158, 0.001029, 0.001085, 0.001085),
    0,
  );
  assert.equal(reading.known, true);
  assert.ok(reading.medianMs < 5, `median was ${reading.medianMs} ms, expected well under 5`);
});

test('🔴 the MEDIAN survives the warm-up outliers that a single sample would report as contention', () => {
  // The first curl against Jellyfin measured 98.6 ms on a completely idle box.
  // A tool that sampled once would have called that contention and written to
  // the homelab on the strength of a cold connection.
  const single = parseLatencySamples(probeLines(0.098610), 0);
  assert.equal(single.known, false, 'one sample must never be enough to authorise anything');

  const many = parseLatencySamples(probeLines(0.098610, 0.001, 0.001, 0.0012, 0.0011, 0.001), 0);
  assert.equal(many.known, true);
  assert.ok(many.medianMs < CONTENTION_MS, `median ${many.medianMs} ms must stay under the threshold`);
});

test('🔴 real contention moves the median, so the statistic is not merely noise-proof', () => {
  // The inverting control for the test above: if the median could not detect
  // contention, "immune to outliers" would just mean "immune to everything".
  const contended = parseLatencySamples(probeLines(0.31, 0.28, 0.42, 0.33, 0.29, 0.38), 0);
  assert.equal(contended.known, true);
  assert.ok(contended.medianMs >= CONTENTION_MS, `median ${contended.medianMs} ms must clear the threshold`);
});

test('🔴 too few usable probes is UNKNOWN, never "fast"', () => {
  const short = parseLatencySamples(probeLines(0.001, 0.001), 0);
  assert.equal(short.known, false);
  assert.match(short.detail, /UNKNOWN/);

  // A failed probe is an ABSENT reading, not a slow one.
  const errors = `${probeLines(0.001, 0.001)}\nhttp=000 total=20.000000\nhttp=502 total=0.003000`;
  const mixed = parseLatencySamples(errors, 0);
  assert.equal(mixed.known, false, 'non-200 samples must not pad the count to reach the minimum');
});

test('🔴 a Jellyfin that is TIMING OUT must not read as fast because the good samples were fast', () => {
  // The case the test above could not see. Four clean 1 ms probes and three
  // 20-second timeouts: if non-200 lines were counted as timings, there would be
  // seven "samples", the count would clear the minimum, and the median of
  // [1,1,1,1,20000,20000,20000] is 1 ms — so a Jellyfin failing 3 requests in 7
  // would be reported as HEALTHY, and the contention check would wave it through.
  //
  // The earlier assertion could not distinguish this: its bad samples did not
  // push the count over the minimum, so it passed either way. That is a control
  // that cannot fail for the reason it exists.
  const partial =
    `${probeLines(0.001, 0.0011, 0.001, 0.0012)}\n` +
    'http=000 total=20.000000\nhttp=000 total=20.000000\nhttp=000 total=20.000000';
  const reading = parseLatencySamples(partial, 0);
  assert.equal(reading.known, false, 'four usable probes out of seven is UNKNOWN, not fast');

  // CONTROL: the same seven lines, all successful, DO parse — so the refusal is
  // about the failures and not about the sample count.
  const allGood = parseLatencySamples(probeLines(0.001, 0.0011, 0.001, 0.0012, 0.001, 0.001, 0.001), 0);
  assert.equal(allGood.known, true);
});

test('a non-zero exit from the probe itself is UNKNOWN', () => {
  const reading = parseLatencySamples(probeLines(0.001, 0.001, 0.001, 0.001, 0.001, 0.001), 1);
  assert.equal(reading.known, false);
});

test('CONTROL: enough clean samples DO parse, so the refusals above are about the input', () => {
  const ok = parseLatencySamples(probeLines(...new Array(MIN_LATENCY_SAMPLES).fill(0.001)), 0);
  assert.equal(ok.known, true);
});

// ── qBittorrent transfer parsing ─────────────────────────────────────────────

test('transfer/info parses the fields that matter', () => {
  // A real body from hp, trimmed.
  const raw = '{"connection_status":"connected","dl_info_speed":0,"up_info_speed":80581,"up_rate_limit":5242880}';
  const t = parseQbitTransfer(raw, 0);
  assert.equal(t.known, true);
  assert.equal(t.upBytesPerSec, 80581);
  assert.equal(t.downBytesPerSec, 0);
});

test('🔴 an unreachable qBittorrent API is UNKNOWN, never idle', () => {
  // The inventory records bridge-local traffic to 172.20.0.1:8080 returning 000
  // while the tunnel is healthy. Reading that as "qBittorrent is doing nothing"
  // concludes the opposite of the truth on a box that is being saturated.
  assert.equal(parseQbitTransfer('', 7).known, false);
  assert.equal(parseQbitTransfer('<html>404 not found</html>', 0).known, false);
  assert.equal(parseQbitTransfer('{"connection_status":"connected"}', 0).known, false);
});

// ── the combined verdict ─────────────────────────────────────────────────────

const FAST: LatencyReading = { known: true, medianMs: 1.1, samplesMs: [], detail: 'median 1.1 ms' };
const SLOW: LatencyReading = { known: true, medianMs: 310, samplesMs: [], detail: 'median 310.0 ms' };
const BLIND: LatencyReading = { known: false, medianMs: 0, samplesMs: [], detail: 'probe failed' };
const BUSY = { known: true, downBytesPerSec: 8 * 1024 * 1024, upBytesPerSec: 5 * 1024 * 1024, detail: 'busy' };
const IDLE = { known: true, downBytesPerSec: 0, upBytesPerSec: 80_581, detail: 'idle' };
const QBLIND = { known: false, downBytesPerSec: 0, upBytesPerSec: 0, detail: 'api unreachable' };

test('🔴 contention plus a busy qBittorrent is the ONLY combination that authorises the fix', () => {
  assert.equal(hostContentionVerdict(SLOW, BUSY).verdict, 'shed-warranted');

  // Every other combination must refuse.
  for (const [latency, qbit, expected] of [
    [FAST, BUSY, 'clear'],
    [FAST, IDLE, 'clear'],
    [SLOW, IDLE, 'qbit-not-the-cause'],
    [BLIND, BUSY, 'unknown'],
    [BLIND, IDLE, 'unknown'],
    [BLIND, QBLIND, 'unknown'],
    [SLOW, QBLIND, 'unknown'],
    [FAST, QBLIND, 'unknown'],
  ] as const) {
    assert.notEqual(
      hostContentionVerdict(latency, qbit).verdict,
      'shed-warranted',
      `${expected} must not authorise the fix`,
    );
    assert.equal(hostContentionVerdict(latency, qbit).verdict, expected);
  }
});

test('🔴 "I could not measure it" and "nothing is wrong" are DIFFERENT verdicts', () => {
  const blind = hostContentionVerdict(BLIND, BUSY);
  const clear = hostContentionVerdict(FAST, BUSY);
  assert.notEqual(blind.verdict, clear.verdict);
  assert.match(blind.detail, /Cannot measure|UNKNOWN|not able to tell/i);
  // And the clear verdict must say plainly that it MEASURED, so a user is never
  // told "nothing is wrong" by an instrument that saw nothing.
  assert.match(clear.detail, /measurement, not a failure to measure/i);
});

test('a blind qBittorrent cannot be waved through just because latency looked fine', () => {
  // The tempting shortcut: latency is fine, so who cares about qBit. But the
  // verdict is about whether we UNDERSTAND the box, and half an answer is not one.
  assert.equal(hostContentionVerdict(FAST, QBLIND).verdict, 'unknown');
});

test('the qBit activity threshold is a real boundary, checked from both sides', () => {
  const justUnder = { known: true, downBytesPerSec: QBIT_ACTIVE_BYTES_PER_SEC - 1, upBytesPerSec: 0, detail: 'x' };
  const justOver = { known: true, downBytesPerSec: QBIT_ACTIVE_BYTES_PER_SEC, upBytesPerSec: 0, detail: 'x' };
  assert.equal(hostContentionVerdict(SLOW, justUnder).verdict, 'qbit-not-the-cause');
  assert.equal(hostContentionVerdict(SLOW, justOver).verdict, 'shed-warranted');
});

test('either direction of transfer counts — a seeding box saturates the uplink', () => {
  const uploadOnly = { known: true, downBytesPerSec: 0, upBytesPerSec: 5 * 1024 * 1024, detail: 'x' };
  assert.equal(hostContentionVerdict(SLOW, uploadOnly).verdict, 'shed-warranted');
});

// ── the after-check ──────────────────────────────────────────────────────────

test('🔴 recovery is judged on the SYMPTOM and UNKNOWN is never success', () => {
  assert.equal(recoveryVerdict(SLOW, FAST).verdict, 'improved');
  assert.equal(recoveryVerdict(SLOW, SLOW).verdict, 'not-improved');
  assert.equal(recoveryVerdict(SLOW, BLIND).verdict, 'unknown');
  assert.equal(recoveryVerdict(BLIND, FAST).verdict, 'unknown');
});

test('a fix that did not help is NOT reported as success', () => {
  const r = recoveryVerdict(SLOW, SLOW);
  assert.equal(r.verdict, 'not-improved');
  assert.match(r.detail, /did NOT resolve/);
});
