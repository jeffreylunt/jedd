import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent, MAX_STEPS } from '../src/agent.js';
import { SECOND_LOOK_NOTE } from '../src/capability-denial.js';
import type { LlmClient, LlmMessage, LlmReply } from '../src/llm.js';
import type { Tool } from '../src/tools/types.js';
import { testConfig } from './helpers.js';

const config = testConfig({ readOnly: false });
const OWNER = '+18015550123';

/**
 * The real 2026-08-28 turn, reproduced as a script.
 *
 * 🔴 THIS IS THE FIXTURE THE GUARD WAS REQUIRED TO BE BUILT AGAINST, and it is
 * the UNNAMED shape: `jellyfin_sessions` returns a TRUE result — two idle
 * sessions — and the model converts the scope of that one result into a claim
 * about the system. The denial names no tool, so a registry cross-check has
 * nothing to look up.
 */
const WATCH_HISTORY_DENIAL =
  "I can only see live sessions, not watch history — and right now there's nobody playing " +
  "anything (2 sessions connected, both idle). If you want to know what's been watched, that's " +
  'not something I can pull.';

function readTool(name: string, content: string): Tool {
  return {
    name,
    description: `stub ${name}`,
    minRole: 'owner',
    writes: false,
    parameters: { type: 'object', properties: {}, required: [] },
    async run() {
      return { ok: true, content };
    },
  };
}

/** Replays a fixed sequence of model replies and records what it was sent. */
class ScriptedLlm implements LlmClient {
  readonly label = 'scripted';

  readonly seen: LlmMessage[][] = [];

  private turn = 0;

  constructor(private readonly script: LlmReply[]) {}

  async chat(messages: LlmMessage[]): Promise<LlmReply> {
    this.seen.push(messages.map((m) => ({ ...m })));
    const next = this.script[this.turn++];
    assert.ok(next, `the model was called ${this.turn} times; the script has ${this.script.length}`);
    return next;
  }
}

const say = (text: string): LlmReply => ({ text, toolCalls: [] });
const call = (name: string, id = 'c1'): LlmReply => ({
  text: '',
  toolCalls: [{ id, name, arguments: {} }],
});

const TOOLS = [
  readTool('jellyfin_sessions', '2 sessions, both idle'),
  readTool('homelab_read', 'Tarzan 51%, Cars 3 14%, Brave 79% — 14 items'),
];

test('🔴 THE REPORTED BUG: the unnamed denial gets a second look, and the answer changes', async () => {
  const llm = new ScriptedLlm([
    call('jellyfin_sessions'),
    say(WATCH_HISTORY_DENIAL),
    // …the note lands, the model looks again and reaches the general read…
    call('homelab_read', 'c2'),
    say('<name> has watched Tarzan (51%), Cars 3 (14%) and Brave (79%) — 14 items in all.'),
  ]);
  const agent = new Agent(config, llm, undefined, TOOLS);

  const record = await agent.handle(OWNER, 'Has tom watched anything yet');

  assert.equal(record.secondLook?.changed, true, 'the second look must have changed the answer');
  assert.equal(record.secondLook?.deniedText, WATCH_HISTORY_DENIAL);
  assert.match(record.replyText, /Tarzan/);
  assert.doesNotMatch(record.replyText, /not something I can pull/);
  // The tool the model would not reach for on its own actually ran.
  assert.deepEqual(
    record.toolCalls.map((c) => c.name),
    ['jellyfin_sessions', 'homelab_read'],
  );
  // The note was delivered as a system message, on the round after the denial.
  const noteRound = llm.seen[2]!;
  assert.equal(noteRound.at(-1)?.role, 'system');
  assert.equal(noteRound.at(-1)?.content, SECOND_LOOK_NOTE);
});

/**
 * 🔴 THE FAILING CONTROL. Without it, the test above proves only that a
 * four-step script runs to completion — it says nothing about the second look
 * being what caused the extra round.
 *
 * Same agent, same tools, same first tool call. The ONLY thing that differs is
 * whether the reply reads as a capability denial. If this ever needs more than
 * two model calls, the trigger has stopped discriminating and the guard is
 * running on every turn.
 */
test('FAILING CONTROL: an ordinary reply gets no second look and no extra model call', async () => {
  const llm = new ScriptedLlm([call('jellyfin_sessions'), say('Nobody’s watching — 2 idle sessions.')]);
  const agent = new Agent(config, llm, undefined, TOOLS);

  const record = await agent.handle(OWNER, 'who is watching');

  assert.equal(record.secondLook, undefined);
  assert.equal(llm.seen.length, 2, 'exactly one model call per loop step, no extra round');
  assert.equal(record.replyText, 'Nobody’s watching — 2 idle sessions.');
});

test('a CONFIRMED denial is sent unchanged — looking again is allowed to say "no"', async () => {
  const llm = new ScriptedLlm([say(WATCH_HISTORY_DENIAL), say(WATCH_HISTORY_DENIAL)]);
  const agent = new Agent(config, llm, undefined, TOOLS);

  const record = await agent.handle(OWNER, 'Has tom watched anything yet');

  assert.equal(record.replyText, WATCH_HISTORY_DENIAL, 'the model’s own words, verbatim');
  assert.equal(record.secondLook?.changed, false);
  assert.equal(record.secondLook?.deniedText, WATCH_HISTORY_DENIAL);
});

test('🔴 a FAILED tool licenses the denial, and the second look does not fire', async () => {
  // The system prompt says a refusal is the answer and not to route around it.
  // Nudging here would push the model at the permission gate.
  const failing: Tool = {
    ...readTool('jellyfin_sessions', ''),
    async run() {
      return { ok: false, content: 'fetch failed' };
    },
  };
  const llm = new ScriptedLlm([call('jellyfin_sessions'), say(WATCH_HISTORY_DENIAL)]);
  const agent = new Agent(config, llm, undefined, [failing, TOOLS[1]!]);

  const record = await agent.handle(OWNER, 'Has tom watched anything yet');

  assert.equal(record.secondLook, undefined, 'a failed tool is evidence; leave the turn alone');
  assert.equal(llm.seen.length, 2);
});

test('it fires AT MOST ONCE — a model that keeps denying is not looped against its own note', async () => {
  const llm = new ScriptedLlm([
    say(WATCH_HISTORY_DENIAL),
    say('Still no — I have no tool for watch history.'),
  ]);
  const agent = new Agent(config, llm, undefined, TOOLS);

  const record = await agent.handle(OWNER, 'Has tom watched anything yet');

  assert.equal(llm.seen.length, 2, 'the second denial must not trigger a third round');
  assert.equal(record.replyText, 'Still no — I have no tool for watch history.');
  assert.equal(record.secondLook?.changed, true);
});

/**
 * 🔴 THE GUARD MUST NEVER MAKE THE REPLY WORSE THAN THE ONE IT INTERRUPTED.
 *
 * It spends steps out of a shared budget. If the extra round burns them all, the
 * turn would otherwise fall through to "I got stuck" — a guard aimed at a WRONG
 * answer having replaced a merely UNWELCOME one with no answer at all.
 */
test('if the second look exhausts the step budget, the original denial is restored', async () => {
  const script: LlmReply[] = [say(WATCH_HISTORY_DENIAL)];
  for (let i = 0; i < MAX_STEPS; i++) script.push(call('homelab_read', `c${i}`));
  const llm = new ScriptedLlm(script);
  const agent = new Agent(config, llm, undefined, TOOLS);

  const record = await agent.handle(OWNER, 'Has tom watched anything yet');

  assert.equal(record.replyText, WATCH_HISTORY_DENIAL);
  assert.doesNotMatch(record.replyText, /I got stuck/);
  assert.equal(record.secondLook?.changed, false);
  assert.equal(record.secondLook?.stillDenies, true);
});

/**
 * 🔴 THE BUDGET BOUNDARY, WHICH WAS COMPLETELY UNTESTED.
 *
 * The test above fires the second look at `steps = 0`, so `steps + 2 < MAX_STEPS`
 * was never near its edge — a code review found that both loosening it to `+ 1`
 * and DELETING IT ENTIRELY left all tests green. These two pin the boundary from
 * each side.
 *
 * What `+ 2` buys is headroom for one tool round AND the answer after it. Firing
 * with less than that spends a model round that cannot possibly produce a better
 * reply, which is the one thing a guard justified by "it only costs latency" must
 * not do gratuitously.
 */
async function denyAtStep(n: number): Promise<{ fired: boolean; calls: number }> {
  // n rounds of tool calls, THEN the denial — so the denial lands at step n.
  const script: LlmReply[] = [];
  for (let i = 0; i < n; i++) script.push(call('jellyfin_sessions', `p${i}`));
  script.push(say(WATCH_HISTORY_DENIAL));
  // Room for the second look to answer, if it is allowed to happen at all.
  script.push(call('homelab_read', 'x'), say('Tarzan 51%.'));
  const llm = new ScriptedLlm(script);
  const agent = new Agent(config, llm, undefined, TOOLS);
  const record = await agent.handle(OWNER, 'Has tom watched anything yet');
  return { fired: record.secondLook !== undefined, calls: llm.seen.length };
}

test('🔴 it still fires with exactly enough budget left (MAX_STEPS - 3)', async () => {
  const { fired } = await denyAtStep(MAX_STEPS - 3);
  assert.equal(fired, true, 'two steps remain: one for a tool round, one for the answer');
});

test('🔴 it does NOT fire one step later, when the answer would have nowhere to go', async () => {
  const { fired, calls } = await denyAtStep(MAX_STEPS - 2);
  assert.equal(fired, false, 'only one step left — a round trip that cannot produce a reply');
  assert.equal(calls, MAX_STEPS - 1, 'and no extra model call was spent finding that out');
});

test('the RESTORED denial is left in history, so a follow-up "why not?" has an antecedent', async () => {
  // ⚠️ EXACTLY `MAX_STEPS - 1` tool rounds after the denial. One more and turn 1
  // leaves a stray tool call at the head of the script, so turn 2 consumes it
  // and `seen.at(-1)` is turn 2's SECOND round — which put a tool message last
  // and made this assertion read the wrong object.
  const script: LlmReply[] = [say(WATCH_HISTORY_DENIAL)];
  for (let i = 0; i < MAX_STEPS - 1; i++) script.push(call('homelab_read', `c${i}`));
  script.push(say('ok'));
  const llm = new ScriptedLlm(script);
  const agent = new Agent(config, llm, undefined, TOOLS);

  await agent.handle(OWNER, 'Has tom watched anything yet');
  await agent.handle(OWNER, 'why not?');

  const secondTurn = llm.seen.at(-1)!;
  const assistants = secondTurn.filter((m) => m.role === 'assistant' && !m.toolCalls);
  assert.deepEqual(
    assistants.map((m) => m.content),
    [WATCH_HISTORY_DENIAL],
    'exactly one assistant reply: the one that was actually SENT, and no blank beside it',
  );
  assert.equal(assistants.at(-1), secondTurn.filter((m) => m.role !== 'user').at(-1));
});

/**
 * ⚠️ A second-look round that comes back with no text used to leave
 * `{role:'assistant', content:''}` in history next to the restored denial — two
 * consecutive assistant messages, one blank, produced by the one part of this
 * loop that cleans up after itself. Some chat templates object to consecutive
 * assistant turns.
 */
test('an EMPTY second-look round leaves no blank assistant message behind', async () => {
  const llm = new ScriptedLlm([say(WATCH_HISTORY_DENIAL), say('   '), say('ok')]);
  const agent = new Agent(config, llm, undefined, TOOLS);

  const record = await agent.handle(OWNER, 'Has tom watched anything yet');
  await agent.handle(OWNER, 'still there?');

  assert.equal(record.replyText, WATCH_HISTORY_DENIAL);
  const secondTurn = llm.seen.at(-1)!;
  assert.equal(
    secondTurn.filter((m) => m.role === 'assistant' && m.content === '').length,
    0,
    'no blank assistant message may survive into the next turn',
  );
});

/**
 * 🔴 A HALLUCINATED TOOL NAME IS NOT AN OBSTRUCTION — IT IS THE DEFECT ITSELF.
 *
 * The unknown-tool branch answers with the registry verbatim. A capability
 * denial issued straight afterwards was made with the tool list in front of it.
 * Before `unknownTool`, that turn looked like a clean sweep of failures and the
 * second look was skipped — the guard standing down on its clearest case.
 */
test('🔴 a denial after a HALLUCINATED tool name still gets a second look', async () => {
  const llm = new ScriptedLlm([
    call('watch_history', 'c1'),
    say(WATCH_HISTORY_DENIAL),
    call('homelab_read', 'c2'),
    say('Tarzan 51%, Cars 3 14%.'),
  ]);
  const agent = new Agent(config, llm, undefined, TOOLS);

  const record = await agent.handle(OWNER, 'Has tom watched anything yet');

  assert.equal(record.toolCalls[0]!.unknownTool, true);
  assert.equal(record.toolCalls[0]!.ok, false);
  assert.equal(record.secondLook?.changed, true);
  assert.equal(record.secondLook?.stillDenies, false, 'the denial was withdrawn, not re-worded');
  assert.match(record.replyText, /Tarzan/);
});

/**
 * ⚠️ `changed` AND `stillDenies` ARE DIFFERENT QUESTIONS, and the metric that
 * matters is the second one. A model that looks again and merely rewords its
 * refusal changes the text; reading that as "the reply was wrong" inflates the
 * one number this field exists to support.
 */
test('a REWORDED denial is changed:true but stillDenies:true — not a success', async () => {
  const llm = new ScriptedLlm([
    say(WATCH_HISTORY_DENIAL),
    say('Still no — I have no tool for watch history.'),
  ]);
  const agent = new Agent(config, llm, undefined, TOOLS);

  const record = await agent.handle(OWNER, 'Has tom watched anything yet');

  assert.equal(record.secondLook?.changed, true);
  assert.equal(record.secondLook?.stillDenies, true);
});

test('neither the superseded denial nor the note survives into the next turn', async () => {
  const llm = new ScriptedLlm([
    say(WATCH_HISTORY_DENIAL),
    call('homelab_read'),
    say('Tarzan 51%, Cars 3 14%.'),
    say('anything else?'),
  ]);
  const agent = new Agent(config, llm, undefined, TOOLS);

  await agent.handle(OWNER, 'Has tom watched anything yet');
  await agent.handle(OWNER, 'thanks');

  const secondTurn = llm.seen.at(-1)!;
  const texts = secondTurn.map((m) => `${m.role}:${m.content}`);
  // 🔴 A standing instruction about a reply that is no longer there would steer
  // every later turn in this conversation.
  assert.equal(
    texts.some((t) => t.includes(SECOND_LOOK_NOTE)),
    false,
    'the note must not persist',
  );
  // 🔴 And Jedd's own retracted "I have no tool for this" is the single worst
  // thing to leave in context: it is the model's prior claim about its own
  // capabilities, sitting where it will read it again.
  assert.equal(
    texts.some((t) => t.includes('not something I can pull')),
    false,
    'the superseded denial must not persist',
  );
  assert.equal(
    texts.some((t) => t.includes('Tarzan 51%')),
    true,
    'but the answer that replaced it must',
  );
});
