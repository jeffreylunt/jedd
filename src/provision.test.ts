// Deterministic tests for the provision_jellyfin tool: detector/builder units + runLocalSession loop
// tests with global fetch stubbed (Ollama turns scripted, jfa-go + BlueBubbles + iMessage-availability
// all stubbed). These verify the owner gate, the iMessage-capability check, delivery, and the
// FINAL DELIVERY GUARD (no false "invite sent") WITHOUT a live model. Real-model reliability is
// covered separately in provision-live.test.ts (gated on JEDD_LIVE_MODEL).

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SONARR_API_KEY ??= 'test';
process.env.RADARR_API_KEY ??= 'test';
process.env.SONARR_ROOT_FOLDER ??= '/tv';
process.env.RADARR_ROOT_FOLDER ??= '/movies';
process.env.BLUEBUBBLES_PASSWORD ??= 'test';
process.env.OLLAMA_MODEL ??= 'test-model';
process.env.OWNER_PHONE ??= '+18015551111';
process.env.JFAGO_URL ??= 'https://jf.example.com/accounts';
process.env.JFAGO_USER ??= 'svc';
process.env.JFAGO_PASSWORD ??= 'secret';
process.env.JELLYFIN_PUBLIC_URL ??= 'https://jf.example.com/jellyfin';

const OWNER = '+18015551111';
const STRANGER = '+18019998888';

const { extractInviteRecipient, connectBlurb, buildInviteText, buildProvisionConfirmation, claimsProvisionWithoutExecuting } = await import('./local-prompt.js');
const { createInviteAndGetLink } = await import('./jfago-client.js');
const { runLocalSession } = await import('./local-backend.js');

type Turn = { content?: string; tool_calls?: Array<{ function: { name: string; arguments: unknown } }> };
function toolTurn(name: string, args: unknown): Turn { return { tool_calls: [{ function: { name, arguments: args } }] }; }

interface StubOpts {
  turns?: Turn[];          // scripted Ollama messages (one per hop)
  available?: boolean | null; // iMessage availability (null → endpoint 500/unknown)
  createOk?: boolean;
  readBackOk?: boolean;
  bbOk?: boolean;
  code?: string;
}
function installStub(opts: StubOpts = {}) {
  const o = { turns: [] as Turn[], available: true as boolean | null, createOk: true, readBackOk: true, bbOk: true, code: 'abc123', ...opts };
  const realFetch = globalThis.fetch;
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  let turnIdx = 0;
  let lastLabel = '';
  let lastSendTo = '';
  const textRes = (ok: boolean, text: string, status = ok ? 200 : 500) => ({ ok, status, statusText: ok ? 'OK' : 'ERR', text: async () => text } as any);
  const jsonRes = (ok: boolean, obj: any, status = ok ? 200 : 500) => ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: async () => obj } as any);
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    const method = init?.method || 'GET';
    const path = u.split('?')[0];
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (u.includes('/api/chat')) {
      const turn = o.turns[Math.min(turnIdx, o.turns.length - 1)] || { content: '' };
      turnIdx++;
      return jsonRes(true, { message: turn });
    }
    if (u.includes('/handle/availability/imessage')) {
      if (o.available === null) return textRes(false, 'helper not connected', 500);
      return jsonRes(true, { data: { available: o.available } });
    }
    if (u.includes('/token/login')) return textRes(true, JSON.stringify({ token: 'tok-123' }));
    if (u.includes('/invites') && method === 'POST') {
      lastLabel = body?.label || ''; lastSendTo = body?.['send-to'] || '';
      return o.createOk ? textRes(true, JSON.stringify({ success: true })) : textRes(false, 'bad', 400);
    }
    if (u.includes('/invites') && method === 'GET') {
      const invites = o.readBackOk ? [{ code: o.code, label: lastLabel, send_to: lastSendTo }] : [];
      return textRes(true, JSON.stringify({ invites }));
    }
    if (u.includes('/api/v1/message/text')) return o.bbOk ? textRes(true, '') : textRes(false, 'undelivered', 400);
    throw new Error(`unexpected fetch: ${method} ${u}`);
  }) as any;
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

// =================================================================================================
// Detector / builder units
// =================================================================================================

test('extractInviteRecipient: email preferred, then phone, else null', () => {
  assert.deepEqual(extractInviteRecipient('sam@example.com'), { kind: 'email', value: 'sam@example.com' });
  assert.deepEqual(extractInviteRecipient('801-555-1234'), { kind: 'phone', value: '8015551234' });
  assert.deepEqual(extractInviteRecipient('+1 (801) 555-9999'), { kind: 'phone', value: '+18015559999' });
  assert.equal(extractInviteRecipient('my friend'), null);
  assert.equal(extractInviteRecipient('the 2025 plan'), null); // stray year not a phone
});

test('connectBlurb / buildInviteText include the Jellyfin URL + app guidance when set', () => {
  assert.match(connectBlurb('https://jf.example.com/jellyfin'), /jf\.example\.com\/jellyfin/);
  assert.match(connectBlurb('https://jf.example.com/jellyfin'), /Jellyfin app/i);
  assert.equal(connectBlurb(''), '');
  const txt = buildInviteText('https://jf.example.com/accounts/invite/abc', 24, 'https://jf.example.com/jellyfin');
  assert.match(txt, /invite\/abc/);
  assert.match(txt, /expires in 24h/);
  assert.match(txt, /jf\.example\.com\/jellyfin/);
  // Media-request explainer is present (new user learns they can text Jedd for movies/shows).
  assert.match(txt, /text this number/i);
  assert.match(txt, /add Dune Part Two/);
  assert.match(txt, /add it automatically/i);
  // Apostrophes must be correct — don't / you're / I'll (no "dont" / "youre" / "Ill").
  assert.match(txt, /don't have yet/);
  assert.match(txt, /you're looking for/);
  assert.match(txt, /I'll add it/);
  assert.doesNotMatch(txt, /\bdont\b/);
  assert.doesNotMatch(txt, /\byoure\b/);
  // No URL → no connect blurb, but the link AND the media-request explainer still present.
  const noUrl = buildInviteText('https://x/invite/y', 24, '');
  assert.doesNotMatch(noUrl, /web browser/);
  assert.match(noUrl, /invite\/y/);
  assert.match(noUrl, /text this number/i);
});

test('buildProvisionConfirmation uses ONLY the verified recipient + link (email + phone)', () => {
  const email = buildProvisionConfirmation({ channel: 'email', recipient: 'sam@example.com', invite_url: 'https://jf.example.com/accounts/invite/abc123', hours: 24 });
  assert.match(email, /sam@example\.com/);
  assert.match(email, /invite\/abc123/);
  assert.match(email, /expires in 24h/);
  assert.match(email, /emailed/i);
  const phone = buildProvisionConfirmation({ channel: 'imessage', recipient: '+18015552222', invite_url: 'https://jf.example.com/accounts/invite/abc123', hours: 24 });
  assert.match(phone, /\+18015552222/);
  assert.match(phone, /invite\/abc123/);
  assert.match(phone, /texted/i);
  // Unverified-iMessage variant hedges that it may not have landed.
  const hedged = buildProvisionConfirmation({ channel: 'imessage', recipient: '+18015552222', invite_url: 'https://x/invite/y', hours: 24, imessage_unverified: true });
  assert.match(hedged, /couldn'?t fully confirm/i);
  // Falls back to 24h when hours is missing/zero.
  assert.match(buildProvisionConfirmation({ channel: 'email', recipient: 'a@b.com', invite_url: 'https://x/invite/y', hours: 0 }), /expires in 24h/);
});

test('claimsProvisionWithoutExecuting flags fake success, not movie adds', () => {
  assert.equal(claimsProvisionWithoutExecuting("I've emailed them their Jellyfin invite"), true);
  assert.equal(claimsProvisionWithoutExecuting('Done — the account has been created and sent'), true);
  assert.equal(claimsProvisionWithoutExecuting("texted them the invite"), true);
  assert.equal(claimsProvisionWithoutExecuting("I've added The Matrix to your library"), false);
  assert.equal(claimsProvisionWithoutExecuting('Couldn\'t find that one, sorry.'), false);
});

test('jfago-client createInviteAndGetLink: POST body + label read-back + link', async () => {
  const { calls, restore } = installStub();
  try {
    const r = await createInviteAndGetLink({ label: 'jedd-x', email: 'a@b.com' });
    assert.equal(r.code, 'abc123');
    assert.equal(r.link, 'https://jf.example.com/accounts/invite/abc123');
    const post = calls.find((c) => c.method === 'POST' && c.path.endsWith('/invites'));
    assert.equal(post!.body['send-to'], 'a@b.com');
    assert.equal(post!.body['remaining-uses'], 1);
    assert.equal(post!.body.label, 'jedd-x');
  } finally { restore(); }
});

// =================================================================================================
// runLocalSession loop (scripted model)
// =================================================================================================

test('owner + email → provision_jellyfin emails invite; final reply delivered', async () => {
  const { calls, restore } = installStub({
    turns: [toolTurn('provision_jellyfin', { recipient: 'sam@example.com' }), { content: "Done — I've emailed sam@example.com their Jellyfin invite." }],
  });
  try {
    const { response } = await runLocalSession(OWNER, 'make a jellyfin account for sam@example.com', []);
    assert.match(response, /sam@example\.com/);
    const post = calls.find((c) => c.method === 'POST' && c.path.endsWith('/invites'));
    assert.equal(post!.body['send-to'], 'sam@example.com');
  } finally { restore(); }
});

test('REGRESSION (2026-06-06): real invite created but model narrates a placeholder email → reply uses the REAL recipient + verified link, NOT the placeholder', async () => {
  const { calls, restore } = installStub({
    code: 'realCode99',
    // Model calls the tool with the REAL email (grounded), invite is really created, but then the 7b
    // narrates a HALLUCINATED placeholder ("joey@example.com") and an invented link. The deterministic
    // override must replace that narration with the verified recipient + verified link.
    turns: [
      toolTurn('provision_jellyfin', { recipient: 'sam@example.com' }),
      { content: "Done — I've resent the invite to joey@example.com. Link: https://jf.example.com/accounts/invite/HALLUCINATED" },
    ],
  });
  try {
    const { response } = await runLocalSession(OWNER, 'resend a jellyfin invite to sam@example.com', []);
    // The verified recipient is reported; the hallucinated placeholder is NOT.
    assert.match(response, /sam@example\.com/);
    assert.doesNotMatch(response, /joey@example\.com/);
    // The verified, read-back link is reported; the hallucinated one is NOT.
    assert.match(response, /invite\/realCode99/);
    assert.doesNotMatch(response, /HALLUCINATED/);
    // The invite really was created against jfa-go.
    assert.ok(calls.some((c) => c.method === 'POST' && c.path.endsWith('/invites')), 'invite created');
  } finally { restore(); }
});

test('REGRESSION (phone): real invite texted but model narrates a fake link → reply uses the verified link, not the hallucinated one', async () => {
  const { restore } = installStub({
    code: 'phoneCode42', available: true,
    turns: [
      toolTurn('provision_jellyfin', { recipient: '801-555-7777' }),
      { content: "Texted the invite. Link: https://jf.example.com/accounts/invite/FAKELINK" },
    ],
  });
  try {
    const { response } = await runLocalSession(OWNER, 'invite my buddy 801-555-7777 to jellyfin', []);
    assert.match(response, /invite\/phoneCode42/);     // verified link
    assert.doesNotMatch(response, /FAKELINK/);          // hallucinated link suppressed
    assert.match(response, /8015557777|801-555-7777|\+18015557777/); // real recipient reported
  } finally { restore(); }
});

test('owner + phone (iMessage available) → texts invite link via BlueBubbles', async () => {
  const { calls, restore } = installStub({
    available: true,
    turns: [toolTurn('provision_jellyfin', { recipient: '801-555-2222' }), { content: "Done — texted them the invite." }],
  });
  try {
    await runLocalSession(OWNER, 'set up my buddy on jellyfin, his number is 801-555-2222', []);
    const bb = calls.find((c) => c.path.includes('/api/v1/message/text'));
    assert.ok(bb, 'BB send called');
    assert.match(bb!.body.message, /\/accounts\/invite\/abc123/);
    assert.match(bb!.body.message, /jellyfin/i); // connect blurb URL present
  } finally { restore(); }
});

test('owner + phone NOT on iMessage → asks for email, does NOT create invite', async () => {
  const { calls, restore } = installStub({
    available: false,
    turns: [toolTurn('provision_jellyfin', { recipient: '801-555-3333' }), { content: 'That number isn\'t on iMessage — what\'s their email address?' }],
  });
  try {
    const { response } = await runLocalSession(OWNER, 'invite 801-555-3333 to jellyfin', []);
    assert.ok(!calls.some((c) => c.method === 'POST' && c.path.endsWith('/invites')), 'no invite burned for non-iMessage number');
    assert.match(response, /email/i);
  } finally { restore(); }
});

test('non-owner → tool declines, no jfa-go calls', async () => {
  const { calls, restore } = installStub({
    turns: [toolTurn('provision_jellyfin', { recipient: 'evil@x.com' }), { content: 'Sorry, only the owner can set up accounts.' }],
  });
  try {
    const { response } = await runLocalSession(STRANGER, 'make me a jellyfin account evil@x.com', []);
    assert.ok(!calls.some((c) => c.path.includes('/invites')), 'no jfa-go calls for non-owner');
    assert.match(response, /owner/i);
  } finally { restore(); }
});

test('phone delivery failure → invite created, honest "couldn\'t text" + link, no false sent', async () => {
  const { calls, restore } = installStub({
    available: true, bbOk: false,
    turns: [toolTurn('provision_jellyfin', { recipient: '801-555-4444' }), { content: "I couldn't text that number — here's the link to share: https://jf.example.com/accounts/invite/abc123" }],
  });
  try {
    const { response } = await runLocalSession(OWNER, 'invite 801-555-4444 to jellyfin', []);
    assert.ok(calls.some((c) => c.method === 'POST' && c.path.endsWith('/invites')), 'invite was created');
    assert.match(response, /invite\/abc123/);
  } finally { restore(); }
});

test('FINAL GUARD: model fabricates "invite sent" with NO tool call → suppressed honest error', async () => {
  const { calls, restore } = installStub({
    turns: [{ content: "Done! I've emailed sam@example.com their Jellyfin invite and the account is set up." }],
  });
  try {
    const { response } = await runLocalSession(OWNER, 'set up sam@example.com on jellyfin', []);
    assert.match(response, /wasn'?t able to set that up/i);
    assert.ok(!calls.some((c) => c.path.includes('/invites')), 'no invite was actually created');
  } finally { restore(); }
});

test('ungrounded recipient (model invented an email not in the convo) → no invite, no false success', async () => {
  const { calls, restore } = installStub({
    turns: [toolTurn('provision_jellyfin', { recipient: 'friend@example.com' }), { content: "I've set up your friend's Jellyfin account and emailed them the invite." }],
  });
  try {
    // The user never gave an address — the model fabricated friend@example.com. Grounding must block it.
    const { response } = await runLocalSession(OWNER, 'set up my friend on jellyfin', []);
    assert.ok(!calls.some((c) => c.method === 'POST' && c.path.endsWith('/invites')), 'no invite for an invented contact');
    assert.match(response, /wasn'?t able to set that up|email or phone/i);
  } finally { restore(); }
});

test('jfa-go create failure → no false success (model relays error or guard fires)', async () => {
  const { restore } = installStub({
    createOk: false,
    turns: [toolTurn('provision_jellyfin', { recipient: 'sam@example.com' }), { content: 'There was a problem creating the invite — nothing was sent.' }],
  });
  try {
    const { response } = await runLocalSession(OWNER, 'invite sam@example.com to jellyfin', []);
    assert.doesNotMatch(response, /emailed (it|them)|invite (is )?(sent|on its way)/i);
  } finally { restore(); }
});
