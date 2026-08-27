import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent } from '../src/agent.js';
import type { LlmClient, LlmMessage, LlmReply } from '../src/llm.js';
import type { Tool } from '../src/tools/types.js';
import { TurnQueue } from '../src/turn-queue.js';
import { testConfig } from './helpers.js';

/**
 * ══════════════════════════════════════════════════════════════════════════
 * THE DEFECT THESE EXIST FOR — MEASURED LIVE, 2026-08-27
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Two messages seven seconds apart became two CONCURRENT turns, each blind to
 * the other, and `add_movie` ran twice for one request:
 *
 *   02:22:32  "Option #1."                    -> resolve_choice, add_movie(1504358)
 *   02:22:38  "Don't say good luck the film!" ->               add_movie(1504358)
 *
 * Two replies, five seconds apart, for one thing the person asked for once. On
 * Jeff's thread the same mechanism produced the ORDERING half: turn 11 finished
 * before turn 10, so the answer to his SECOND message landed before the answer
 * to his first — and turn 11's reply quoted a tool call that turn 10 had made,
 * because `Agent.histories` holds ONE mutable array per sender and both turns
 * were pushing into it.
 *
 * The fix is one turn per burst. These tests pin it, and each one that asserts
 * an ABSENCE has a control beside it that produces the thing being asserted
 * absent — otherwise they would all pass against a queue that drops everything.
 */

/** A settle window a test drives by hand, so nothing here waits on a real clock. */
function manualSettle(): { settle: () => Promise<void>; open: () => void; waiting: () => number } {
  let waiters: Array<() => void> = [];
  return {
    settle: () =>
      new Promise<void>((r) => {
        waiters.push(r);
      }),
    open: () => {
      const w = waiters;
      waiters = [];
      for (const r of w) r();
    },
    waiting: () => waiters.length,
  };
}

interface Msg {
  senderHandle: string;
  text: string;
}

/**
 * 🔴 555 EXCHANGES, RESERVED FOR FICTION. The live transcripts quoted above are
 * real people's threads and their handles belong in `.env`, never in the tree —
 * `owner-config-fail-closed.test.ts` scans every tracked file for exactly this
 * and it caught the first draft of this file. The names are what matter here;
 * the digits are only a key that has to differ between two senders.
 */
const KAELA = '+18015550188';
const JEFF = '+18015550123';

// ── the burst: many messages in, ONE turn out ───────────────────────────────

test('🔴 two messages from one sender that arrive in a burst become ONE turn', async () => {
  const batches: Msg[][] = [];
  const gate = manualSettle();
  const q = new TurnQueue<Msg>({
    keyOf: (m) => m.senderHandle,
    settle: gate.settle,
    run: async (batch) => {
      batches.push(batch);
    },
  });

  const a = q.submit({ senderHandle: KAELA, text: 'Option #1.' });
  const b = q.submit({ senderHandle: KAELA, text: "Don't say good luck the film!" });
  gate.open();
  await Promise.all([a, b]);

  assert.equal(batches.length, 1, 'the burst produced more than one turn');
  assert.deepEqual(
    batches[0]!.map((m) => m.text),
    ['Option #1.', "Don't say good luck the film!"],
    'both messages reached the one turn, oldest first',
  );
});

/**
 * 🔴 MUTATION CONTROL — the queue is REMOVED here, on purpose.
 *
 * This is the shape the container was running on 2026-08-27: every webhook
 * dispatched independently. If the assertion above ever passes without the
 * queue, it has stopped measuring anything.
 */
test('MUTATION: dispatched the OLD way, the same burst produces TWO turns', async () => {
  const turns: Msg[][] = [];
  const run = async (batch: Msg[]) => {
    turns.push(batch);
  };
  // `void run(...)` per message — exactly `void this.ingest(...)`, no lane, no settle.
  await Promise.all([
    run([{ senderHandle: KAELA, text: 'Option #1.' }]),
    run([{ senderHandle: KAELA, text: "Don't say good luck the film!" }]),
  ]);
  assert.equal(turns.length, 2, 'without serialisation the burst is two turns — this is the bug');
});

// ── different senders must NOT block each other ─────────────────────────────

test('CONTROL: two different senders run CONCURRENTLY — the lane is per sender', async () => {
  const started: string[] = [];
  let releaseKaela!: () => void;
  const kaelaHeld = new Promise<void>((r) => {
    releaseKaela = r;
  });
  const gate = manualSettle();
  const q = new TurnQueue<Msg>({
    keyOf: (m) => m.senderHandle,
    settle: gate.settle,
    run: async (batch) => {
      started.push(batch[0]!.senderHandle);
      if (batch[0]!.senderHandle === KAELA) await kaelaHeld;
    },
  });

  const k = q.submit({ senderHandle: KAELA, text: 'add a film' });
  const j = q.submit({ senderHandle: JEFF, text: 'what is downloading' });
  gate.open();
  // Jeff's turn must be able to start and FINISH while Kaela's is still held.
  // (If the lane were global rather than per sender, this `await` never returns.)
  await j;
  assert.deepEqual(
    [...started].sort(),
    [JEFF, KAELA].sort(),
    "both senders' turns must be in flight at once — the lane is per sender, not global",
  );
  releaseKaela();
  await k;
});

// ── ordering: a message that arrives mid-turn is answered AFTER it ──────────

/**
 * ⚠️ THESE TWO USE AN IMMEDIATE SETTLE ON PURPOSE.
 *
 * A hand-driven settle window would serialise these turns all by itself, and
 * the test would then pass against a queue with no lane at all — asserting
 * ordering that the fixture, not the code, was producing. With `settle`
 * resolving at once, **the lane is the only thing keeping these in order**, so
 * removing it turns them red. (Confirmed by mutation; see the commit.)
 */
const immediate = async (): Promise<void> => {};

test('🔴 a message arriving MID-TURN is answered after it, never before — turn 11 beat turn 10 live', async () => {
  const finished: string[] = [];
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((r) => {
    releaseFirst = r;
  });
  const q = new TurnQueue<Msg>({
    keyOf: (m) => m.senderHandle,
    settle: immediate,
    run: async (batch) => {
      if (batch[0]!.text.startsWith('Start')) await firstHeld;
      finished.push(batch.map((m) => m.text).join('|'));
    },
  });

  const first = q.submit({ senderHandle: JEFF, text: 'Start with the earliest missing episodes' });
  // Let the first turn get inside `run` and block there, exactly as a 53s
  // release search does, before the second message arrives.
  for (let i = 0; i < 10; i++) await Promise.resolve();

  const second = q.submit({ senderHandle: JEFF, text: 'Is that what you think' });
  releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(
    finished,
    ['Start with the earliest missing episodes', 'Is that what you think'],
    'the second message was answered before the first — the live out-of-order defect',
  );
});

test('a message arriving mid-turn is NOT lost — it gets its own turn afterwards', async () => {
  const seen: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const q = new TurnQueue<Msg>({
    keyOf: (m) => m.senderHandle,
    settle: immediate,
    run: async (batch) => {
      for (const m of batch) seen.push(m.text);
      if (seen.length === 1) await held;
    },
  });
  const a = q.submit({ senderHandle: JEFF, text: 'one' });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const b = q.submit({ senderHandle: JEFF, text: 'two' });
  release();
  await Promise.all([a, b]);
  assert.deepEqual(seen, ['one', 'two']);
});

/**
 * 🔴 THE LOST-MESSAGE WINDOW, WHICH IS THE FAILURE THE THIRD STATE PREVENTS.
 *
 * A message that arrives in the instant a lane is being torn down must not fall
 * between the two states. This drives that instant directly: submit again from
 * inside the `run` of the last batch, which is the closest a test can get to
 * "the drain loop is about to give up".
 */
test('🔴 a message submitted from INSIDE the last turn is still answered', async () => {
  const seen: string[] = [];
  let follower: Promise<void> | undefined;
  const q = new TurnQueue<Msg>({
    keyOf: (m) => m.senderHandle,
    settle: immediate,
    run: async (batch) => {
      for (const m of batch) seen.push(m.text);
      if (seen.length === 1) follower = q.submit({ senderHandle: JEFF, text: 'landed in the teardown gap' });
    },
  });
  await q.submit({ senderHandle: JEFF, text: 'first' });
  await follower;
  assert.deepEqual(seen, ['first', 'landed in the teardown gap'], 'a message was accepted into a lane nobody drained');
});

// ── the lane must survive a turn that throws ────────────────────────────────

test('🔴 a THROWN turn does not strand the messages queued behind it', async () => {
  const seen: string[] = [];
  const logged: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const gate = manualSettle();
  const q = new TurnQueue<Msg>({
    keyOf: (m) => m.senderHandle,
    settle: gate.settle,
    log: (l) => logged.push(l),
    run: async (batch) => {
      seen.push(batch[0]!.text);
      if (batch[0]!.text === 'boom') {
        await held;
        throw new Error('the model endpoint is unreachable');
      }
    },
  });
  const a = q.submit({ senderHandle: JEFF, text: 'boom' });
  gate.open();
  await Promise.resolve();
  await Promise.resolve();
  const b = q.submit({ senderHandle: JEFF, text: 'still here?' });
  release();
  await a; // 🔴 must RESOLVE, not reject: the caller is a fire-and-forget webhook
  gate.open();
  await b;
  assert.deepEqual(seen, ['boom', 'still here?']);
  assert.ok(
    logged.some((l) => l.includes('unreachable')),
    'a thrown turn is swallowed by the lane, so it has to be LOUD in the log',
  );
});

test('the lane is released when it drains, so the next message starts a fresh turn', async () => {
  const gate = manualSettle();
  const q = new TurnQueue<Msg>({ keyOf: (m) => m.senderHandle, settle: gate.settle, run: async () => {} });
  assert.equal(q.inFlight(JEFF), false, 'nothing has arrived yet');
  const a = q.submit({ senderHandle: JEFF, text: 'hi' });
  assert.equal(q.inFlight(JEFF), true, 'a lane is open while a turn is owed');
  gate.open();
  await a;
  assert.equal(q.inFlight(JEFF), false, 'the lane leaked — this sender would never be served again');
});

// ── the root cause, at the layer where it actually corrupted things ─────────

/**
 * 🔴 THE SHARED HISTORY IS THE MECHANISM, AND THIS TEST NAMES IT.
 *
 * `Agent.histories` is one mutable array per sender. Two concurrent turns both
 * push their user text into it and both read it back, so each one answers with
 * the other's question in context — which is how turn 11's reply came to quote
 * a tool call that turn 10 had made. Serialised, the burst reaches the model as
 * ONE user turn and there is nothing to interleave.
 */
function stubLlm(onChat: (messages: LlmMessage[]) => void): LlmClient {
  return {
    label: 'stub',
    async chat(messages: LlmMessage[], _tools: Tool[]): Promise<LlmReply> {
      onChat(messages);
      // Yield, so a concurrent turn has a real chance to interleave.
      await new Promise((r) => setImmediate(r));
      return { text: 'ok', toolCalls: [] };
    },
  };
}

test('🔴 CHARACTERISATION: two CONCURRENT agent turns share one history and see each other', async () => {
  const seenUserTurns: string[][] = [];
  const agent = new Agent(
    testConfig({ ownerHandle: JEFF }),
    stubLlm((messages) => {
      seenUserTurns.push(messages.filter((m) => m.role === 'user').map((m) => m.content));
    }),
    undefined,
    [],
  );
  await Promise.all([agent.handle(JEFF, 'Yes run the search'), agent.handle(JEFF, 'How many watching?')]);
  const contaminated = seenUserTurns.filter((u) => u.length > 1);
  assert.ok(
    contaminated.length > 0,
    'if this ever goes green, Agent stopped sharing history and this file needs rereading',
  );
});

test('🔴 serialised through the queue, one burst is ONE model turn carrying both messages', async () => {
  const seenUserTurns: string[][] = [];
  const agent = new Agent(
    testConfig({ ownerHandle: JEFF }),
    stubLlm((messages) => {
      seenUserTurns.push(messages.filter((m) => m.role === 'user').map((m) => m.content));
    }),
    undefined,
    [],
  );
  const gate = manualSettle();
  const q = new TurnQueue<Msg>({
    keyOf: (m) => m.senderHandle,
    settle: gate.settle,
    run: async (batch) => {
      await agent.handle(batch[0]!.senderHandle, batch.map((m) => m.text).join('\n'));
    },
  });
  const a = q.submit({ senderHandle: JEFF, text: 'Yes run the search' });
  const b = q.submit({ senderHandle: JEFF, text: 'How many watching?' });
  gate.open();
  await Promise.all([a, b]);

  assert.equal(seenUserTurns.length, 1, 'the burst reached the model more than once');
  assert.deepEqual(seenUserTurns[0], ['Yes run the search\nHow many watching?']);
});
