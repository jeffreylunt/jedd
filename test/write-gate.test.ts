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

// ── 🔴 the combination that did not exist when the gate was built ────────────

test('🔴 GUEST WRITE tools are absent when writes are disabled', async () => {
  // add_movie/add_series are the first real writes:true at minRole:'guest'.
  // Before registerable() quantified the invariant, exactly these would have been
  // registered with JEDD_ALLOW_WRITES unset.
  const off = buildTools(testConfig({ readOnly: true })).map((t) => t.name);
  const on = buildTools(testConfig({ readOnly: false })).map((t) => t.name);
  for (const name of ['add_movie', 'add_series']) {
    assert.ok(!off.includes(name), `${name} must be absent when read-only`);
    assert.ok(on.includes(name), `${name} must be present when writes are enabled`);
  }
});

test('🔴 writes:true and the guest gate are paired explicitly, not implied', async () => {
  const tools = buildTools(testConfig({ readOnly: false }));
  for (const name of ['add_movie', 'add_series']) {
    const t = tools.find((x) => x.name === name)!;
    assert.equal(t.writes, true, `${name} mutates and must say so`);
    assert.equal(t.minRole, 'guest', `${name} is available to guests by Jeff's decision`);
  }
});

test('the request_media stub is gone — it reported a queue position for work nothing performed', async () => {
  const on = buildTools(testConfig({ readOnly: false })).map((t) => t.name);
  assert.ok(!on.includes('request_media'), 'the stub must not ship alongside a real add path');

  // 🔴 THE ASSERTION ABOVE WAS TRUE FOR A MONTH WHILE THE TRAP WAS STILL LIVE.
  // Un-registering the tool left `requestMedia` exported from tools/media.ts,
  // appending to `data/requests.jsonl` — a second store of what is being
  // fetched, one import away from shipping beside the arr queue, and looking for
  // all the world like something left out by mistake. A registry-absence test
  // cannot see a tool that is not registered YET. Assert the SYMBOL is gone.
  const media = await import('../src/tools/media.js');
  assert.ok(
    !('requestMedia' in media),
    'requestMedia must not exist at all — a dormant second source of download state is the ' +
      'exact defect check_status was built to make unrepresentable.',
  );
});
