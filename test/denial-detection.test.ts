import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent } from '../src/agent.js';
import type { LlmClient, LlmMessage, LlmReply } from '../src/llm.js';
import type { Tool } from '../src/tools/types.js';
import { testConfig } from './helpers.js';

/**
 * ── COUNTING FALSE CAPABILITY DENIALS. IT IS A COUNTER, NOT A GUARD. ─────────
 *
 * 🔴 WHAT USED TO BE HERE AND WHY IT IS GONE — READ BEFORE REBUILDING IT.
 *
 * This file tested a SECOND LOOK: on a denial the loop pushed a system note and
 * gave the model one more round to re-read its own tool list. It was built,
 * reviewed and mutation-checked 14/14, and it was **measured not to work**. On
 * live turns against the production registry the model re-read its list and
 * repeated the denial verbatim.
 *
 * The reading that explains it: **re-asking changes how many CHANCES the model
 * gets, not what it KNOWS.** Its tool list was already in the payload. So the
 * retry was shelved and only the detection ships. Implementation preserved on
 * this branch at commit `f987e45`.
 */
const config = testConfig({ readOnly: false });
const OWNER = '+18015550123';

/** The real 2026-08-28 turn: `jellyfin_sessions` returned TRUE, the model generalised. */
const WATCH_HISTORY_DENIAL =
  "I can only see live sessions, not watch history — and right now there's nobody playing " +
  "anything. If you want to know what's been watched, that's not something I can pull.";

function readTool(name: string, content: string, ok = true): Tool {
  return {
    name,
    description: `stub ${name}`,
    minRole: 'owner',
    writes: false,
    parameters: { type: 'object', properties: {}, required: [] },
    async run() {
      return { ok, content };
    },
  };
}

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
  readTool('homelab_read', 'Tarzan 51%, Cars 3 14% — 14 items'),
];

test('🔴 THE REPORTED BUG IS COUNTED: an unlicensed denial is recorded verbatim', async () => {
  const llm = new ScriptedLlm([call('jellyfin_sessions'), say(WATCH_HISTORY_DENIAL)]);
  const agent = new Agent(config, llm, undefined, TOOLS);

  const record = await agent.handle(OWNER, 'Has tom watched anything yet');

  assert.equal(record.unlicensedDenial, WATCH_HISTORY_DENIAL);
});

/**
 * 🔴 THE PROPERTY THAT MAKES THIS SAFE TO SHIP, AND THE ONE THAT MUST NEVER
 * REGRESS: IT ONLY OBSERVES.
 *
 * The README's claim — *"the code's job is to decide what may be called, not to
 * police what gets said. There is no output filtering anywhere in the loop"* —
 * is literally true only while this holds. The reply must be byte-identical to
 * what the model produced, and detecting must cost ZERO extra model calls.
 */
test('🔴 it changes NOTHING: same reply, byte for byte, and no extra model round', async () => {
  const withDenial = new ScriptedLlm([call('jellyfin_sessions'), say(WATCH_HISTORY_DENIAL)]);
  const record = await new Agent(config, withDenial, undefined, TOOLS).handle(OWNER, 'q');

  assert.equal(record.replyText, WATCH_HISTORY_DENIAL, 'the model’s own words, untouched');
  assert.equal(withDenial.seen.length, 2, 'one model call per loop step — no extra round');
  // And the note that the shelved retry used to inject must not be in history.
  const lastRound = withDenial.seen.at(-1)!;
  assert.equal(
    lastRound.filter((m) => m.role === 'system').length,
    1,
    'exactly the system prompt — nothing injected mid-conversation',
  );
});

/**
 * 🔴 THE FAILING CONTROL. Without it the test above proves only that a two-step
 * script runs; it says nothing about the DETECTION being what fired. Same agent,
 * same tools, same tool call — only the wording of the reply differs.
 */
test('FAILING CONTROL: an ordinary reply records nothing', async () => {
  const llm = new ScriptedLlm([call('jellyfin_sessions'), say('Nobody’s watching — 2 idle sessions.')]);
  const agent = new Agent(config, llm, undefined, TOOLS);

  const record = await agent.handle(OWNER, 'who is watching');

  assert.equal(record.unlicensedDenial, undefined);
});

test('a denial LICENSED by a clean sweep of failures is not counted', async () => {
  // The model watched its only tool fail. Saying so is honest reporting, and the
  // system prompt tells it to. Counting it would bury the real ones in noise.
  const llm = new ScriptedLlm([call('jellyfin_sessions'), say(WATCH_HISTORY_DENIAL)]);
  const agent = new Agent(config, llm, undefined, [
    readTool('jellyfin_sessions', 'fetch failed', false),
    TOOLS[1]!,
  ]);

  const record = await agent.handle(OWNER, 'Has tom watched anything yet');

  assert.equal(record.unlicensedDenial, undefined);
});

test('a denial LICENSED by the permission gate is not counted', async () => {
  const ownerOnly: Tool = { ...readTool('jellyfin_sessions', 'x'), minRole: 'owner' };
  const llm = new ScriptedLlm([
    call('jellyfin_sessions'),
    say('No — I have no tool for that here, it is owner-only.'),
  ]);
  const agent = new Agent(config, llm, undefined, [ownerOnly]);

  const record = await agent.handle('+18015559999', 'who is watching');

  assert.equal(record.role, 'guest');
  assert.equal(record.toolCalls[0]!.refused, true);
  assert.equal(record.unlicensedDenial, undefined, 'a refusal is the answer; do not flag it');
});

/**
 * 🔴 A HALLUCINATED TOOL NAME IS NOT AN OBSTRUCTION — IT IS THE DEFECT ITSELF.
 *
 * That branch answers with the registry VERBATIM, so a capability denial issued
 * straight afterwards was made with the tool list in front of it. It fails, so
 * without `unknownTool` it counted toward the clean sweep and the turn was
 * skipped — the counter standing down on its clearest case.
 */
test('🔴 a denial after a HALLUCINATED tool name IS counted', async () => {
  const llm = new ScriptedLlm([call('watch_history', 'c1'), say(WATCH_HISTORY_DENIAL)]);
  const agent = new Agent(config, llm, undefined, TOOLS);

  const record = await agent.handle(OWNER, 'Has tom watched anything yet');

  assert.equal(record.toolCalls[0]!.unknownTool, true);
  assert.equal(record.unlicensedDenial, WATCH_HISTORY_DENIAL);
});

test('a denial with NO tool calls at all is counted — the 2026-08-26 Prowlarr shape', async () => {
  const llm = new ScriptedLlm([
    say("I can't — I have no write tool for Prowlarr, only read."),
  ]);
  const agent = new Agent(config, llm, undefined, TOOLS);

  const record = await agent.handle(OWNER, 'Can you enable both and see if they go healthy?');

  assert.equal(record.toolCalls.length, 0);
  assert.match(record.unlicensedDenial ?? '', /no write tool for Prowlarr/);
});

test('the "I got stuck" step-limit reply is never counted as a denial', async () => {
  // It is the loop's own sentence, not the model's claim about its tools, and
  // counting it would inflate the metric with turns that timed out.
  const llm = new ScriptedLlm(Array.from({ length: 8 }, (_, i) => call('homelab_read', `c${i}`)));
  const agent = new Agent(config, llm, undefined, TOOLS);

  const record = await agent.handle(OWNER, 'q');

  assert.match(record.replyText, /I got stuck/);
  assert.equal(record.unlicensedDenial, undefined);
});
