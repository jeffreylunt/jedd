import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent } from '../src/agent.js';
import type { LlmClient, LlmMessage, LlmReply } from '../src/llm.js';
import { ALL_TOOLS, assertNamedProducersExist, registerable } from '../src/tools/index.js';
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

    /**
     * 🔴 THE AUDIT REASON MUST NOT ABSORB THE NOTE, and this is not tidiness.
     * `toolCalls[].error` is `firstLines(content)` and it is what
     * `data/audit.jsonl` keeps about a failure forever. The blank line in the
     * `\n\n` separator is the ONLY reason the note falls outside the first two
     * lines — collapse it to `\n` and every recorded reason grows 300 characters
     * of note; PREPEND it and the reason is replaced by the note entirely, which
     * is the cause-less error this repo has already been bitten by. Without this
     * assertion the whole property rests on an accident nothing pins.
     */
    if (outcome !== 'ok') {
      const reason = record.toolCalls[0]!.error!;
      assert.doesNotMatch(reason, /SCOPE/, 'the note must not reach the durable record');
      assert.match(reason, outcome === 'fail' ? /nobody is playing anything/ : /threw: boom/);
    }
  });
}

test('🔴 END TO END: the REAL jellyfin_sessions note reaches the model tool message', async () => {
  /**
   * Everything else here drives `narrow_reader`, a fixture. That left the
   * PRODUCTION tool covered only by assertions about its FIELD — so deleting
   * `scopeNote` from `jellyfin_sessions` would kill only field-presence tests,
   * and nothing showing the sentence ever arrives anywhere. This drives the real
   * tool object through the real loop.
   *
   * It takes the FAILURE path: `testConfig()` points at no live Jellyfin, so
   * `jellyfinGet` cannot succeed. Deliberate — that is the path no fixture
   * covers and the one whose wording is hardest to get right.
   */
  const llm = new ScriptedLlm('jellyfin_sessions');
  const agent = new Agent(config, llm, undefined, [jellyfinSessions]);

  const record = await agent.handle(OWNER, 'has tom watched anything');

  const shown = lastToolMessage(llm);
  assert.match(shown, /NOT evidence/);
  assert.match(shown, /homelab_read/);
  assert.equal(record.toolCalls[0]!.ok, false);
  assert.doesNotMatch(record.toolCalls[0]!.error!, /SCOPE/);
});

test('FAILING CONTROL: the same tool WITHOUT a note shows the model the bare result', async () => {
  // Ablates exactly one field. Without this, the assertions above are equally
  // consistent with the harness printing the note from somewhere else.
  const llm = new ScriptedLlm('narrow_reader');
  const agent = new Agent(config, llm, undefined, [narrowTool('ok')]);

  await agent.handle(OWNER, 'has tom watched anything');

  // Exact equality, so nothing extra can be appended and still pass. The
  // `doesNotMatch(/SCOPE/)` that used to follow was implied by it, not a second
  // check.
  assert.equal(lastToolMessage(llm), 'nobody is playing anything');
});

/**
 * ⚠️ DELETED RATHER THAN LEFT GREEN: a test asserting the note never reaches
 * `replyText`. `ScriptedLlm` returns the constant 'done' and ignores the
 * messages entirely, so `replyText` CANNOT vary with tool content and the test
 * could not have failed for the reason its name gave. The claim it appeared to
 * guard — the README's "no output filtering anywhere in the loop" — is real, and
 * is held by the append site itself, which writes into the tool message and
 * never touches `replyText`. A stub that cannot express the failure is not
 * coverage of it, and leaving it in made this file read as though that property
 * were pinned.
 */

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
  assert.throws(() => assertNamedProducersExist([scanned]), /title_details/);
});

/**
 * ── THE TOOL THE DEFECT WAS MEASURED ON ────────────────────────────────────
 */

test('jellyfin_sessions carries a scope note, and it names a REGISTERED tool', () => {
  const note = jellyfinSessions.scopeNote;
  assert.ok(note, 'this is the tool the 8/10 denial was measured on');
  /**
   * ⚠️ NOT `assertNamedProducersExist(ALL_TOOLS)`, which was here first and was
   * worthless: it passes under every mutation of this feature. It is a global
   * registry-health check that boot and `registry-coverage.test.ts` already
   * make, and sitting in this test it would have READ as evidence about this
   * note while being evidence about nothing.
   *
   * What bites is running the invariant over THIS tool ALONE — nothing else in
   * the array can satisfy a name it invents.
   */
  assert.throws(() => assertNamedProducersExist([jellyfinSessions]), /homelab_read/);
  // ⚠️ A NAME-ONLY stand-in, not the real `homelab_read`: that tool's own
  // description names five others, so passing it here would drag their
  // dependencies in and could fail for reasons unrelated to this note. The
  // invariant only ever looks at names, so a stub is the honest isolate.
  const standIn: Tool = { ...narrowTool('ok'), name: 'homelab_read', description: 'stand-in' };
  assert.doesNotThrow(() => assertNamedProducersExist([jellyfinSessions, standIn]));
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


/**
 * ── 🔴 THE HOLE THE FIRST VERSION OF THIS FEATURE LEFT ──────────────────────
 *
 * `assertNamedProducersExist` runs BEFORE `registerable()`'s config filters, so
 * its idea of "registered" is "defined in the source arrays". A note naming a
 * tool that exists in code but is filtered off THIS deployment booted green — a
 * guard reading as though it covered the class while covering one instance of
 * it, which is the failure this whole branch is about. The post-filter loop at
 * the end of `registerable()` closes it, and these are the only things keeping
 * it closed.
 */

test('🔴 a scope note naming a tool this DEPLOYMENT filtered out refuses to boot', () => {
  // `livetv_status` is real and needs Dispatcharr. Without it the tool is
  // filtered out of the registry, so a note naming it points at nothing HERE —
  // even though the name is perfectly valid in code and the pre-filter rule
  // sees it as present.
  const noDispatcharr = testConfig({
    services: { ...testConfig().services, dispatcharr: false },
  });
  const withNote = narrowTool('ok', 'Use livetv_status for that.');
  assert.throws(
    () => registerable([...ALL_TOOLS, withNote], noDispatcharr),
    /narrow_reader.*livetv_status.*NOT registered on this deployment/s,
  );
});

test('FAILING CONTROL: the identical note boots fine where that tool IS registered', () => {
  // Same tools, same note, one config field different. Without this, the test
  // above would pass just as well for a rule that rejected every note.
  const withNote = narrowTool('ok', 'Use livetv_status for that.');
  assert.doesNotThrow(() => registerable([...ALL_TOOLS, withNote], testConfig()));
});

test('the shipped registry passes the post-filter rule on a full deployment', () => {
  // `jellyfin_sessions` names `homelab_read` and the two are NOT gated alike —
  // one needs Jellyfin, the other any one of five services. This asserts the
  // coincidence currently holds rather than leaving it reasoned about.
  assert.doesNotThrow(() => registerable(ALL_TOOLS, testConfig()));
});
