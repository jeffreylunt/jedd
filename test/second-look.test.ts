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
