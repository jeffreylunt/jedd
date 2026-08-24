import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALL_TOOLS, buildTools, registerable } from '../src/tools/index.js';
import { ok, type Tool } from '../src/tools/types.js';
import { testConfig } from './helpers.js';

/**
 * The read-only kill switch must cover EVERY write tool, at every role.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 *
 * `buildTools()` used to gate `readOnly` on the OWNER write list, so the guest
 * tool list was BYTE-IDENTICAL with writes on and off. `config.ts` documented
 * the two axes correctly — "the AUTHORISATION-independent kill switch… Neither
 * satisfies the other" — but the REGISTRY grouped tools by role and gated only
 * the owner group. **The contradiction lived in the shape of the registry, not
 * in any sentence, so the documentation actively protected the defect.**
 *
 * It was also DORMANT: no guest write tool existed, so every test passed. The
 * defect was due to arrive with the first one.
 *
 * ── 🔴 WHY THE INVARIANT IS QUANTIFIED ───────────────────────────────────────
 *
 * A test that enumerates today's tools CANNOT FAIL on a tool nobody has written
 * yet. So the rule is stated over the whole registry — "for every tool: writes
 * implies absent when readOnly" — and the case below actually INTRODUCES a new
 * guest write tool to prove the invariant reddens for one.
 *
 * A second hand-maintained GUEST_WRITE_TOOLS list would have fixed today's
 * instance and rebuilt the same trap one list further along.
 */

const guestWriteTool: Tool = {
  name: 'delete_everything',
  description: 'a guest-facing tool that mutates the homelab',
  minRole: 'guest',
  writes: true,
  parameters: { type: 'object', properties: {}, required: [] },
  async run() {
    return ok('did something destructive');
  },
};

const guestReadTool: Tool = {
  name: 'harmless_read',
  description: 'a guest-facing read',
  minRole: 'guest',
  writes: false,
  parameters: { type: 'object', properties: {}, required: [] },
  async run() {
    return ok('read something');
  },
};

test('🔴 a NEW guest write tool is absent when writes are disabled', () => {
  const gated = registerable([guestWriteTool, guestReadTool], testConfig({ readOnly: true }));
  assert.deepEqual(
    gated.map((t) => t.name),
    ['harmless_read'],
    'the kill switch must cover a guest write tool nobody had written when it was built',
  );
});

test('the same guest write tool IS present when writes are enabled', () => {
  // The inverting control. Without it, "absent" is equally consistent with the
  // filter dropping everything, which would be a passing test that proves nothing.
  const gated = registerable([guestWriteTool, guestReadTool], testConfig({ readOnly: false }));
  assert.deepEqual(gated.map((t) => t.name).sort(), ['delete_everything', 'harmless_read']);
});

test('🔴 the invariant holds over the WHOLE registry, not a named list', () => {
  const gated = registerable(ALL_TOOLS, testConfig({ readOnly: true }));
  for (const t of gated) {
    assert.equal(t.writes, false, `${t.name} writes but survived the read-only gate`);
  }
});

test('🔴 a tool that does not declare write-ness is REFUSED at registration', () => {
  // Not defaulted to false. A tool author who forgets is the exact case this
  // catches, and defaulting would silently pick the permissive answer.
  const undeclared = { ...guestReadTool, name: 'undeclared' } as Partial<Tool>;
  delete (undeclared as Record<string, unknown>)['writes'];
  assert.throws(
    () => registerable([undeclared as Tool], testConfig({ readOnly: true })),
    /undeclared.*declare|declare.*writes/i,
  );
});

// ── the existing owner behaviour must not regress ────────────────────────────

test('CONTROL: owner write tools are still gated exactly as before', () => {
  const off = buildTools(testConfig({ readOnly: true })).map((t) => t.name);
  const on = buildTools(testConfig({ readOnly: false })).map((t) => t.name);
  for (const name of ['restart_container', 'restart_arr_stack', 'shed_host_load', 'restore_qbit_speed']) {
    assert.ok(!off.includes(name), `${name} must be absent when read-only`);
    assert.ok(on.includes(name), `${name} must be present when writes are enabled`);
  }
});

test('CONTROL: read tools are unaffected by the kill switch', () => {
  const off = buildTools(testConfig({ readOnly: true })).map((t) => t.name);
  for (const name of ['library_search', 'homelab_status', 'docker_ps']) {
    assert.ok(off.includes(name), `${name} is a read and must survive read-only mode`);
  }
});

test('every tool in the shipped registry declares its write-ness', () => {
  for (const t of ALL_TOOLS) {
    assert.equal(typeof t.writes, 'boolean', `${t.name} does not declare writes`);
  }
});
