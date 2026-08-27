import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JfagoClient, type FetchImpl } from '../src/jfago.js';

interface Call { url: string; method: string; body: unknown }

function scripted(handler: (c: Call, n: number) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const impl: FetchImpl = async (url, init) => {
    const c: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(c);
    const r = handler(c, calls.length - 1);
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      text: async () => JSON.stringify(r.body),
    } as unknown as Response;
  };
  return { impl, calls };
}

const client = (impl: FetchImpl) =>
  new JfagoClient({
    // 🔴 The admin API and the public signup base are DIFFERENT URLs, and this
    // fixture keeps them different on purpose: when they agree, nothing can
    // detect a link built from the wrong one.
    baseUrl: 'http://jfa-go.invalid:8056',
    username: 'u', password: 'p',
    inviteBaseUrl: 'https://jf.invalid/accounts',
    profile: 'Default', validityHours: 24, fetchImpl: impl, readBackDelayMs: 0,
  });

const TOKEN = { token: 'tok' };

// ── what the invite IS ───────────────────────────────────────────────────────

test('🔴 the invite is SINGLE-USE and the ACCOUNT it creates does not expire', async () => {
  // user-expiry:false is the flag that sets the stakes: revocable until
  // redeemed, irreversible after.
  const { impl, calls } = scripted((c) =>
    c.url.endsWith('/token/login') ? { body: TOKEN }
      : c.method === 'POST' ? { body: { success: true } }
      : { body: { invites: [{ code: 'ABC123', label: 'jedd-1' }] } });
  const r = await client(impl).mint('jedd-1');
  assert.equal(r.state, 'minted');
  const create = calls.find((c) => c.method === 'POST')!.body as Record<string, unknown>;
  assert.equal(create['remaining-uses'], 1);
  assert.equal(create['multiple-uses'], false);
  assert.equal(create['user-expiry'], false);
  assert.equal(create['hours'], 24);
});

// ── 🔴 the orphan window ─────────────────────────────────────────────────────

test('🔴 created-but-unreadable is ORPHANED and says a LIVE invite exists', async () => {
  // POST /invites answers {success:true} and nothing else, so the code is read
  // back by label. A miss leaves a live credential we cannot NAME, and therefore
  // cannot revoke. This is the one outcome a human must see.
  const { impl } = scripted((c) =>
    c.url.endsWith('/token/login') ? { body: TOKEN }
      : c.method === 'POST' ? { body: { success: true } }
      : { body: { invites: [] } });
  const r = await client(impl).mint('jedd-lost');
  assert.equal(r.state, 'orphaned');
  if (r.state !== 'orphaned') throw new Error('unreachable');
  assert.match(r.detail, /CREATED in jfa-go but its code could not be read back/);
  assert.match(r.detail, /Delete it by hand/);
  assert.match(r.detail, /jedd-lost/, 'the label is the only handle a human has');
});

test('the read-back RETRIES — GET can lag the POST', async () => {
  let listCalls = 0;
  const { impl } = scripted((c) => {
    if (c.url.endsWith('/token/login')) return { body: TOKEN };
    if (c.method === 'POST') return { body: { success: true } };
    listCalls += 1;
    return listCalls < 2 ? { body: { invites: [] } } : { body: { invites: [{ code: 'X9', label: 'jedd-2' }] } };
  });
  const r = await client(impl).mint('jedd-2');
  assert.equal(r.state, 'minted');
  if (r.state !== 'minted') throw new Error('unreachable');
  assert.equal(r.invite.code, 'X9');
});

// ── 🔴 revocation, and its own failure ───────────────────────────────────────

test('🔴 revoke DELETEs by code', async () => {
  const { impl, calls } = scripted((c) => (c.url.endsWith('/token/login') ? { body: TOKEN } : { body: {} }));
  const r = await client(impl).revoke('ABC123');
  assert.equal(r.revoked, true);
  const del = calls.find((c) => c.method === 'DELETE')!;
  assert.deepEqual(del.body, { code: 'ABC123' });
});

test('🔴 a FAILED revocation says the credential is still live and names the code', async () => {
  // A live credential we know about and could not kill is exactly the case a
  // human must see, so it must never be reported quietly.
  const { impl } = scripted((c) =>
    c.url.endsWith('/token/login') ? { body: TOKEN } : { status: 500, body: {} });
  const r = await client(impl).revoke('ABC123');
  assert.equal(r.revoked, false);
  assert.match(r.detail, /STILL LIVE/);
  assert.match(r.detail, /ABC123/);
});

test('revocation that cannot even authenticate is also STILL LIVE', async () => {
  const { impl } = scripted(() => ({ status: 401, body: {} }));
  const r = await client(impl).revoke('ABC123');
  assert.equal(r.revoked, false);
  assert.match(r.detail, /STILL LIVE/);
});

test('a create that jfa-go refuses is FAILED — no credential exists to worry about', async () => {
  const { impl } = scripted((c) =>
    c.url.endsWith('/token/login') ? { body: TOKEN } : { status: 400, body: {} });
  const r = await client(impl).mint('jedd-3');
  assert.equal(r.state, 'failed');
});

test("🔴 the signup link is built from JFA-GO's public base, not the admin API and not Jellyfin", async () => {
  // This assertion used to read `.../jellyfin/invite/ZZ`, matching a field
  // called `publicUrl` documented as "the public Jellyfin URL". That is a 404:
  // jfa-go serves the signup page under ITS OWN url_base. The test agreed with
  // the code, and both were wrong — measured against V1, which has been minting
  // working links from `config.jfago.url` in production.
  const { impl } = scripted((c) =>
    c.url.endsWith('/token/login') ? { body: TOKEN }
      : c.method === 'POST' ? { body: { success: true } }
      : { body: { invites: [{ code: 'ZZ', label: 'l' }] } });
  const r = await client(impl).mint('l');
  if (r.state !== 'minted') throw new Error('unreachable');
  assert.equal(r.invite.link, 'https://jf.invalid/accounts/invite/ZZ');
});
