import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OllamaClient, TURN_TIMEOUT_MS } from '../src/llm.js';
import {
  failureReply,
  isModelTimeout,
  ModelTimeoutError,
  StillWorkingNotice,
  STILL_WORKING_AFTER_MS,
  stillWorkingText,
  type TimerSeam,
} from '../src/turn-notice.js';
import { MAX_TURN_TIMEOUT_MS, MIN_TURN_TIMEOUT_MS, parseTurnTimeout } from '../src/config.js';
import { testConfig } from './helpers.js';

/**
 * ══════════════════════════════════════════════════════════════════════════
 * THE DEFECT THESE EXIST FOR — MEASURED TWICE LIVE, 2026-08-26
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Jeff asked "Give me the other 14" and received NOTHING. No reply, no error, no
 * apology. He asked again twenty minutes later and received nothing again. The
 * model call was killed by its own timer, `fetch` threw, and the turn died
 * without saying a word — so a killed turn, a message that never arrived, and a
 * bot that had been switched off were all the same event to him.
 *
 * ── 🔴 WHY EACH ASSERTION HERE HAS A CONTROL BESIDE IT ───────────────────────
 *
 * This whole family of defects is *a check whose broken output and whose
 * meaningful output are the same output*. A test that asserts "the user was told
 * something" passes just as happily against a notice that fires on EVERY turn,
 * and a test that asserts "the timeout was named" passes against a `failureReply`
 * that names a timeout unconditionally. So every test below that asserts a
 * notice FIRED is paired with one that shows it does NOT fire when it should not,
 * and vice versa. An instrument that cannot report the negative has not been
 * shown to be measuring anything.
 */

/** A clock the test advances by hand, so nothing here waits on a real timer. */
function fakeTimers(): TimerSeam & { advance: (ms: number) => void; pending: () => number } {
  let next = 1;
  const scheduled = new Map<number, { fn: () => void; at: number }>();
  let now = 0;
  return {
    set(fn, ms) {
      const id = next++;
      scheduled.set(id, { fn, at: now + ms });
      return id;
    },
    clear(handle) {
      if (typeof handle === 'number') scheduled.delete(handle);
    },
    advance(ms) {
      now += ms;
      // Snapshot: a fired callback may schedule the next notice, and that one
      // must not fire in the same tick just because the map grew under us.
      for (const [id, s] of [...scheduled.entries()]) {
        if (s.at <= now) {
          scheduled.delete(id);
          s.fn();
        }
      }
    },
    pending: () => scheduled.size,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// THE DEATH: an abort is classified, and the sentence names it
// ──────────────────────────────────────────────────────────────────────────

test('🔴 a model call killed by its own timer throws a ModelTimeoutError, not a bare abort', async () => {
  const config = { ...testConfig(), llm: { ...testConfig().llm, turnTimeoutMs: 1_000 } };
  const client = new OllamaClient(config);

  // A server that accepts the request and never answers. The REAL abort path
  // runs here — `OllamaClient`'s own controller, its own timer, a live `fetch`
  // rejecting on the signal. Nothing about the classification is stubbed.
  const original = globalThis.fetch;
  globalThis.fetch = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const e = new Error('This operation was aborted');
        e.name = 'AbortError';
        reject(e);
      });
    })) as typeof globalThis.fetch;

  try {
    const err = await client.chat([{ role: 'user', content: 'give me the other 14' }], []).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(isModelTimeout(err), `expected a ModelTimeoutError, got ${String(err)}`);
    assert.equal((err as ModelTimeoutError).limitMs, 1_000);
    assert.ok((err as ModelTimeoutError).elapsedMs >= 900, 'it should report roughly the time it waited');
  } finally {
    globalThis.fetch = original;
  }
});

test('🔴 CONTROL: a failure that is NOT the timer stays itself', async () => {
  /**
   * Without this the classification above passes against a `catch` that labels
   * EVERY thrown thing a timeout — which would tell somebody with an unreachable
   * Ollama to "ask for a shorter list", the single most misleading sentence
   * available for that failure.
   */
  const config = { ...testConfig(), llm: { ...testConfig().llm, turnTimeoutMs: 60_000 } };
  const client = new OllamaClient(config);

  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.reject(
      Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' }) }),
    )) as typeof globalThis.fetch;

  try {
    const err = await client.chat([{ role: 'user', content: 'hi' }], []).then(
      () => null,
      (e: unknown) => e,
    );
    assert.equal(isModelTimeout(err), false, 'an unreachable model is not a turn timeout');
    assert.match((err as Error).message, /fetch failed/);
  } finally {
    globalThis.fetch = original;
  }
});

test('🔴 a body that stalls after the headers is aborted too — the timer used to end at the headers', async () => {
  /**
   * `fetch` resolves on HEADERS. `clearTimeout` sat in a `finally` around the
   * fetch alone, so a response whose body then stalled had NO deadline on it:
   * `res.json()` waits forever, the turn never returns, and the queue lane for
   * that person is never released. Silence, permanently, for one sender.
   */
  const config = { ...testConfig(), llm: { ...testConfig().llm, turnTimeoutMs: 1_000 } };
  const client = new OllamaClient(config);

  const original = globalThis.fetch;
  globalThis.fetch = ((_url: string, init?: RequestInit) =>
    Promise.resolve({
      ok: true,
      status: 200,
      // Headers are "in"; the body never arrives.
      json: () =>
        new Promise((_r, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('This operation was aborted');
            e.name = 'AbortError';
            reject(e);
          });
        }),
      text: () => Promise.resolve(''),
    })) as unknown as typeof globalThis.fetch;

  try {
    const err = await client.chat([{ role: 'user', content: 'hi' }], []).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(isModelTimeout(err), `a stalled body must time out, got ${String(err)}`);
  } finally {
    globalThis.fetch = original;
  }
});

test('🔴 the abort is classified from the SIGNAL, so another component AbortError is NOT a turn timeout', () => {
  const foreign = new Error('This operation was aborted');
  foreign.name = 'AbortError';

  assert.equal(
    isModelTimeout(foreign),
    false,
    'an AbortError from a tool\'s own AbortSignal.timeout must not be read as the turn budget expiring',
  );
  assert.equal(isModelTimeout(new ModelTimeoutError(901_000, TURN_TIMEOUT_MS)), true);
});

test('🔴 a timeout is TOLD as a timeout, and a generic failure is not', () => {
  const timedOut = failureReply(new ModelTimeoutError(901_000, 900_000));
  const generic = failureReply(new Error('EHOSTUNREACH 10.0.0.10:11434'));

  assert.match(timedOut, /too long|limit/i, 'the timeout reply must name the limit it hit');
  assert.match(timedOut, /shorter/i, 'and say the one thing that makes a retry work');
  assert.equal(timedOut.includes('15-minute'), true, 'and name the actual budget, from the error');

  // 🔴 THE CONTROL. Without it, a `failureReply` that returns the timeout
  // sentence for EVERYTHING passes every assertion above.
  assert.notEqual(generic, timedOut, 'a non-timeout failure must not be described as a timeout');
  assert.doesNotMatch(generic, /too long|shorter/i);
  assert.match(generic, /trying again/i, 'a generic failure is the one where retrying is sound advice');
});

test('the failure reply never carries the exception text', () => {
  const reply = failureReply(new Error('connect EHOSTUNREACH 10.0.0.10:8096 apikey=SECRET'));
  assert.doesNotMatch(reply, /10\.0\.0\.10|apikey|SECRET|EHOSTUNREACH/);
});

// ──────────────────────────────────────────────────────────────────────────
// THE WAIT: a long turn says so, a normal turn stays quiet
// ──────────────────────────────────────────────────────────────────────────

test('🔴 a turn that outlives the threshold tells the sender it is still alive', () => {
  const timers = fakeTimers();
  const sent: string[] = [];
  const notice = new StillWorkingNotice({
    notify: async (t) => {
      sent.push(t);
    },
    timers,
  });

  notice.arm();
  timers.advance(STILL_WORKING_AFTER_MS - 1);
  assert.deepEqual(sent, [], 'nothing before the threshold');

  timers.advance(1);
  assert.equal(sent.length, 1, 'the person is told the turn is still running');
  assert.equal(sent[0], stillWorkingText(0));
  assert.equal(notice.noticesSent, 1);
});

test('🔴 CONTROL: a turn that finishes before the threshold says NOTHING', () => {
  const timers = fakeTimers();
  const sent: string[] = [];
  const notice = new StillWorkingNotice({
    notify: async (t) => {
      sent.push(t);
    },
    timers,
  });

  notice.arm();
  timers.advance(STILL_WORKING_AFTER_MS - 1);
  notice.disarm();
  timers.advance(STILL_WORKING_AFTER_MS * 10);

  assert.deepEqual(sent, [], 'an ordinary turn must not text the person about itself');
  assert.equal(timers.pending(), 0, 'and must not leave a timer behind either');
});

test('🔴 a notice already queued when the turn ends is still not sent', () => {
  /**
   * `clear()` on a handle whose callback is already queued does not un-queue it,
   * so `disarm` cannot rely on the timer alone. This drives that exact order:
   * the callback runs AFTER `stopped` was set.
   */
  let fire: (() => void) | null = null;
  const timers: TimerSeam = {
    set(fn) {
      fire = fn;
      return 1;
    },
    clear() {
      /* deliberately inert — this is the "already queued" case */
    },
  };
  const sent: string[] = [];
  const notice = new StillWorkingNotice({
    notify: async (t) => {
      sent.push(t);
    },
    timers,
  });

  notice.arm();
  notice.disarm();
  assert.notEqual(fire, null, 'the test needs the callback it captured');
  fire!();

  assert.deepEqual(sent, [], 'a "still working" note after the turn ended is worse than none at all');
});

test('the notice repeats once and then stops — reassurance is bounded, the wait is not', () => {
  const timers = fakeTimers();
  const sent: string[] = [];
  const notice = new StillWorkingNotice({
    notify: async (t) => {
      sent.push(t);
    },
    timers,
  });

  notice.arm();
  // Stepped, not jumped: this fake clock schedules the NEXT notice from inside
  // the callback, so one big jump would only ever fire the first. Twelve steps
  // is deliberately far more than the cap, which is the point being asserted.
  for (let i = 0; i < 12; i++) timers.advance(STILL_WORKING_AFTER_MS);

  assert.equal(sent.length, 2, 'two notices, not one and not twelve');
  assert.notEqual(sent[0], sent[1], 'an identical line twice reads as a stuck loop');
  assert.equal(timers.pending(), 0, 'nothing is left scheduled after the last one');
});

test('a notify that throws is contained — it must never fail the turn', () => {
  const timers = fakeTimers();
  const logged: string[] = [];
  const notice = new StillWorkingNotice({
    notify: () => Promise.reject(new Error('send failed: BlueBubbles 500')),
    timers,
    log: (l) => logged.push(l),
  });

  notice.arm();
  assert.doesNotThrow(() => timers.advance(STILL_WORKING_AFTER_MS));
  assert.equal(notice.noticesSent, 1, 'the attempt is still counted — it is what the log token reports');
});

test('arm is idempotent: a second arm does not double the notices', () => {
  const timers = fakeTimers();
  const sent: string[] = [];
  const notice = new StillWorkingNotice({
    notify: async (t) => {
      sent.push(t);
    },
    timers,
  });

  notice.arm();
  notice.arm();
  notice.arm();
  timers.advance(STILL_WORKING_AFTER_MS);

  assert.equal(sent.length, 1);
});

test('🔴 the threshold sits above the ordinary turn — measured, not assumed', () => {
  /**
   * From `data/jedd.log`, 110 completed turns: 24.5% ran past 60s, 14.5% past
   * 120s, 7.3% past 180s, 2.7% past 240s. This pins the CHOICE, so that lowering
   * it to a value where the notice becomes the ordinary case is a deliberate act
   * with a red test in front of it rather than a tidy-up.
   */
  assert.ok(
    STILL_WORKING_AFTER_MS >= 180_000,
    'below ~180s the notice fires on more than one turn in fourteen and becomes noise',
  );
  assert.ok(STILL_WORKING_AFTER_MS < TURN_TIMEOUT_MS, 'it must fire while the turn is alive, not after it is killed');
});

// ──────────────────────────────────────────────────────────────────────────
// THE KNOB: it can be tuned, and nonsense cannot tune it to zero
// ──────────────────────────────────────────────────────────────────────────

test('🔴 an empty, garbage or zero LLM_TURN_TIMEOUT_MS falls BACK — it does not parse to a tiny timeout', () => {
  /**
   * The nonsense reading here is a timeout of 0: every turn killed the instant
   * it starts, on a build that looks configured. V1 learned the same lesson on
   * `OLLAMA_NUM_CTX`.
   */
  for (const bad of [undefined, '', '   ', 'soon', '0', '-5', 'NaN', 'null']) {
    assert.equal(parseTurnTimeout(bad), undefined, `${JSON.stringify(bad)} must fall back to the built-in`);
  }
});

test('a usable value is taken, and an out-of-range one is clamped rather than refused', () => {
  assert.equal(parseTurnTimeout('240000'), 240_000);
  assert.equal(parseTurnTimeout('1500.7'), 1_501, 'rounded, not truncated to something meaningless');
  assert.equal(parseTurnTimeout('5'), MIN_TURN_TIMEOUT_MS, 'clamped up: 5ms would kill every turn');
  assert.equal(parseTurnTimeout('999999999'), MAX_TURN_TIMEOUT_MS);
  // Clamped, never refused: a bad tuning knob must not trade a slow bot for no bot.
  assert.doesNotThrow(() => parseTurnTimeout('999999999'));
});
