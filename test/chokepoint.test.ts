import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent } from '../src/agent.js';
import { assertShellIdentityIsSafe } from '../src/config.js';
import type { LlmClient, LlmReply } from '../src/llm.js';
import { ALL_TOOLS, buildTools, toolsForRole } from '../src/tools/index.js';
import type { Tool } from '../src/tools/types.js';
import { testConfig } from './helpers.js';

/**
 * The Agent SDK's `canUseTool` reads as a universal chokepoint and is not one —
 * auto-approved tools skip it entirely. That is a permission layer with a silent
 * bypass for exactly the tools someone classified as safe.
 *
 * These tests assert our gate has no such fast path: EVERY tool, including the
 * boring read-only ones, goes through the same check. "Read-only" is a claim
 * about a tool that someone will eventually get wrong.
 */

/** A model that demands one named tool, then stops. */
function demandTool(name: string): LlmClient {
  let n = 0;
  return {
    label: 'demander',
    async chat(): Promise<LlmReply> {
      n++;
      if (n === 1) return { text: '', toolCalls: [{ id: 'c1', name, arguments: {} }] };
      return { text: 'done', toolCalls: [] };
    },
  };
}

/** Wrap a real tool so we can see whether its body ran, without changing its identity. */
function spyOn(tool: Tool): { tool: Tool; ran: () => boolean } {
  let ran = false;
  return {
    tool: {
      ...tool,
      async run() {
        ran = true;
        return { ok: true, content: 'ran' };
      },
    },
    ran: () => ran,
  };
}

test('🔴 EVERY tool is subject to the gate — there is no auto-approve fast path', async () => {
  // A guest asks for each tool in turn. Owner-only tools must never execute;
  // guest tools must. If any owner tool ran, the gate has a bypass.
  const config = testConfig();
  for (const original of ALL_TOOLS) {
    const spy = spyOn(original);
    const agent = new Agent(config, demandTool(original.name), undefined, [spy.tool]);
    const record = await agent.handle('+15559998888', 'do the thing');

    if (original.minRole === 'owner') {
      assert.equal(spy.ran(), false, `${original.name} must NOT execute for a guest`);
      assert.equal(record.toolCalls[0]?.refused, true, `${original.name} must be recorded refused`);
    } else {
      assert.equal(spy.ran(), true, `${original.name} is a guest tool and should execute`);
    }
  }
});

test('CONTROL: the same enumeration as the OWNER runs every tool', async () => {
  // Without this, the test above would pass if the loop simply never dispatched
  // anything. It also proves every tool is reachable, so none is dead code that
  // the gate test silently skips.
  const config = testConfig();
  for (const original of ALL_TOOLS) {
    const spy = spyOn(original);
    const agent = new Agent(config, demandTool(original.name), undefined, [spy.tool]);
    await agent.handle('+18015550123', 'do the thing');
    assert.equal(spy.ran(), true, `${original.name} must execute for the owner`);
  }
});

test('the registry covers every tool — none can be added without a role', () => {
  // A tool with no minRole would default to whatever the object literal omitted.
  for (const tool of ALL_TOOLS) {
    assert.ok(
      tool.minRole === 'owner' || tool.minRole === 'guest',
      `${tool.name} has no valid minRole`,
    );
    assert.ok(tool.name.length > 0);
    assert.ok(tool.description.length > 20, `${tool.name} needs a real description for the model`);
  }
});

test('tool names are unique — a duplicate would shadow a gate decision', () => {
  const names = ALL_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, `duplicate tool name in ${names.join(', ')}`);
});

test('a guest is never even OFFERED an owner tool', () => {
  const guestTools = toolsForRole(ALL_TOOLS, 'guest');
  assert.equal(
    guestTools.some((t) => t.minRole === 'owner'),
    false,
  );
  assert.ok(guestTools.length > 0, 'guests must still have some tools');
});

test('🔴 hp_shell is NOT registered when the ssh identity split is missing', () => {
  const shared = testConfig({
    shellSshHost: 'hp',
    adminSshHost: 'hp',
    shellIdentityShared: true,
    allowSharedSshIdentity: false,
  });
  assert.equal(assertShellIdentityIsSafe(shared).safe, false);
  assert.equal(
    buildTools(shared).some((t) => t.name === 'hp_shell'),
    false,
    'a shell with docker privileges must not be offered at all',
  );
});

test('CONTROL: hp_shell IS registered once the identities differ', () => {
  const split = testConfig({ shellSshHost: 'hp-readonly', adminSshHost: 'hp' });
  assert.equal(assertShellIdentityIsSafe(split).safe, true);
  assert.equal(
    buildTools(split).some((t) => t.name === 'hp_shell'),
    true,
  );
});

test('the shared-identity escape hatch works but is labelled UNSAFE', () => {
  const overridden = testConfig({
    shellSshHost: 'hp',
    adminSshHost: 'hp',
    shellIdentityShared: true,
    allowSharedSshIdentity: true,
  });
  const verdict = assertShellIdentityIsSafe(overridden);
  assert.equal(verdict.safe, true);
  assert.match(verdict.reason, /UNSAFE/);
});

test('🔴 write tools do not exist at all in read-only mode', () => {
  const readOnly = buildTools(testConfig({ readOnly: true }));
  for (const name of ['restart_container', 'restart_arr_stack']) {
    assert.equal(
      readOnly.some((t) => t.name === name),
      false,
      `${name} must not be offered when writes are disabled`,
    );
  }
  // Control: they appear once writes are enabled, so the assertion above is
  // about the flag rather than about the tools never existing.
  const writable = buildTools(testConfig({ readOnly: false }));
  for (const name of ['restart_container', 'restart_arr_stack']) {
    assert.equal(
      writable.some((t) => t.name === name),
      true,
      `${name} must be offered when writes are enabled`,
    );
  }
});

test('every write tool is owner-only', () => {
  const writeTools = buildTools(testConfig({ readOnly: false })).filter(
    (t) => t.name.startsWith('restart_'),
  );
  assert.ok(writeTools.length >= 2);
  for (const tool of writeTools) {
    assert.equal(tool.minRole, 'owner', `${tool.name} must be owner-only`);
  }
});
