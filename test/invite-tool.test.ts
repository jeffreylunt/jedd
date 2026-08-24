import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { InviteLedger, QUOTA_MAX } from '../src/invite-ledger.js';
import { JfagoClient, type FetchImpl } from '../src/jfago.js';
import { buildTools } from '../src/tools/index.js';
import { makeInviteTool, type InviteDeps, type InviteSender } from '../src/tools/invite.js';
import { testConfig } from './helpers.js';

/** Deps good enough to REGISTER with. Registration must not require a live jfa-go. */
const inertDeps = (): InviteDeps => ({
  jfago: jfago().client,
  ledger: new InviteLedger(tmp()),
  send: async () => ({ delivered: null, detail: 'not sent in this test' }),
});

const tmp = () => join(mkdtempSync(join(tmpdir(), 'jedd-it-')), 'l.jsonl');
const GUEST = '+13854346068';
const JEFF = '+15555550100';
const TARGET = '+15551234567';

/** A jfa-go that mints fine; `revokeOk:false` makes revocation itself fail. */
function jfago(opts: { revokeOk?: boolean; mintFails?: boolean; unreadable?: boolean } = {}) {
  const deletes: unknown[] = [];
  const impl: FetchImpl = async (url, init) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const reply = (status: number, b: unknown) =>
      ({ ok: status < 400, status, text: async () => JSON.stringify(b) }) as unknown as Response;
    if (u.endsWith('/token/login')) return reply(200, { token: 't' });
    if (method === 'DELETE') { deletes.push(body); return reply(opts.revokeOk === false ? 500 : 200, {}); }
    if (method === 'POST') return reply(opts.mintFails ? 400 : 200, { success: true });
    return reply(200, { invites: opts.unreadable ? [] : [{ code: 'CODE1', label: lastLabel }] });
  };
  let lastLabel = '';
  const client = new JfagoClient({
    baseUrl: 'https://jf.invalid/accounts', username: 'u', password: 'p',
    inviteBaseUrl: 'https://jf.invalid/accounts', profile: 'Default', validityHours: 24, fetchImpl: impl, readBackDelayMs: 0,
  });
  // capture the label the tool generates so the read-back matches
  const origMint = client.mint.bind(client);
  client.mint = async (label: string) => { lastLabel = label; return origMint(label); };
  return { client, deletes };
}

const sender = (delivered: boolean | null): { send: InviteSender; sent: string[] } => {
  const sent: string[] = [];
  return { sent, send: async (to) => { sent.push(to); return { delivered, detail: 'x' }; } };
};

function ctx(role: 'guest' | 'owner' = 'guest', handle = GUEST, turns = [`my friend is ${TARGET}`]) {
  return { role, senderHandle: handle, config: testConfig({ readOnly: false }), userTurns: turns };
}

// ── 🔴 the failure path destroys the credential ──────────────────────────────

test('🔴 a FAILED delivery REVOKES the invite — a withheld link is still a link', async () => {
  const j = jfago();
  const s = sender(false);
  const tool = makeInviteTool({ jfago: j.client, ledger: new InviteLedger(tmp()), send: s.send });
  const r = await tool.run({ recipient: TARGET }, ctx());
  assert.equal(r.ok, false);
  assert.match(r.content, /REVOKED and no longer works/);
  assert.deepEqual(j.deletes, [{ code: 'CODE1' }], 'the credential must be destroyed, not hidden');
  assert.doesNotMatch(r.content, /jf\.invalid\/jellyfin\/invite/, 'and never repeated');
});

test('🔴 delivery failed AND revoke failed is reported as a LIVE credential', async () => {
  const j = jfago({ revokeOk: false });
  const tool = makeInviteTool({ jfago: j.client, ledger: new InviteLedger(tmp()), send: sender(false).send });
  const r = await tool.run({ recipient: TARGET }, ctx());
  assert.equal(r.ok, false);
  assert.match(r.content, /REVOKE FAILED/);
  assert.match(r.content, /a live single-use invite exists/i);
  assert.match(r.content, /CODE1/, 'the code is the only handle a human has');
});

test('🔴 null is NOT false — an unconfirmed send does not revoke', async () => {
  // The row exists from the moment it is sent and only acquires delivery on ACK.
  // Treating null as failure would revoke a working invite for every message in
  // its first few hundred milliseconds.
  const j = jfago();
  const tool = makeInviteTool({ jfago: j.client, ledger: new InviteLedger(tmp()), send: sender(null).send });
  const r = await tool.run({ recipient: TARGET }, ctx());
  assert.equal(r.ok, true);
  assert.deepEqual(j.deletes, [], 'nothing may be revoked on an absent verdict');
  assert.match(r.content, /delivery is not yet confirmed/);
});

// ── 🔴 provenance ────────────────────────────────────────────────────────────

test('🔴 a recipient the person never typed is REFUSED before anything is minted', async () => {
  const j = jfago();
  const s = sender(true);
  const tool = makeInviteTool({ jfago: j.client, ledger: new InviteLedger(tmp()), send: s.send });
  const r = await tool.run({ recipient: '+15559999999' }, ctx('guest', GUEST, ['can you invite my friend?']));
  assert.equal(r.ok, false);
  assert.match(r.content, /does not appear in anything this person typed/);
  assert.equal(s.sent.length, 0, 'nothing sent');
  assert.deepEqual(j.deletes, [], 'and nothing minted to revoke');
});

// ── quota and dedupe ─────────────────────────────────────────────────────────

test('a guest is rate-limited at the quota; the OWNER is exempt', async () => {
  const ledger = new InviteLedger(tmp());
  const now = new Date();
  for (let i = 0; i < QUOTA_MAX; i++) {
    ledger.record({ at: now.toISOString(), by: GUEST, recipient: `+1555000${i}`, label: `l${i}`, outcome: 'confirmed' });
    ledger.record({ at: now.toISOString(), by: JEFF, recipient: `+1555111${i}`, label: `j${i}`, outcome: 'confirmed' });
  }
  const tool = makeInviteTool({ jfago: jfago().client, ledger, send: sender(true).send });
  assert.match((await tool.run({ recipient: TARGET }, ctx('guest'))).content, /RATE_LIMITED/);
  const ownerCtx = ctx('owner', JEFF, [`invite ${TARGET}`]);
  assert.equal((await tool.run({ recipient: TARGET }, ownerCtx)).ok, true, 'the owner is exempt');
});

test('🔴 a FAILED invite does not consume the quota', async () => {
  const ledger = new InviteLedger(tmp());
  const tool = makeInviteTool({ jfago: jfago().client, ledger, send: sender(false).send });
  for (let i = 0; i < QUOTA_MAX + 1; i++) {
    await tool.run({ recipient: `+1555${i}` }, ctx('guest', GUEST, [`+1555${i}`]));
  }
  assert.equal(ledger.usedQuota(GUEST), 0, 'our failure must not cost them slots');
  assert.ok(ledger.uncharged(GUEST) > 0, 'but it is visible');
});

test('a repeat to the same recipient within the window is refused', async () => {
  const ledger = new InviteLedger(tmp());
  const tool = makeInviteTool({ jfago: jfago().client, ledger, send: sender(true).send });
  await tool.run({ recipient: TARGET }, ctx());
  const again = await tool.run({ recipient: TARGET }, ctx());
  assert.match(again.content, /ALREADY_INVITED/);
});

// ── the irreversible half ────────────────────────────────────────────────────

test('🔴 a successful invite NEVER implies the account can be undone', async () => {
  const tool = makeInviteTool({ jfago: jfago().client, ledger: new InviteLedger(tmp()), send: sender(true).send });
  const r = await tool.run({ recipient: TARGET }, ctx());
  assert.match(r.content, /their account is permanent/);
  assert.match(r.content, /cannot be undone by expiring the invite/);
});

test('an orphaned mint is surfaced and nothing is sent', async () => {
  const j = jfago({ unreadable: true });
  const s = sender(true);
  const tool = makeInviteTool({ jfago: j.client, ledger: new InviteLedger(tmp()), send: s.send });
  const r = await tool.run({ recipient: TARGET }, ctx());
  assert.equal(r.ok, false);
  assert.match(r.content, /ORPHANED/);
  assert.equal(s.sent.length, 0, 'we cannot send a link we could not read back');
});

// ── 🔴 REGISTRATION: the tool was built, tested, swept — and unreachable ─────

test('🔴 invite_to_jellyfin IS REGISTERED when jfa-go is configured and writes are on', () => {
  const names = buildTools(testConfig({ readOnly: false }), undefined, { invite: inertDeps() }).map((t) => t.name);
  assert.ok(names.includes('invite_to_jellyfin'), `absent from: ${names.join(', ')}`);
});

test('🔴 it is absent when writes are DISABLED — it is a guest write tool', () => {
  const names = buildTools(testConfig({ readOnly: true }), undefined, { invite: inertDeps() }).map((t) => t.name);
  assert.ok(!names.includes('invite_to_jellyfin'));
});

test('it is absent when jfa-go is NOT configured — an absent tool beats one that always fails', () => {
  const config = testConfig({ readOnly: false });
  const names = buildTools(
    { ...config, jfago: { ...config.jfago, password: '' } },
    undefined,
    { invite: inertDeps() },
  ).map((t) => t.name);
  assert.ok(!names.includes('invite_to_jellyfin'));
});

test('it is absent when no send path was injected — it cannot deliver what it mints', () => {
  const names = buildTools(testConfig({ readOnly: false }), undefined, {}).map((t) => t.name);
  assert.ok(!names.includes('invite_to_jellyfin'));
});

test('CONTROL: the registry is not empty in any of those cases', () => {
  assert.ok(buildTools(testConfig({ readOnly: true }), undefined, {}).length > 3);
});
