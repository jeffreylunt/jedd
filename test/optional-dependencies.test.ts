import assert from 'node:assert/strict';
import { test } from 'node:test';
import { probeLlm } from '../src/llm.js';
import { buildTools } from '../src/tools/index.js';
import { testConfig } from './helpers.js';

/**
 * OPTIONAL DEPENDENCIES MUST ACTUALLY BE OPTIONAL.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 *
 * Jedd is meant to drop into someone else's homelab: they set `.env`, point it
 * at what they have, and it runs. Measured before this file existed, a stranger
 * with only Ollama and Sonarr was offered **30 tools, roughly 20 of which could
 * not work** — including 12 that reach the homelab over ssh when no ssh host
 * had been configured at all.
 *
 * 🔴 THE FAILURE MODE IS THE DANGEROUS ONE, NOT THE ANNOYING ONE. A missing
 * dependency that CRASHES is merely unusable. A missing dependency that leaves
 * a tool REGISTERED is worse: the bot boots clean, reports healthy, offers the
 * capability to the model, and the model offers it to a person — and it fails
 * only at the moment somebody is relying on it. Absent beats always-failing.
 *
 * ── WHY REGISTRATION IS GATED ON CONFIG, NOT ON REACHABILITY ─────────────────
 *
 * Config presence is statically checkable and cannot become true later: nobody
 * set `HP_ADMIN_SSH_HOST`, so there is no homelab to reach, and that is a fact
 * about the deployment. Reachability is a fact about this SECOND — a host that
 * is down at 03:00 is normally up at 03:05. Gating registration on a live probe
 * would silently delete twelve tools from a working install because one ssh
 * call timed out during boot.
 *
 * So: **config presence decides the registry; reachability only warns.**
 */

/** The tools that cannot do anything without an ssh path to the homelab. */
const SSH_TOOLS = [
  'docker_ps',
  'docker_inspect',
  'docker_logs',
  'container_netns',
  'channel_health',
  'restart_container',
  'restart_arr_stack',
  'shed_host_load',
  'restore_qbit_speed',
  'diagnose_host_contention',
  'livetv_status',
  'add_audiobook',
];

test('🔴 with no homelab ssh configured, NO ssh-dependent tool is registered', async () => {
  const tools = buildTools(testConfig({ homelabSshConfigured: false, readOnly: false })).map((t) => t.name);
  const offered = SSH_TOOLS.filter((n) => tools.includes(n));
  assert.deepEqual(
    offered,
    [],
    `a deployment with no ssh host was still offered: ${offered.join(', ')}. ` +
      'Every one of these fails at the moment somebody relies on it.',
  );
});

test('CONTROL: with ssh configured, those same tools ARE registered', async () => {
  // Without this the test above passes trivially if the tools are renamed or
  // deleted — it would be asserting the absence of things that never exist.
  const tools = buildTools(testConfig({ homelabSshConfigured: true, readOnly: false })).map((t) => t.name);
  const missing = SSH_TOOLS.filter((n) => !tools.includes(n));
  assert.deepEqual(missing, [], `ssh is configured but these went missing: ${missing.join(', ')}`);
});

test('🔴 the ssh gate is about ssh, not about writes — read-only ssh tools go too', async () => {
  // `readOnly` already removes the write tools. If the ssh gate accidentally
  // rode on that flag, the READ tools would survive and still fail.
  const tools = buildTools(testConfig({ homelabSshConfigured: false, readOnly: true })).map((t) => t.name);
  for (const name of ['docker_ps', 'docker_inspect', 'docker_logs', 'container_netns']) {
    assert.equal(tools.includes(name), false, `${name} is a READ tool and still needs ssh`);
  }
});

/**
 * ── THE ORPHANED CONSUMER, SECOND INSTANCE ───────────────────────────────────
 *
 * `send_ebook`/`search_ebook` are already gated atomically on SMTP. But the
 * ADDRESS-INTAKE half of the same flow — `save_kindle_email` and
 * `kindle_status` — was registered unconditionally. On a deploy with no SMTP a
 * guest could hand over their Kindle address and be told it was SAVED, with
 * nothing in the registry that could ever send them a book.
 *
 * That is the same shape as the original defect (a tool naming a companion that
 * does not exist), just quieter: nothing errors, it simply dead-ends.
 */
test('🔴 no SMTP: the WHOLE kindle flow is absent, intake included', async () => {
  const tools = buildTools(testConfig({ kindle: { ...testConfig().kindle, smtpPassword: '' } })).map(
    (t) => t.name,
  );
  for (const name of ['send_ebook', 'search_ebook', 'save_kindle_email', 'kindle_status']) {
    assert.equal(
      tools.includes(name),
      false,
      `${name} survived with no SMTP — an address intake with no delivery half`,
    );
  }
});

test('CONTROL: with SMTP and an ebook dep, the whole flow is present', async () => {
  const ebook = { send: async () => ({ state: 'accepted' as const, detail: 'stub' }) } as never;
  const tools = buildTools(testConfig({ readOnly: false }), undefined, { ebook }).map((t) => t.name);
  for (const name of ['send_ebook', 'search_ebook', 'save_kindle_email', 'kindle_status']) {
    assert.equal(tools.includes(name), true, `${name} is missing though SMTP is configured`);
  }
});

/**
 * ── A HALF-GATE IS NOT A GATE ────────────────────────────────────────────────
 *
 * `invite_to_jellyfin` checked `jfago.password` but never `jfago.baseUrl`, so a
 * config with a password and no URL registered a tool that could only ever fire
 * requests at an empty base. The gate must name EVERY field the tool needs.
 */
test('🔴 jfa-go with a password but NO base url does not register the invite tool', async () => {
  const invite = { mint: async () => ({ ok: true }) } as never;
  // readOnly:false matters — invite_to_jellyfin is a WRITE tool, so with the
  // default read-only config it would be absent regardless of the gate, and this
  // test would pass without testing anything. The control below caught exactly that.
  const cfg = testConfig({ readOnly: false, jfago: { ...testConfig().jfago, baseUrl: '', password: 'set' } });
  const tools = buildTools(cfg, undefined, { invite }).map((t) => t.name);
  assert.equal(tools.includes('invite_to_jellyfin'), false, 'registered against an empty base URL');
});

test('CONTROL: jfa-go with BOTH url and password does register it', async () => {
  const invite = { mint: async () => ({ ok: true }) } as never;
  const cfg = testConfig({ readOnly: false, jfago: { ...testConfig().jfago, baseUrl: 'http://jfa.invalid:8056', password: 'set' } });
  const tools = buildTools(cfg, undefined, { invite }).map((t) => t.name);
  assert.equal(tools.includes('invite_to_jellyfin'), true);
});

/**
 * ── THE MODEL: REQUIRED FOR FUNCTION, WARNED AT BOOT, NEVER FATAL ────────────
 *
 * Nothing else in the boot path contacts the model, so an unreachable endpoint
 * used to be invisible until the first message — and then every turn threw while
 * the process stayed up and healthy, so a person texted and got silence.
 *
 * `probeLlm` must DISCRIMINATE, not merely "not crash": reachable-with-the-model
 * and reachable-WITHOUT-it are different failures, and the second one passes
 * every connectivity check ever written.
 */
test('probeLlm: reachable and carrying the model is ok', async () => {
  const cfg = testConfig();
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ models: [{ name: cfg.llm.model }] }), { status: 200 })) as typeof fetch;
  const r = await probeLlm(cfg, fetchImpl);
  assert.equal(r.ok, true, r.detail);
});

test('🔴 probeLlm: reachable but WITHOUT the configured model is NOT ok', async () => {
  // The nastiest case: every connectivity check passes and the name is only
  // wrong at generation time.
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ models: [{ name: 'some-other-model' }] }), { status: 200 })) as typeof fetch;
  const r = await probeLlm(testConfig(), fetchImpl);
  assert.equal(r.ok, false);
  assert.match(r.detail, /some-other-model/, 'must name what IS there — a typo is invisible on its own');
});

test('🔴 probeLlm: unreachable is NOT ok, and never throws', async () => {
  const fetchImpl = (async () => {
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;
  const r = await probeLlm(testConfig(), fetchImpl);
  assert.equal(r.ok, false);
  assert.match(r.detail, /unreachable/);
});

test('probeLlm: a non-200 is NOT ok', async () => {
  const fetchImpl = (async () => new Response('nope', { status: 500 })) as typeof fetch;
  const r = await probeLlm(testConfig(), fetchImpl);
  assert.equal(r.ok, false);
  assert.match(r.detail, /500/);
});
