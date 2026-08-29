import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent } from '../src/agent.js';
import type { LlmClient, LlmMessage, LlmReply } from '../src/llm.js';
import { ALL_TOOLS, assertNamedProducersExist } from '../src/tools/index.js';
import { jellyfinSessions } from '../src/tools/homelab.js';
import type { Tool } from '../src/tools/types.js';
import { testConfig } from './helpers.js';

const config = testConfig();
const OWNER = '+18015550123';

/**
 * ── WHAT THESE TESTS CAN AND CANNOT SHOW ────────────────────────────────────
 *
 * They pin the MECHANISM: that a narrow tool's scope note reaches the model, on
 * every exit path, in the tool message rather than the reply, and that a note
 * naming a tool which is not registered refuses to boot.
 *
 * 🔴 THEY SAY NOTHING ABOUT WHETHER IT REPAIRS THE DEFECT. That is a behavioural
 * claim about a real model and only a live run can settle it —
 * `scripts/probe-result-scope.ts`, which runs both arms against the real model
 * on the real question. A previous guard in this same area was green here, 14/14
 * on mutations, and did nothing whatsoever on live turns. Green is necessary and
 * is not the deliverable.
 */

/** Asks for one named tool, then answers. Records every message it was shown. */
class ScriptedLlm implements LlmClient {
  readonly label = 'scripted';
  readonly seen: LlmMessage[][] = [];
  private calls = 0;

  constructor(private readonly toolName: string) {}

  async chat(messages: LlmMessage[]): Promise<LlmReply> {
    this.seen.push(messages.map((m) => ({ ...m })));
    this.calls++;
    if (this.calls === 1) {
      return { text: '', toolCalls: [{ id: 'c1', name: this.toolName, arguments: {} }] };
    }
    return { text: 'done', toolCalls: [] };
  }
}

/** The narrow tool, in each of the three ways a tool can come back. */
function narrowTool(outcome: 'ok' | 'fail' | 'throw', scopeNote?: string): Tool {
  return {
    name: 'narrow_reader',
    description: 'Reads the narrow thing.',
    minRole: 'owner',
    writes: false,
    ...(scopeNote ? { scopeNote } : {}),
    parameters: { type: 'object', properties: {}, required: [] },
    async run() {
      if (outcome === 'throw') throw new Error('boom');
      return { ok: outcome === 'ok', content: 'nobody is playing anything' };
    },
  };
}

const NOTE = 'SCOPE — live only. It does not cover history. Read history with homelab_read.';

/** The tool message the model was shown, from the LAST round it was asked. */
function lastToolMessage(llm: ScriptedLlm): string {
  const round = llm.seen.at(-1)!;
  const toolMsg = round.filter((m) => m.role === 'tool').at(-1);
  assert.ok(toolMsg, 'the model must have been shown a tool result');
  return toolMsg.content;
}

/**
 * 🔴 THE THREE EXIT PATHS, ASSERTED SEPARATELY.
 *
 * `jellyfin_sessions` alone has three returns — an unreachable server, an
 * unparseable body, and the successful narrow answer — and the measured defect
 * happens on the SUCCESSFUL one. If the note were appended inside `run()` any of
 * these would be a path where it is silently missing, and a missing note is
 * invisible: the result still looks right. The loop appends it at the single
 * point a result enters history, which is why one assertion per path is enough
 * to cover every tool rather than every tool needing its own.
 */
for (const outcome of ['ok', 'fail', 'throw'] as const) {
  test(`the scope note reaches the model on a ${outcome.toUpperCase()} result`, async () => {
    const llm = new ScriptedLlm('narrow_reader');
    const agent = new Agent(config, llm, undefined, [narrowTool(outcome, NOTE)]);

    const record = await agent.handle(OWNER, 'has tom watched anything');

    assert.match(lastToolMessage(llm), /does not cover history/);
    // The outcome flag is untouched by the append — a failure is still a failure.
    assert.equal(record.toolCalls[0]!.ok, outcome === 'ok');
  });
}

test('FAILING CONTROL: the same tool WITHOUT a note shows the model the bare result', async () => {
  // Ablates exactly one field. Without this, the assertions above are equally
  // consistent with the harness printing the note from somewhere else.
  const llm = new ScriptedLlm('narrow_reader');
  const agent = new Agent(config, llm, undefined, [narrowTool('ok')]);

  await agent.handle(OWNER, 'has tom watched anything');

  const shown = lastToolMessage(llm);
  assert.equal(shown, 'nobody is playing anything');
  assert.doesNotMatch(shown, /SCOPE/);
});

test('🔴 the note goes to the MODEL, never into the reply the user is sent', async () => {
  // The README promises no output filtering anywhere in the loop. This is an
  // input to the model, not an edit to its answer, and the difference has to be
  // asserted rather than intended.
  const llm = new ScriptedLlm('narrow_reader');
  const agent = new Agent(config, llm, undefined, [narrowTool('ok', NOTE)]);

  const record = await agent.handle(OWNER, 'has tom watched anything');

  assert.equal(record.replyText, 'done');
  assert.doesNotMatch(record.replyText, /SCOPE/);
});

test('the note is appended AFTER the result, so the tool still says what happened', async () => {
  const llm = new ScriptedLlm('narrow_reader');
  const agent = new Agent(config, llm, undefined, [narrowTool('ok', NOTE)]);

  await agent.handle(OWNER, 'has tom watched anything');

  assert.equal(lastToolMessage(llm), `nobody is playing anything\n\n${NOTE}`);
});

/**
 * ── THE INVARIANT: A NOTE MAY NOT POINT AT A TOOL THAT IS NOT THERE ─────────
 */

test('🔴 a scope note naming an UNREGISTERED tool refuses to boot', () => {
  const orphan: Tool = {
    ...narrowTool('ok', 'Read it with title_details instead.'),
    name: 'narrow_reader',
  };
  assert.throws(
    () => assertNamedProducersExist([orphan]),
    /narrow_reader.*title_details.*NOT registered/s,
    'a note telling the model to call something absent is this defect pointed backwards',
  );
});

test('FAILING CONTROL: the same note IS accepted when the named tool is registered', () => {
  // Without this the test above passes for a rule that rejects every note.
  const named = ALL_TOOLS.find((t) => t.name === 'title_details')!;
  const orphan = narrowTool('ok', 'Read it with title_details instead.');
  assert.doesNotThrow(() => assertNamedProducersExist([orphan, named]));
});

test('MUTATION: the invariant is not satisfied by the description alone', () => {
  // Pins that `assertNamedProducersExist` really reads `scopeNote`. Reverting it
  // to scan only `description` makes this test pass — so it asserts the note
  // field specifically, with a description that names nothing.
  const scanned = narrowTool('ok', 'Read it with title_details instead.');
  assert.doesNotMatch(scanned.description, /title_details/);
  assert.throws(() => assertNamedProducersExist([scanned]), /title_details/);
});

/**
 * ── THE TOOL THE DEFECT WAS MEASURED ON ────────────────────────────────────
 */

test('jellyfin_sessions carries a scope note, and it names a REGISTERED tool', () => {
  const note = jellyfinSessions.scopeNote;
  assert.ok(note, 'this is the tool the 8/10 denial was measured on');
  // Not a string match on the prose — the check is that whatever it names is
  // real, run through the same invariant the registry uses.
  assert.doesNotThrow(() => assertNamedProducersExist(ALL_TOOLS));
  assert.match(note, /homelab_read/);
});

test('🔴 the note REFUSES the wrong inference, not just states the scope', () => {
  // The measured failure is not "the model did not know the scope". It is the
  // model treating an empty live-sessions result as evidence that nothing was
  // ever watched. A note that only says what the tool covers leaves that step
  // untouched, so the refusal of it is asserted separately from the scope line.
  const note = jellyfinSessions.scopeNote!;
  assert.match(note, /NOT evidence/);
  assert.match(note, /currently-playing sessions ONLY/);
});
