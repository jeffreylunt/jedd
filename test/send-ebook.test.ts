import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChoiceStore } from '../src/choices.js';
import type { ExecImpl } from '../src/hp.js';
import { KindleRegistry } from '../src/kindle.js';
import { makeSendEbook } from '../src/tools/send-ebook.js';
import type { MailSender } from '../src/media/kindle-send.js';
import { testConfig } from './helpers.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
/**
 * 🔴 A REAL EPUB, not a placeholder string.
 *
 * This fixture used to be `Buffer.from('epub bytes here')`. When magic-byte
 * validation landed in front of `sendToKindle`, these tests began FAILING —
 * correctly. The old fixture was a renamed nothing, which is precisely the shape
 * the validator exists to stop, and a test asserting it got mailed was asserting
 * the bug. The header is the one measured from a live #ebooks bot; see
 * `test/ebook-validate.test.ts`.
 */
const BOOK = Buffer.concat([
  Buffer.from(
    '504b03041400160800004' + '7b9a3526f61ab2c140000001400000008000000' + '6d696d6574797065' +
      Buffer.from('application/epub+zip', 'latin1').toString('hex'),
    'hex',
  ),
  Buffer.alloc(512, 0x41),
]);
const SHA = createHash('sha256').update(BOOK).digest('hex');
const JEFF = '+18015550123';
const OTHER = '+13855550168';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'jedd-se-')), 'f.jsonl');

/**
 * hp replies, in call order:
 *   0 createCategory  1 add  2 topPrio  3 info  4 resolveBookPath  5 stat  6 base64
 *
 * ⚠️ Index 4 exists because content_path is a DIRECTORY for a multi-file
 * torrent, so the book is chosen before anything is read. Adding that step
 * shifted every later index — the fixture is positional, which is why it broke
 * loudly rather than silently.
 */
function hp(overrides: Partial<Record<number, { stdout: string; code?: number }>> = {}) {
  const seq: { stdout: string; code?: number }[] = [
    { stdout: '' },
    { stdout: 'Ok.\n200' },
    { stdout: '' },
    { stdout: JSON.stringify([{ name: 'book.epub', progress: 1, content_path: '/downloads/ebooks/book.epub' }]) },
    { stdout: 'FILE' },
    { stdout: `${BOOK.length}\n${SHA}` },
    { stdout: BOOK.toString('base64') },
  ];
  let i = 0;
  const exec: ExecImpl = (_f, _a, _o, cb) => {
    const n = i++;
    const r = overrides[n] ?? seq[n] ?? { stdout: '' };
    cb(r.code ? { code: r.code } : null, r.stdout, '');
  };
  return exec;
}

function ctx(handle: string, opts: { withAddress?: boolean } = {}) {
  const kindle = new KindleRegistry(tmp());
  if (opts.withAddress !== false) kindle.save(handle, 'a_b@kindle.com', ['a_b@kindle.com']);
  const choices = new ChoiceStore(tmp());
  choices.present({
    senderHandle: handle,
    subject: 'The Anxious Generation',
    kind: 'ebook',
    options: [{ n: 1, label: 'The Anxious Generation EPUB', value: { infoHash: HASH, title: 'The Anxious Generation' } }],
  });
  return { role: 'guest' as const, senderHandle: handle, config: testConfig({ readOnly: false }), kindle, choices };
}

function mailer() {
  const sent: Parameters<MailSender>[0][] = [];
  return { sent, send: (async (m) => { sent.push(m); return { messageId: '<x>' }; }) as MailSender };
}

// ── 🔴 the whole path, end to end ────────────────────────────────────────────

test('🔴 a picked book is grabbed, verified and sent to the STORED address', async () => {
  const { send, sent } = mailer();
  const tool = makeSendEbook({ send });
  const r = await tool.run({ choice: 1 }, { ...ctx(JEFF), exec: hp() });
  assert.equal(r.ok, true);
  assert.match(r.content, /^SENT/);
  assert.equal(sent[0]?.to, 'a_b@kindle.com', 'the address came from the store, not from the model');
  assert.ok(sent[0]?.attachments[0]?.content.equals(BOOK), 'the exact bytes read off hp are what got attached');
});

test('🔴 the tool takes NO address parameter', () => {
  const props = (makeSendEbook({ send: mailer().send }).parameters as { properties: Record<string, unknown> }).properties;
  assert.deepEqual(Object.keys(props), ['choice'], 'a recipient must be unsuppliable, not validated');
});

// ── 🔴 the live-test restriction is structural ───────────────────────────────

test('🔴 a restricted build REFUSES anyone but the allowed handle, before grabbing', async () => {
  // A first live test that emails a real book to a real third party is not a
  // test. This is a constructor argument, so the restricted build is a DIFFERENT
  // OBJECT rather than the same object in a different mood.
  const { send, sent } = mailer();
  const tool = makeSendEbook({ send, onlySendTo: JEFF });
  const r = await tool.run({ choice: 1 }, { ...ctx(OTHER), exec: hp() });
  assert.equal(r.ok, false);
  assert.match(r.content, /RESTRICTED/);
  assert.match(r.content, /Nothing was grabbed or sent/);
  assert.equal(sent.length, 0);
});

test('CONTROL: the same restricted build DOES send to the allowed handle', async () => {
  const { send, sent } = mailer();
  const r = await makeSendEbook({ send, onlySendTo: JEFF }).run({ choice: 1 }, { ...ctx(JEFF), exec: hp() });
  assert.equal(r.ok, true);
  assert.equal(sent.length, 1);
});

// ── the states that are not a send ───────────────────────────────────────────

test('🔴 no stored address REFUSES and grabs nothing', async () => {
  const { send, sent } = mailer();
  const r = await makeSendEbook({ send }).run({ choice: 1 }, { ...ctx(JEFF, { withAddress: false }), exec: hp() });
  assert.equal(r.ok, false);
  assert.match(r.content, /NO ADDRESS/);
  assert.match(r.content, /do not guess one/);
  assert.equal(sent.length, 0, 'nothing may be grabbed for a book that cannot be delivered');
});

test('still downloading is reported as progress, not as failure', async () => {
  const { send, sent } = mailer();
  const exec = hp({ 3: { stdout: JSON.stringify([{ name: 'book', progress: 0.3, content_path: '/downloads/x' }]) } });
  const r = await makeSendEbook({ send }).run({ choice: 1 }, { ...ctx(JEFF), exec });
  assert.equal(r.ok, true, 'not an error — the turn simply is not finished');
  // Reworded from DOWNLOADING to STARTED when the follow-up leg landed: the old
  // string was paired with scheduling NOTHING, so "you will send it once it
  // lands" was a promise no code could keep.
  assert.match(r.content, /STARTED/);
  assert.match(r.content, /NOT sent|NOTHING HAS BEEN SENT/);
  assert.equal(sent.length, 0);
});

test('🔴 an unmapped container path names the CONFIG problem, not a missing book', async () => {
  const { send } = mailer();
  const exec = hp({ 3: { stdout: JSON.stringify([{ name: 'b', progress: 1, content_path: '/external/Downloads/b' }]) } });
  const r = await makeSendEbook({ send }).run({ choice: 1 }, { ...ctx(JEFF), exec });
  assert.equal(r.ok, false);
  assert.match(r.content, /configuration problem, not a missing book/);
});

test('🔴 a corrupt transfer is caught BEFORE the send', async () => {
  const { send, sent } = mailer();
  const exec = hp({ 6: { stdout: BOOK.toString('base64').slice(0, 8) } });
  const r = await makeSendEbook({ send }).run({ choice: 1 }, { ...ctx(JEFF), exec });
  assert.equal(r.ok, false);
  // The specific cause stays in the detail; the outer category is FAILED now
  // that both sources share one delivery path.
  assert.match(r.content, /FAILED/);
  assert.match(r.content, /TRUNCATED/);
  assert.equal(sent.length, 0, 'a truncated file must never be mailed');
});

test('a lost option list re-asks rather than picking something', async () => {
  const { send } = mailer();
  const c = ctx(JEFF);
  const r = await makeSendEbook({ send }).run({ choice: 9 }, { ...c, exec: hp() });
  assert.equal(r.ok, false);
  assert.match(r.content, /OUT-OF-RANGE/);
});
