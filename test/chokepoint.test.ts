import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent } from '../src/agent.js';
import { assertShellIdentityIsSafe, loadConfig } from '../src/config.js';
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
    buildTools(shared, { safe: true, reason: 'pretend', evidence: [] }).some((t) => t.name === 'hp_shell'),
    true,
    'sanity: the verdict is what decides, so this arm is about the verdict below',
  );
});

test('🔴 hp_shell is NOT registered unless the boundary was PROVEN — omitting the proof is fail-closed', () => {
  // The whole point of the signature: a caller that forgets to run the probe
  // gets no free-form shell. Fail closed by construction rather than by
  // remembering to check, because the thing being protected against is exactly
  // someone forgetting.
  const split = testConfig({ shellSshHost: 'hp-jedd-shell', adminSshHost: 'hp' });
  assert.equal(
    buildTools(split).some((t) => t.name === 'hp_shell'),
    false,
    'no proof means no shell, even when the config looks perfect',
  );
  assert.equal(
    buildTools(split, { safe: false, reason: 'probe refused', evidence: [] }).some((t) => t.name === 'hp_shell'),
    false,
  );
});

test('CONTROL: hp_shell IS registered once the boundary is proven', () => {
  const split = testConfig({ shellSshHost: 'hp-jedd-shell', adminSshHost: 'hp' });
  assert.equal(
    buildTools(split, { safe: true, reason: 'proven', evidence: [] }).some((t) => t.name === 'hp_shell'),
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


test('🔴 an EMPTY HP_SHELL_SSH_HOST must not read as a different host', () => {
  // `??` does not fire on an empty string, so an unset-but-present variable used
  // to sail through the inequality check as a "different" host — a boundary made
  // of two strings, one of which was nothing at all.
  const saved = { shell: process.env['HP_SHELL_SSH_HOST'], admin: process.env['HP_ADMIN_SSH_HOST'], owner: process.env['OWNER_HANDLE'] };
  try {
    process.env['OWNER_HANDLE'] = '+18015550123';
    process.env['HP_ADMIN_SSH_HOST'] = 'hp';
    process.env['HP_SHELL_SSH_HOST'] = '';
    const empty = loadConfig();
    assert.equal(empty.shellSshHost, 'hp', 'an empty value must fall back to the admin host');
    assert.equal(empty.shellIdentityShared, true, 'and therefore register as SHARED, not split');
    assert.equal(assertShellIdentityIsSafe(empty).safe, false);

    // Whitespace is the same case wearing a hat.
    process.env['HP_SHELL_SSH_HOST'] = '   ';
    assert.equal(loadConfig().shellIdentityShared, true);

    // CONTROL: a real value still produces a split, so the check is about
    // emptiness and not about the fallback swallowing everything.
    process.env['HP_SHELL_SSH_HOST'] = 'hp-jedd-shell';
    const split = loadConfig();
    assert.equal(split.shellSshHost, 'hp-jedd-shell');
    assert.equal(split.shellIdentityShared, false);
  } finally {
    for (const [k, v] of [['HP_SHELL_SSH_HOST', saved.shell], ['HP_ADMIN_SSH_HOST', saved.admin], ['OWNER_HANDLE', saved.owner]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
