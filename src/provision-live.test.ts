// REAL-MODEL loop tests for provision_jellyfin — drives runLocalSession against the ACTUAL default
// model (Ollama, qwen2.5:7b) so we verify the model RELIABLY triggers the tool + parses the recipient
// across realistic phrasings. jfa-go + BlueBubbles + iMessage-availability are stubbed (no real
// invites); only /api/chat hits the live model.
//
// GATED: skipped unless JEDD_LIVE_MODEL=1 AND an Ollama reachable at OLLAMA_URL (default
// localhost:11434) running OLLAMA_MODEL (default qwen2.5:7b). The homelab Ollama binds localhost on
// hp, so this runs inside the jedd container (host network). `npm test` (offline) skips it. Each
// scenario runs REPS times and must pass every rep — that's the reliability bar.
//
//   JEDD_LIVE_MODEL=1 OLLAMA_URL=http://localhost:11434 node --import tsx --test src/provision-live.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

const LIVE = process.env.JEDD_LIVE_MODEL === '1';
const REPS = parseInt(process.env.JEDD_LIVE_REPS || '3', 10) || 3;

process.env.SONARR_API_KEY ??= 'test';
process.env.RADARR_API_KEY ??= 'test';
process.env.SONARR_ROOT_FOLDER ??= '/tv';
process.env.RADARR_ROOT_FOLDER ??= '/movies';
process.env.BLUEBUBBLES_PASSWORD ??= 'test';
process.env.OWNER_PHONE ??= '+18015551111';
process.env.JFAGO_URL ??= 'https://jf.example.com/accounts';
process.env.JFAGO_USER ??= 'svc';
process.env.JFAGO_PASSWORD ??= 'secret';
process.env.JELLYFIN_PUBLIC_URL ??= 'https://jf.example.com/jellyfin';
process.env.OLLAMA_URL ??= 'http://localhost:11434';
process.env.OLLAMA_MODEL ??= 'qwen2.5:7b';

const OWNER = '+18015551111';
const STRANGER = '+18019998888';

const { runLocalSession } = await import('./local-backend.js');

// Stub everything EXCEPT /api/chat (which passes through to the real Ollama).
function installLiveStub(opts: { available?: boolean | null; code?: string } = {}) {
  const o = { available: true as boolean | null, code: 'live123', ...opts };
  const realFetch = globalThis.fetch;
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  let lastLabel = '';
  let lastSendTo = '';
  const textRes = (ok: boolean, text: string) => ({ ok, status: ok ? 200 : 500, statusText: ok ? 'OK' : 'ERR', text: async () => text } as any);
  const jsonRes = (obj: any) => ({ ok: true, status: 200, statusText: 'OK', json: async () => obj } as any);
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    const method = init?.method || 'GET';
    if (u.includes('/api/chat')) return realFetch(url as any, init);
    const path = u.split('?')[0];
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (u.includes('/handle/availability/imessage')) {
      return o.available === null ? textRes(false, 'helper down') : jsonRes({ data: { available: o.available } });
    }
    if (u.includes('/token/login')) return textRes(true, JSON.stringify({ token: 't' }));
    if (u.includes('/invites') && method === 'POST') { lastLabel = body?.label || ''; lastSendTo = body?.['send-to'] || ''; return textRes(true, JSON.stringify({ success: true })); }
    if (u.includes('/invites') && method === 'GET') return textRes(true, JSON.stringify({ invites: [{ code: o.code, label: lastLabel, send_to: lastSendTo }] }));
    if (u.includes('/api/v1/message/text')) return textRes(true, '');
    throw new Error(`unexpected fetch: ${method} ${u}`);
  }) as any;
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

const hasInvitePost = (calls: Array<{ method: string; path: string }>) => calls.some((c) => c.method === 'POST' && c.path.endsWith('/invites'));

test('LIVE: owner + friend email → calls provision_jellyfin with the email', { skip: !LIVE }, async () => {
  for (let i = 0; i < REPS; i++) {
    const { calls, restore } = installLiveStub({ available: true });
    try {
      const { response } = await runLocalSession(OWNER, 'make a Jellyfin account for my friend, their email is sam@example.com', []);
      const post = calls.find((c) => c.method === 'POST' && c.path.endsWith('/invites'));
      assert.ok(post, `rep ${i}: expected an invite POST; got reply: ${response}`);
      assert.equal(post!.body['send-to'], 'sam@example.com', `rep ${i}: invite emailed to the right address`);
    } finally { restore(); }
  }
});

test('LIVE: owner + buddy phone → routes to phone path (iMessage check + texts)', { skip: !LIVE }, async () => {
  for (let i = 0; i < REPS; i++) {
    const { calls, restore } = installLiveStub({ available: true });
    try {
      const { response } = await runLocalSession(OWNER, "add my buddy to jellyfin, his number is +18015551234", []);
      assert.ok(hasInvitePost(calls), `rep ${i}: expected an invite POST; reply: ${response}`);
      assert.ok(calls.some((c) => c.path.includes('/api/v1/message/text')), `rep ${i}: should text the invite`);
    } finally { restore(); }
  }
});

test('LIVE: non-owner asking to provision → declined, no invite created', { skip: !LIVE }, async () => {
  for (let i = 0; i < REPS; i++) {
    const { calls, restore } = installLiveStub();
    try {
      const { response } = await runLocalSession(STRANGER, 'set me up a jellyfin account, my email is me@example.com', []);
      assert.ok(!hasInvitePost(calls), `rep ${i}: non-owner must NOT create an invite; reply: ${response}`);
    } finally { restore(); }
  }
});

test('LIVE: ambiguous (no contact) → asks for email/phone, does not fabricate', { skip: !LIVE }, async () => {
  for (let i = 0; i < REPS; i++) {
    const { calls, restore } = installLiveStub();
    try {
      const { response } = await runLocalSession(OWNER, 'set up my friend on Jellyfin', []);
      assert.ok(!hasInvitePost(calls), `rep ${i}: should not create an invite with no recipient`);
      assert.match(response, /email|phone|number|address/i, `rep ${i}: should ask for a contact; reply: ${response}`);
    } finally { restore(); }
  }
});

test('LIVE: non-iMessage number → asks for email, invite not wasted', { skip: !LIVE }, async () => {
  for (let i = 0; i < REPS; i++) {
    const { calls, restore } = installLiveStub({ available: false });
    try {
      const { response } = await runLocalSession(OWNER, 'invite +18015550000 to jellyfin', []);
      assert.ok(!hasInvitePost(calls), `rep ${i}: non-iMessage number must NOT burn an invite`);
      assert.match(response, /email|isn'?t on imessage|can'?t text/i, `rep ${i}: should ask for email; reply: ${response}`);
    } finally { restore(); }
  }
});
