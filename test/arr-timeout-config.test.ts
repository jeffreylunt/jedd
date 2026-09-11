import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  loadConfig,
  MAX_ARR_TIMEOUT_MS,
  MIN_ARR_TIMEOUT_MS,
  parseArrTimeout,
} from '../src/config.js';

/**
 * ══════════════════════════════════════════════════════════════════════════
 * THE DEFECT THESE EXIST FOR — MEASURED ONCE LIVE, 2026-08-31
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Issue #19: a user asked Jedd to download *Better Off Dead*. `catalogue_search`
 * reached Sonarr but RADARR at 192.168.1.7:7878 timed out after 20s — the
 * `ArrClient` constructor's hardcoded fallback. The follow-up `add_movie` then
 * failed with *"A valid tmdbId is required"* because no search result came back.
 *
 * The fail-fast breaker from fix #1 already short-circuits the SECOND and THIRD
 * calls against an unreachable service. What's missing is the OPERATOR knob —
 * the 20s was a guess at what a slow LAN arr looks like, and a deployment with
 * a slower or more contended network cannot shorten it without a source edit.
 *
 * `ARR_TIMEOUT_MS` is the answer: it threads through `Config.sonarr.timeoutMs`
 * and `Config.radarr.timeoutMs`, both of which `ArrClient` already accepts
 * (the existing `{ ...ctx.config.sonarr, fetchImpl }` spread is the wiring).
 * Garbage falls back silently to 20s, so the assertion that pins this is the
 * SAME one `parseTurnTimeout` carries in turn-notice.test.ts.
 */

test('🔴 empty, garbage or zero ARR_TIMEOUT_MS falls BACK — it does not parse to a tiny timeout', () => {
  // The nonsense reading here would be a 1ms first call against an arr the
  // breaker was supposed to protect, and the model would learn
  // "RADARR IS UNREACHABLE" on every single `catalogue_search` while Radarr
  // was fine — the failure wearing the wrong coat.
  for (const bad of [undefined, '', '   ', 'soon', '0', '-5', 'NaN', 'null', '20s']) {
    assert.equal(parseArrTimeout(bad), undefined, `${JSON.stringify(bad)} must fall back to the built-in 20s`);
  }
});

test('a usable value is taken, and an out-of-range one is clamped rather than refused', () => {
  assert.equal(parseArrTimeout('30000'), 30_000);
  assert.equal(parseArrTimeout('1500.7'), 1_501, 'rounded, not truncated to something meaningless');
  assert.equal(parseArrTimeout('5'), MIN_ARR_TIMEOUT_MS, 'clamped up: 5ms would never reach a LAN arr');
  assert.equal(parseArrTimeout('99999999'), MAX_ARR_TIMEOUT_MS);
  // Clamped, never refused: a bad tuning knob must not trade a slow bot for no bot.
  assert.doesNotThrow(() => parseArrTimeout('99999999'));
});

test('🔴 loadConfig threads ARR_TIMEOUT_MS into BOTH sonarr and radarr — one knob, two services', () => {
  // The single env var governs both because they share the client and the
  // failure mode. The control that proves the thread: setting the knob
  // changes BOTH config fields, and unsetting it leaves BOTH undefined.
  const saved = process.env['ARR_TIMEOUT_MS'];
  try {
    process.env['ARR_TIMEOUT_MS'] = '35000';
    const cfg = loadConfig();
    assert.equal(cfg.sonarr.timeoutMs, 35_000, 'sonarr.timeoutMs must follow ARR_TIMEOUT_MS');
    assert.equal(cfg.radarr.timeoutMs, 35_000, 'radarr.timeoutMs must follow ARR_TIMEOUT_MS — same client, same knob');

    delete process.env['ARR_TIMEOUT_MS'];
    const absent = loadConfig();
    assert.equal(absent.sonarr.timeoutMs, undefined, 'unset means undefined — ArrClient falls back to its 20s');
    assert.equal(absent.radarr.timeoutMs, undefined, 'unset on BOTH sides, not just one');
  } finally {
    if (saved === undefined) delete process.env['ARR_TIMEOUT_MS'];
    else process.env['ARR_TIMEOUT_MS'] = saved;
  }
});

test('🔴 garbage ARR_TIMEOUT_MS at boot does NOT crash — it falls back and the deploy still starts', () => {
  // Same fall-back-on-garbage discipline as LLM_TURN_TIMEOUT_MS (issue with
  // `OLLAMA_NUM_CTX` in V1): the nonsense reading would be a 1ms first call
  // against every arr, and the operator would see RADARR IS UNREACHABLE on a
  // working install. `loadConfig` must not throw, must not coerce, and must
  // leave both fields undefined so ArrClient picks up its built-in 20s.
  const saved = process.env['ARR_TIMEOUT_MS'];
  try {
    for (const bad of ['', 'soon', '0', '-5', '20s', 'NaN']) {
      process.env['ARR_TIMEOUT_MS'] = bad;
      const cfg = loadConfig();
      assert.equal(cfg.sonarr.timeoutMs, undefined, `${JSON.stringify(bad)} must leave sonarr.timeoutMs undefined`);
      assert.equal(cfg.radarr.timeoutMs, undefined, `${JSON.stringify(bad)} must leave radarr.timeoutMs undefined`);
    }
  } finally {
    if (saved === undefined) delete process.env['ARR_TIMEOUT_MS'];
    else process.env['ARR_TIMEOUT_MS'] = saved;
  }
});

test('CONTROL: an out-of-range ARR_TIMEOUT_MS is CLAMPED, not refused — a slow bot beats no bot', () => {
  // Refusing to boot over an arr timeout would be a worse outage than the
  // slow lookup the knob exists to shorten. Same call as `parseTurnTimeout`.
  const saved = process.env['ARR_TIMEOUT_MS'];
  try {
    process.env['ARR_TIMEOUT_MS'] = '5';
    const tooSmall = loadConfig();
    assert.equal(tooSmall.sonarr.timeoutMs, MIN_ARR_TIMEOUT_MS);
    assert.equal(tooSmall.radarr.timeoutMs, MIN_ARR_TIMEOUT_MS);

    process.env['ARR_TIMEOUT_MS'] = '999999999';
    const tooBig = loadConfig();
    assert.equal(tooBig.sonarr.timeoutMs, MAX_ARR_TIMEOUT_MS);
    assert.equal(tooBig.radarr.timeoutMs, MAX_ARR_TIMEOUT_MS);
  } finally {
    if (saved === undefined) delete process.env['ARR_TIMEOUT_MS'];
    else process.env['ARR_TIMEOUT_MS'] = saved;
  }
});
