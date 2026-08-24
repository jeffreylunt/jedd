import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sendToKindle, type MailSender } from '../src/media/kindle-send.js';
import { testConfig } from './helpers.js';

const BYTES = Buffer.from('epub bytes');
const base = { config: testConfig(), toAddress: 'korbyn96_yo0FhQ@kindle.com', filename: 'book.epub', bytes: BYTES };

function capturing(): { send: MailSender; sent: Parameters<MailSender>[0][] } {
  const sent: Parameters<MailSender>[0][] = [];
  return {
    sent,
    send: async (m) => {
      sent.push(m);
      return { messageId: '<abc@mail>' };
    },
  };
}

// ── 🔴 mechanism, never outcome ──────────────────────────────────────────────

test('🔴 a successful send reports the MECHANISM and explicitly disclaims delivery', async () => {
  // V1 said "It should show up on your Kindle in a few minutes" -- an outcome it
  // could not observe.
  const { send } = capturing();
  const r = await sendToKindle(base, send);
  assert.equal(r.state, 'accepted');
  assert.match(r.detail, /the mail server accepted it/i);
  assert.match(r.detail, /NOT confirmation that it reached the device/i);
  assert.doesNotMatch(r.detail, /should show up|will arrive|in a few minutes/i);
});

test('🔴 there is NO delivered state', async () => {
  const { send } = capturing();
  const states = new Set<string>();
  states.add((await sendToKindle(base, send)).state);
  states.add((await sendToKindle({ ...base, toAddress: '' }, send)).state);
  states.add(
    (await sendToKindle(base, async () => {
      throw new Error('ETIMEDOUT');
    })).state,
  );
  assert.deepEqual([...states].sort(), ['accepted', 'rejected', 'unknown']);
});

// ── the from-address is load-bearing ─────────────────────────────────────────

test('🔴 the from-address comes from config, and the address is NOT a parameter of the model', async () => {
  // Amazon matches the sender against each user's approved list. And the
  // recipient is resolved from the verified store by the caller -- there is no
  // path by which a model-supplied string becomes `to`.
  const { send, sent } = capturing();
  await sendToKindle(base, send);
  assert.equal(sent[0]?.from, 'jedd@invalid');
  assert.equal(sent[0]?.to, 'korbyn96_yo0FhQ@kindle.com');
});

test('the attachment is what Amazon reads; subject and body stay empty', async () => {
  // "convert" in the subject used to trigger conversion, and an epub needs none.
  const { send, sent } = capturing();
  await sendToKindle(base, send);
  assert.equal(sent[0]?.subject, '');
  assert.equal(sent[0]?.attachments[0]?.filename, 'book.epub');
  assert.equal(sent[0]?.attachments[0]?.content.toString(), 'epub bytes');
});

// ── the refusals ─────────────────────────────────────────────────────────────

test('🔴 a missing SMTP password names the DEPLOYMENT gap, not the book', async () => {
  const { send, sent } = capturing();
  const r = await sendToKindle({ ...base, config: testConfig({ kindle: { ...testConfig().kindle, smtpPassword: '' } }) }, send);
  assert.equal(r.state, 'rejected');
  assert.match(r.detail, /deployment gap, not a problem with the book/i);
  assert.match(r.detail, /KINDLE_SMTP_PASSWORD/);
  assert.equal(sent.length, 0, 'nothing may be attempted without it');
});

test('no stored address and an empty file are both refused before sending', async () => {
  const { send, sent } = capturing();
  assert.equal((await sendToKindle({ ...base, toAddress: '' }, send)).state, 'rejected');
  assert.equal((await sendToKindle({ ...base, bytes: Buffer.alloc(0) }, send)).state, 'rejected');
  assert.equal(sent.length, 0);
});

test('🔴 a 5xx is REJECTED but a timeout is UNKNOWN — it may have gone', async () => {
  const hard = await sendToKindle(base, async () => {
    throw new Error('550 5.1.1 recipient rejected');
  });
  assert.equal(hard.state, 'rejected');

  const soft = await sendToKindle(base, async () => {
    throw new Error('ETIMEDOUT connecting');
  });
  assert.equal(soft.state, 'unknown');
  assert.match(soft.detail, /MAY have gone/);
  assert.match(soft.detail, /may receive it twice/, 'and retrying blindly has a real cost');
});
