import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { describeError } from '../src/errors.js';
import { OllamaClient, TURN_TIMEOUT_MS } from '../src/llm.js';
import {
  failureReply,
  FAILURE_REPLY_TIMEOUT_MS,
  isModelTimeout,
  MAX_NOTICES,
  ModelTimeoutError,
  sendFailureWithTimeout,
  StillWorkingNotice,
  parseStillWorkingMs,
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
    /**
     * 🔴 THE UNDERLYING REJECTION SURVIVES, AND ONLY THIS ASSERTION PROVES IT.
     * A mutation dropping the `cause` argument in `llm.ts` left every other test
     * here green: the cause test beside this one builds the error by hand and so
     * never exercises the throw site at all. If the socket dies with ECONNRESET
     * in the same tick the timer fires, this field is the ONLY place the real
     * diagnosis exists — `main.ts` logs `.message`, which is now synthetic.
     */
    assert.ok((err as ModelTimeoutError).cause instanceof Error, 'the replaced error was thrown away');
    assert.equal(((err as ModelTimeoutError).cause as Error).name, 'AbortError');
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

test("🔴 a FOREIGN AbortError is not this turn's timeout — the mutation that named it e.name survived until this existed", async () => {
  /**
   * 🔴 THIS TEST EXISTS BECAUSE A MUTATION SURVIVED WITHOUT IT.
   *
   * Rewriting the classification from `controller.signal.aborted` to
   * `e.name === 'AbortError'` — the wrong test, and the tempting one — left the
   * whole file green. Asserting `isModelTimeout(someAbortError) === false` on a
   * bare object never reaches `OllamaClient`, so it proved nothing about the
   * branch that actually runs.
   *
   * Tools here (`indexer-admin`, the arr fetches, `probeLlm`) run their own
   * `AbortSignal.timeout`. Under the mutation, a five-second indexer probe
   * aborting mid-turn would be reported to the sender as "that ran past my
   * 15-minute limit, ask for a shorter list".
   */
  const config = { ...testConfig(), llm: { ...testConfig().llm, turnTimeoutMs: 600_000 } };
  const client = new OllamaClient(config);

  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    // Aborted by SOMETHING ELSE: the turn's own controller is untouched and its
    // 600s timer has not come close to firing.
    const e = new Error('This operation was aborted');
    e.name = 'AbortError';
    return Promise.reject(e);
  }) as typeof globalThis.fetch;

  try {
    const err = await client.chat([{ role: 'user', content: 'hi' }], []).then(
      () => null,
      (e: unknown) => e,
    );
    assert.equal(
      isModelTimeout(err),
      false,
      "an AbortError this controller did not cause must not be reported as the turn's budget expiring",
    );
    assert.match(failureReply(err), /trying again/i, 'and the sender gets the generic advice, not "ask for a shorter list"');
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
  /**
   * 🔴 A THREE-SECOND BUDGET MUST NOT ANNOUNCE ITSELF AS A "1-minute limit".
   * That is the configuration a live control of this path runs under, and a
   * rounded floor would have sent Jeff a false sentence to prove a true one.
   */
  assert.match(failureReply(new ModelTimeoutError(3_100, 3_000)), /3-second limit/);
  assert.match(failureReply(new ModelTimeoutError(61_000, 60_000)), /60-second limit/);
  assert.match(failureReply(new ModelTimeoutError(241_000, 240_000)), /4-minute limit/);

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

test('🔴 the notices keep coming on a DOUBLING gap, four times, then stop', () => {
  /**
   * This was two notices on a fixed gap and that was wrong. `presence.ts` sizes
   * the typing ceiling at `TURN_TIMEOUT_MS * MAX_STEPS` — two hours — because a
   * real turn was measured at 787 seconds. Two fixed notices covered the first
   * eight minutes of that and then went silent, which is the defect again with a
   * longer fuse.
   */
  const timers = fakeTimers();
  const sent: string[] = [];
  const notice = new StillWorkingNotice({
    notify: async (t) => {
      sent.push(t);
    },
    timers,
  });

  const T = STILL_WORKING_AFTER_MS;
  notice.arm();

  timers.advance(T - 1);
  assert.equal(sent.length, 0, 'nothing before the first threshold');
  timers.advance(1);
  assert.equal(sent.length, 1, `first at ${T}ms`);

  // The gap DOUBLES: the second is 2T after the first, not T.
  timers.advance(T);
  assert.equal(sent.length, 1, 'the second must not arrive on the original gap');
  timers.advance(T);
  assert.equal(sent.length, 2, 'second at 3T');

  timers.advance(4 * T);
  assert.equal(sent.length, 3, 'third at 7T');
  timers.advance(8 * T);
  assert.equal(sent.length, 4, 'fourth at 15T');

  // And then it stops, however long the turn runs.
  for (let i = 0; i < 40; i++) timers.advance(16 * T);
  assert.equal(sent.length, MAX_NOTICES, 'bounded at the cap, no matter how long the turn runs');
  assert.equal(timers.pending(), 0, 'and nothing is left scheduled');
  assert.equal(new Set(sent.slice(0, 3)).size, 3, 'the first three say different things');
});

test('🔴 the clock counts from when they TEXTED, not from when the turn started', () => {
  /**
   * The queue serialises per sender, so a message sent while a turn is in flight
   * waits for that turn (790s, measured), then a settle, then its own turn.
   * Arming from turn start understates that wait by a whole turn — on the
   * message most likely to feel ignored, which is the second one.
   */
  const timers = fakeTimers();
  const sent: string[] = [];
  const notice = new StillWorkingNotice({
    notify: async (t) => {
      sent.push(t);
    },
    timers,
  });

  // It has already been queued for all but one second of the threshold.
  notice.arm(STILL_WORKING_AFTER_MS - 1_000);
  timers.advance(999);
  assert.equal(sent.length, 0);
  timers.advance(1);
  assert.equal(sent.length, 1, 'the notice is due almost immediately, because the person has already waited');
});

test('🔴 CONTROL: a message that did NOT wait in the queue gets the full threshold', () => {
  const timers = fakeTimers();
  const sent: string[] = [];
  const notice = new StillWorkingNotice({
    notify: async (t) => {
      sent.push(t);
    },
    timers,
  });

  notice.arm(0);
  timers.advance(STILL_WORKING_AFTER_MS - 1);
  assert.deepEqual(sent, [], 'without a queue wait, nothing is owed before the threshold');
});

test('🔴 maxNotices: 0 sends NONE — a cap that cannot express "none" is not a cap', () => {
  const timers = fakeTimers();
  const sent: string[] = [];
  const notice = new StillWorkingNotice({
    notify: async (t) => {
      sent.push(t);
    },
    timers,
    maxNotices: 0,
  });

  notice.arm();
  for (let i = 0; i < 10; i++) timers.advance(STILL_WORKING_AFTER_MS);
  assert.deepEqual(sent, [], 'the cap was only checked when RESCHEDULING, so zero used to send one');
  assert.equal(timers.pending(), 0);
});

test('re-arming after the cap is spent does not buy another notice', () => {
  const timers = fakeTimers();
  const sent: string[] = [];
  const notice = new StillWorkingNotice({
    notify: async (t) => {
      sent.push(t);
    },
    timers,
    maxNotices: 1,
  });

  notice.arm();
  timers.advance(STILL_WORKING_AFTER_MS);
  assert.equal(sent.length, 1);
  notice.arm();
  for (let i = 0; i < 5; i++) timers.advance(STILL_WORKING_AFTER_MS * 4);
  assert.equal(sent.length, 1, 'the cap belongs to the turn, not to the current timer');
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

test('🔴 JEDD_STILL_WORKING_MS falls back on nonsense — a threshold of 0 texts everybody on every turn', () => {
  for (const bad of [undefined, '', '  ', 'later', '0', '-1', 'NaN']) {
    assert.equal(parseStillWorkingMs(bad), undefined, `${JSON.stringify(bad)} must fall back`);
  }
  assert.equal(parseStillWorkingMs('5000'), 5_000);
  assert.equal(parseStillWorkingMs('10'), 1_000, 'floored: 10ms would fire on literally every turn');
  // Not clamped at the top — a very large value coherently means "never".
  assert.equal(parseStillWorkingMs('99999999'), 99_999_999);
});

test('🔴 the error the timeout REPLACED is kept on `cause` — errors.ts exists because one was thrown away', () => {
  const real = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  const timeout = new ModelTimeoutError(901_000, 900_000, real);
  assert.equal(timeout.cause, real);
  // And it is reachable the way this codebase reads causes.
  assert.match(describeError(timeout), /ECONNRESET|socket hang up/);
});

test('the budget is described in a unit that is TRUE, at every value', () => {
  assert.equal(failureReply(new ModelTimeoutError(1, 900_000)).includes('15-minute'), true);
  assert.equal(failureReply(new ModelTimeoutError(1, 240_000)).includes('4-minute'), true);
  // 🔴 150s is two and a half minutes. Rounding renders "3-minute", which is the
  // same class of lie this function was written to stop.
  assert.equal(failureReply(new ModelTimeoutError(1, 150_000)).includes('150-second'), true);
  assert.equal(failureReply(new ModelTimeoutError(1, 3_000)).includes('3-second'), true);
});

// ──────────────────────────────────────────────────────────────────────────
// THE WIRING. The tests above prove the parts work, not that anything calls them.
// ──────────────────────────────────────────────────────────────────────────

test('🔴 the shipped turn body disarms the notice BEFORE it sends, and apologises with failureReply', async () => {
  /**
   * A source scan, in the style of the SIGTERM one in
   * `bluebubbles-presence.test.ts`, because this wiring is what no unit test can
   * reach. The whole argument that a "still working" note cannot land AFTER the
   * answer is an ORDERING in `main.ts` — arm and disarm around `agent.handle`,
   * with `connector.send` outside them. Moving `notice.disarm()` below the send
   * leaves every other test in this file green and reintroduces the one
   * user-visible failure that would be embarrassing to ship.
   */
  const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const body = main.slice(main.indexOf('const handleBurst ='), main.indexOf('🔴 EVERY INBOUND MESSAGE GOES THROUGH THE QUEUE'));
  assert.ok(body.length > 0, 'the turn body could not be located — this scan is now measuring nothing');

  const arm = body.indexOf('notice.arm(');
  const disarm = body.indexOf('notice.disarm()');
  const send = body.indexOf('connector.send(message.senderHandle, r.replyText');
  assert.ok(arm >= 0, 'nothing arms the still-working notice');
  assert.ok(disarm >= 0, 'nothing disarms it');
  assert.ok(send >= 0, 'the reply send could not be found — this scan is measuring nothing');
  assert.ok(arm < disarm, 'the notice is disarmed before it is armed');
  assert.ok(disarm < send, 'the notice is disarmed AFTER the reply is sent — a note can land after the answer');

  // And the failure path says something, using the classifier rather than a literal.
  assert.match(body, /failureReply\(e\)/, 'the turn catch no longer names the failure reply');
  assert.match(
    body,
    /sendFailureWithTimeout\(/,
    'the catch must use the bounded, fire-and-forget failure-reply helper — a bare connector.send inherits the turn\'s controller',
  );
  // ⚠️ Plain, not anchored. The catch's send closure is `(handle, text) => connector.send(handle, text)` —
  // exactly two arguments. Passing `message.sourceGuid` to it would route the
  // apology through BlueBubbles' Private API, which can stall 120s and then 500 —
  // exactly the failure mode this catch exists for.
  assert.match(
    body,
    /=>\s*connector\.send\(\s*handle,\s*text\s*\)/,
    'the catch\'s send closure is `(handle, text) => connector.send(handle, text)` — three-arg forms route through the Private API',
  );
  assert.equal(
    /connector\.send\(\s*handle,\s*text\s*,\s*handle\.senderHandle/.test(body),
    false,
    'a closure that captures `message.sourceGuid` would re-introduce anchoring on the failure path',
  );
  assert.ok(
    body.indexOf('notice.arm(') < body.indexOf('failureReply(e)'),
    'the catch must come after the arm — otherwise this scan is matching the wrong block',
  );
});

test('🔴 the notice clock is fed the queue wait, not left at its default', async () => {
  const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(
    main,
    /notice\.arm\(waited\.queuedForMs\)/,
    'arm() is called without the queue wait, so a message that queued behind a 790s turn ' +
      'restarts the clock at zero — the exact case this is for',
  );
});

// ──────────────────────────────────────────────────────────────────────────
// THE FAILURE PATH: fire-and-forget timeout, plain, and independently bounded
// ──────────────────────────────────────────────────────────────────────────
//
// These exist for issue #33: a turn killed by its LLM budget also took the
// apology down with it, because the catch path reused the same controller.
// `sendFailureWithTimeout` is the catch's only path to the sender now; every
// assertion below pins the shape that closes the defect.

test('🔴 a failure-reply send that completes returns its own result, untouched by the timer', async () => {
  const sent: { handle: string; text: string }[] = [];
  await sendFailureWithTimeout(
    async (handle, text) => {
      sent.push({ handle, text });
    },
    '+18015550123',
    'I am sorry, ask for a shorter list',
    1_000,
  );
  assert.deepEqual(sent, [{ handle: '+18015550123', text: 'I am sorry, ask for a shorter list' }]);
});

test('🔴 a hanging failure-reply send is REJECTED at its own deadline, not the caller\'s', async () => {
  /**
   * Measured live 2026-09-10: the catch was throwing the same abort that killed
   * the turn, because both shared one controller. The fix replaces that shared
   * controller with this one. Without this assertion, a refactor that drops
   * the inner `Promise.race` would still pass every other test in this file —
   * "the catch resolves quickly when BlueBubbles hangs" is a property nothing
   * else in the test suite can observe.
   */
  let release!: () => void;
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  const start = Date.now();
  const err = await sendFailureWithTimeout(
    (_h, _t) => blocked as unknown as Promise<void>,
    '+18015550123',
    'this will time out',
    50,
  ).then(
    () => null,
    (e: unknown) => e,
  );
  const elapsed = Date.now() - start;
  release();
  assert.ok(err instanceof Error, 'a hanging send must reject, not resolve — silence is the defect');
  assert.match((err as Error).message, /failure-reply send aborted after 50ms/);
  assert.ok(elapsed < 500, `expected ~50ms, took ${elapsed}ms — the timer did not win the race`);
  assert.ok(elapsed >= 40, `expected at least 50ms but got ${elapsed}ms — the timer fired before its budget`);
});

test('🔴 a failure-reply send that REJECTS propagates the original error, not the timer\'s', async () => {
  /**
   * The catch's log line names the failure the SEND produced, not the
   * timer-replacement the helper would otherwise compose on top of a delay the
   * caller cannot afford. Both are honest; only one is what was actually wrong.
   */
  const err = await sendFailureWithTimeout(
    async () => {
      throw new Error('BlueBubbles refused the send (http 500)');
    },
    '+18015550123',
    'apology',
    1_000,
  ).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof Error);
  assert.match((err as Error).message, /BlueBubbles refused the send \(http 500\)/);
});

test('🔴 a fast inner send is NOT replaced by the timeout — the race goes to whoever wins', async () => {
  /**
   * CONTROL for the timer-rejection test above. Without this, a helper that
   * rejects on EVERY call passes both: the timer case and the "always rejects"
   * case look the same in any single test.
   */
  let calls = 0;
  await sendFailureWithTimeout(
    async () => {
      calls += 1;
    },
    '+18015550123',
    'apology',
    5_000,
  );
  assert.equal(calls, 1, 'the inner send must run exactly once when it beats the timer');
});

test('🔴 the failure-reply budget sits well UNDER the 900s turn budget and the 15s BlueBubbles ceiling', () => {
  /**
   * Measured against the existing constants:
   *   `TURN_TIMEOUT_MS`         = 900_000  (`llm.ts`)
   *   `BlueBubblesClient` default `timeoutMs` = 15_000  (`client.ts`)
   *
   * The failure-reply budget MUST be below both, or the catch path inherits the
   * very ceiling that just killed the turn it is trying to apologise for. The
   * default comes from `FAILURE_REPLY_TIMEOUT_MS` — failing this assertion means
   * someone widened the ceiling and forgot the lower bound.
   */
  assert.ok(FAILURE_REPLY_TIMEOUT_MS < 15_000, 'failure-reply budget must be below the BlueBubbles ceiling');
  assert.ok(FAILURE_REPLY_TIMEOUT_MS < 900_000, 'failure-reply budget must be below the turn budget — the whole point');
  assert.ok(FAILURE_REPLY_TIMEOUT_MS >= 1_000, 'a sub-second budget defeats the purpose of having one');
});

test('🔴 the catch in main.ts is fire-and-forget — it does not await the failure reply', async () => {
  /**
   * Source scan, in the same style as `the shipped turn body disarms the notice
   * BEFORE it sends` above. The catch's send must NOT block on the apology's
   * promise, because every queue lane is held until `run` resolves. Awaiting
   * a 15s send here turns one thrown turn into 15s of lane silence on the next
   * message — measurable, but unobservable in any test that does not exercise
   * this seam specifically.
   */
  const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const catchStart = main.indexOf('could not even report');
  assert.ok(catchStart >= 0, 'the catch log line could not be found — this scan is now measuring nothing');
  // Walk backwards to find the line above the catch block that fires the send.
  // That line MUST start with `void sendFailureWithTimeout(`, not `await`.
  const window = main.slice(Math.max(0, catchStart - 1_000), catchStart);
  assert.match(
    window,
    /void\s+sendFailureWithTimeout\(/,
    'the failure-reply send is awaited — the catch will hold the queue lane for as long as the apology takes',
  );
  // And there is no surrounding `try`/`await`. An `await` between the throw
  // and the void promise is the same defect wrapped differently.
  assert.equal(
    /\bawait\s+sendFailureWithTimeout\(/.test(window),
    false,
    'an `await sendFailureWithTimeout(...)` exists between the throw and the catch — that awaits the apology',
  );
});
