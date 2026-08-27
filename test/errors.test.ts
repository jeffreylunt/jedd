import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeError, MAX_ERROR_CHARS, redactUrlSecrets } from '../src/errors.js';

/**
 * 🔴 THE BUG THIS FILE EXISTS FOR: Jedd told Jeff his homelab reads were failing
 * with "fetch failed" and called it transient for an evening. Every call was
 * returning EHOSTUNREACH — a permission denial that names itself — and the code
 * threw it away, because Node puts it in `e.cause` and nothing read `.cause`.
 *
 * The shapes below are the REAL ones, copied off a live failure on 2026-08-26,
 * not invented.
 */

/** Exactly what `fetch()` throws when the LAN peer is unreachable. */
function realFetchFailure(): Error {
  const cause = Object.assign(new Error('connect EHOSTUNREACH 10.0.0.10:8096 - Local (10.0.0.20:53132)'), {
    code: 'EHOSTUNREACH',
    syscall: 'connect',
    address: '10.0.0.10',
    port: 8096,
  });
  return Object.assign(new Error('fetch failed'), { cause });
}

test('🔴 the CAUSE survives — "fetch failed" alone names nothing', () => {
  const out = describeError(realFetchFailure());
  assert.match(out, /EHOSTUNREACH/, 'the diagnosis was discarded, which is the original bug');
});

test('the useless outer message is not all that is kept', () => {
  // Its own test: something could match EHOSTUNREACH above and still have
  // dropped the readable sentence that tells a person what to do.
  const out = describeError(realFetchFailure());
  assert.match(out, /10\.0\.0\.10/, 'the address is what makes it actionable');
});

test('🔴 message is NON-ENUMERABLE, so a naive serialiser silently loses it', () => {
  // The trap, asserted rather than trusted: JSON.stringify keeps `cause.code`
  // (enumerable) and drops `message`, so the output LOOKS populated while
  // missing the sentence. This is why describeError reads fields by name.
  assert.equal(JSON.stringify(new Error('fetch failed')), '{}');
  assert.match(describeError(new Error('fetch failed')), /fetch failed/);
});

test('a cause chain is walked, not just one level', () => {
  const deep = Object.assign(new Error('outer'), {
    cause: Object.assign(new Error('middle'), { cause: Object.assign(new Error('inner'), { code: 'ECONNRESET' }) }),
  });
  const out = describeError(deep);
  assert.match(out, /outer/);
  assert.match(out, /ECONNRESET/);
});

test('a self-referential cause terminates instead of hanging', () => {
  const loop = new Error('round') as Error & { cause?: unknown };
  loop.cause = loop;
  assert.match(describeError(loop), /round/);
});

test('a thrown non-Error still produces something readable', () => {
  assert.match(describeError('just a string'), /just a string/);
  assert.match(describeError(null), /unknown error|null/);
});

test('🔴 the output is BOUNDED — diagnostics must not become a paragraph', () => {
  const huge = new Error('x'.repeat(5000));
  assert.ok(describeError(huge).length <= MAX_ERROR_CHARS, 'an unbounded error string lands in every turn record');
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 REDACTION — error causes quote URLs, and URLs here carry API keys
// ─────────────────────────────────────────────────────────────────────────────

test('🔴 an api key in a failing URL is not written down', () => {
  const out = redactUrlSecrets('could not reach http://arr.invalid/api/v3/queue?apikey=SECRET123&page=1');
  assert.doesNotMatch(out, /SECRET123/, 'a credential reached a persisted diagnostic');
  assert.match(out, /apikey=REDACTED/);
});

test('CONTROL: redaction keeps the part that makes the error useful', () => {
  // A redactor that eats the diagnostics is its own failure — the recorded trap
  // is a substring scrubber that removes the thing you needed to read.
  const out = redactUrlSecrets('could not reach http://arr.invalid/api/v3/queue?apikey=SECRET123: EHOSTUNREACH');
  assert.match(out, /EHOSTUNREACH/);
  assert.match(out, /arr\.invalid/);
  assert.match(out, /page|queue/);
});

test('a token header is redacted too, not only a query parameter', () => {
  assert.doesNotMatch(redactUrlSecrets('X-Emby-Token: abc123def'), /abc123def/);
});

test('🔴 describeError applies the redactor it is given', () => {
  const e = Object.assign(new Error('fetch failed'), {
    cause: new Error('connect to http://arr.invalid/api?apikey=LEAKME'),
  });
  assert.doesNotMatch(describeError(e, redactUrlSecrets), /LEAKME/);
});
