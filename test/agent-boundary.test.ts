import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent } from '../src/agent.js';
import type { LlmClient, LlmMessage, LlmReply } from '../src/llm.js';
import type { Tool } from '../src/tools/types.js';
import { testConfig } from './helpers.js';

const config = testConfig();

/** A model that always asks for `dangerous_tool` first, then answers. */
class ScriptedLlm implements LlmClient {
  readonly label = 'scripted';
  readonly declaredTools: string[][] = [];
  private calls = 0;

  async chat(_messages: LlmMessage[], tools: Tool[]): Promise<LlmReply> {
    this.declaredTools.push(tools.map((t) => t.name));
    this.calls++;
    if (this.calls === 1) {
      return {
        text: '',
        toolCalls: [{ id: 'c1', name: 'dangerous_tool', arguments: { target: 'jellyfin' } }],
      };
    }
    return { text: 'done', toolCalls: [] };
  }
}

function buildSpyTool() {
  const state = { ran: false, sawArgs: null as unknown };
  const tool: Tool = {
    name: 'dangerous_tool',
    description: 'owner-only side effect',
    minRole: 'owner',
    parameters: { type: 'object', properties: {}, required: [] },
    async run(args) {
      state.ran = true;
      state.sawArgs = args;
      return { ok: true, content: 'side effect performed' };
    },
  };
  return { tool, state };
}

test('a GUEST asking for an owner tool never reaches the side effect', async () => {
  const { tool, state } = buildSpyTool();
  const llm = new ScriptedLlm();
  const agent = new Agent(config, llm, undefined, [tool]);

  const record = await agent.handle('+18015559999', 'restart jellyfin please');

  assert.equal(state.ran, false, 'the tool body must NOT have executed for a guest');
  assert.equal(record.role, 'guest');
  assert.equal(record.toolCalls.length, 1);
  assert.equal(record.toolCalls[0]!.refused, true);
  assert.equal(record.toolCalls[0]!.ok, false);
  // The guest was never even told the tool exists.
  assert.deepEqual(llm.declaredTools[0], []);
});

test('FAILING CONTROL: the identical request from the OWNER does run it', async () => {
  // Same model, same script, same tool — only the sender changes. If this did
  // not pass, the test above would prove nothing about the permission check.
  const { tool, state } = buildSpyTool();
  const llm = new ScriptedLlm();
  const agent = new Agent(config, llm, undefined, [tool]);

  const record = await agent.handle('+18015550123', 'restart jellyfin please');

  assert.equal(state.ran, true, 'the owner must reach the tool');
  assert.equal(record.role, 'owner');
  assert.equal(record.toolCalls[0]!.ok, true);
  assert.equal(record.toolCalls[0]!.refused, undefined);
  assert.deepEqual(llm.declaredTools[0], ['dangerous_tool']);
});

test('a refusal is fed back as a tool result, so the model must account for it', async () => {
  const { tool } = buildSpyTool();
  const seen: LlmMessage[][] = [];
  class Recording extends ScriptedLlm {
    override async chat(messages: LlmMessage[], tools: Tool[]): Promise<LlmReply> {
      seen.push(structuredClone(messages));
      return super.chat(messages, tools);
    }
  }
  const agent = new Agent(config, new Recording(), undefined, [tool]);
  await agent.handle('+18015559999', 'restart jellyfin');

  const secondCall = seen[1]!;
  const toolMessage = secondCall.find((m) => m.role === 'tool');
  assert.ok(toolMessage, 'a tool message must be present on the follow-up call');
  assert.match(toolMessage.content, /REFUSED/);
});

test('the turn record names every tool that ran and whether it succeeded', async () => {
  const { tool } = buildSpyTool();
  const agent = new Agent(config, new ScriptedLlm(), undefined, [tool]);
  const record = await agent.handle('+18015550123', 'go');

  assert.deepEqual(
    record.toolCalls.map((c) => ({ name: c.name, ok: c.ok })),
    [{ name: 'dangerous_tool', ok: true }],
  );
  assert.equal(record.replyText, 'done');
});

test('history does not leak between two different senders', async () => {
  const { tool } = buildSpyTool();
  const histories: number[] = [];
  class Counting implements LlmClient {
    readonly label = 'counting';
    async chat(messages: LlmMessage[]): Promise<LlmReply> {
      histories.push(messages.filter((m) => m.role === 'user').length);
      return { text: 'ok', toolCalls: [] };
    }
  }
  const agent = new Agent(config, new Counting(), undefined, [tool]);
  await agent.handle('+18015550123', 'first');
  await agent.handle('+18015550123', 'second');
  await agent.handle('+18015559999', 'stranger');

  // owner turn 1 -> 1 user message, owner turn 2 -> 2, guest turn 1 -> 1 (fresh)
  assert.deepEqual(histories, [1, 2, 1]);
});

test('an unknown tool name is reported, not silently dropped', async () => {
  class AsksForGhost implements LlmClient {
    readonly label = 'ghost';
    private n = 0;
    async chat(): Promise<LlmReply> {
      this.n++;
      if (this.n === 1) {
        return { text: '', toolCalls: [{ id: 'g', name: 'no_such_tool', arguments: {} }] };
      }
      return { text: 'sorry', toolCalls: [] };
    }
  }
  const { tool } = buildSpyTool();
  const agent = new Agent(config, new AsksForGhost(), undefined, [tool]);
  const record = await agent.handle('+18015550123', 'go');
  assert.equal(record.toolCalls[0]!.name, 'no_such_tool');
  assert.equal(record.toolCalls[0]!.ok, false);
});

test('a throwing tool is recorded as failed, not as success', async () => {
  const thrower: Tool = {
    name: 'dangerous_tool',
    description: 'x',
    minRole: 'owner',
    parameters: { type: 'object', properties: {}, required: [] },
    async run() {
      throw new Error('ssh died');
    },
  };
  const agent = new Agent(config, new ScriptedLlm(), undefined, [thrower]);
  const record = await agent.handle('+18015550123', 'go');
  assert.equal(record.toolCalls[0]!.ok, false);
});
