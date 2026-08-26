import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BounceEmail } from '../src/kindle-delivery.js';
import { extractText, type MailboxReader } from '../src/kindle-mailbox.js';
import {
  CONTROL_BOUNCE,
  CONTROL_QUIET,
  runControls,
  verifyKindleDelivery,
} from '../src/kindle-verify.js';

/**
 * ── 🔴 WHAT THIS FILE IS ACTUALLY TESTING ────────────────────────────────────
 *
 * Not "does the parser recognise E014" — `kindle-delivery.test.ts` covers that.
 * This covers the thing V1 got wrong: **whether the instrument knows when it is
 * blind.** Every test below that matters is a case where the check must REFUSE
 * TO ANSWER rather than return a clean result it has not earned.
 *
 * The live proof that the controls traverse a real network and read real Amazon
 * mail is `scripts/kindle-verify-live.ts`, which cannot be a unit test.
 */

const bounce = (body: string, receivedAt: string): BounceEmail => ({
  from: 'do-not-reply@amazon.com',
  subject: 'There was a problem with the document(s) you sent to Kindle',
  body,
  receivedAt,
});

/** Verbatim, thread 19ce8cfb60e359dd — the same notice the live control pins. */
const CONTROL_E014 = bounce(
  'Dear customer,\nYour Send to Kindle request at 08:07 PM on Fri, Mar 13, 2026 GMT, could not be ' +
    'processed due to E014 - Unapproved sender email address.\nUnapproved sender email address: ' +
    'thetrinityslc@gmail.com',
  '2026-03-13T20:07:32Z',
);

/** An in-memory mailbox that honours the window, like the real reader does. */
function fakeMailbox(emails: BounceEmail[]): MailboxReader {
  return async (since, until) => ({
    ok: true,
    folders: ['INBOX', '[Gmail]/All Mail', '[Gmail]/Spam', '[Gmail]/Trash'],
    emails: emails.filter((e) => {
      const at = Date.parse(e.receivedAt);
      return at >= since.getTime() && at <= (until?.getTime() ?? Number.POSITIVE_INFINITY);
    }),
  });
}

const SENT_AT = new Date('2026-08-26T21:44:00Z');
const NOW = new Date('2026-08-26T22:10:00Z');
const TONIGHTS_BOUNCE = bounce(
  'Dear customer, The following document(s), sent at 09:44 PM on Wed, Aug 26, 2026 GMT, could not ' +
    'be delivered due to E001 - Unsupported File Format: * Tress of the Emerald Sea.epub',
  '2026-08-26T21:47:10Z',
);

// ── 🔴 THE INSTRUMENT REPORTS FAILURE. THIS IS THE POINT. ────────────────────

test('🔴 a real refusal for this send is REPORTED, with its code', async () => {
  const v = await verifyKindleDelivery(
    fakeMailbox([CONTROL_E014, TONIGHTS_BOUNCE]),
    { sentAt: SENT_AT, filename: 'Tress of the Emerald Sea.epub' },
    NOW,
  );
  assert.equal(v.state, 'failed');
  if (v.state !== 'failed') throw new Error('unreachable');
  assert.equal(v.code, 'E001');
});

// ── 🔴 AND IT KNOWS WHEN IT CANNOT SEE ───────────────────────────────────────

test('🔴 NO VERDICT when the known-refusal control does not fire', async () => {
  // The control notice is gone from the mailbox, so nothing in this run has
  // demonstrated the check can detect a refusal at all. A "no failure found"
  // here would be exactly V1's false clean.
  const v = await verifyKindleDelivery(fakeMailbox([]), { sentAt: SENT_AT }, NOW);
  assert.equal(v.state, 'blind');
  assert.match(v.detail, /cannot currently detect a refusal/i);
});

test('🔴 NO VERDICT when the control fires with the WRONG CODE', async () => {
  // A parser that finds a bounce but cannot read the code out of it still
  // "detects failure" in the loosest sense — and hands the person a refusal with
  // no idea what to do about it. The control pins the code for that reason.
  const garbled = bounce('Dear customer, your document could not be processed.', '2026-03-13T20:07:32Z');
  const v = await verifyKindleDelivery(fakeMailbox([garbled]), { sentAt: SENT_AT }, NOW);
  assert.equal(v.state, 'blind');
  assert.match(v.detail, /expected failed\/E014/);
});

test('🔴 NO VERDICT when the known-quiet control fires — over-attribution', async () => {
  // A reader that ignores the window would sail through the first control and
  // then blame tonight's book for a bounce from March.
  const strayInQuietWindow = bounce(
    'Dear customer, could not be delivered due to E999 - Send to Kindle Internal Error: * x.epub',
    '2026-03-13T22:00:00Z',
  );
  const v = await verifyKindleDelivery(
    fakeMailbox([CONTROL_E014, strayInQuietWindow]),
    { sentAt: SENT_AT },
    NOW,
  );
  assert.equal(v.state, 'blind');
  assert.match(v.detail, /attributing bounces outside the window/i);
});

test('🔴 an UNREADABLE mailbox is blind, and says so as a connectivity problem', async () => {
  // The failure this exists to prevent: a refused login returning an empty list
  // and being read as "nothing went wrong". It must also not be MISDIAGNOSED as
  // over-attribution — a wrong reason sends the next reader to the wrong file.
  const broken: MailboxReader = async () => ({ ok: false, reason: 'Invalid credentials' });
  const v = await verifyKindleDelivery(broken, { sentAt: SENT_AT }, NOW);
  assert.equal(v.state, 'blind');
  assert.match(v.detail, /could not be read/i);
  assert.match(v.detail, /NOT a report that the mailbox is clean/i);
  assert.doesNotMatch(v.detail, /attributing bounces/i);
});

test('🔴 controls pass but the REAL read fails -> blind, not clean', async () => {
  // The controls read history; the real question reads a live window. A reader
  // that can serve the first and not the second must not have its silence on the
  // second read as an answer.
  let call = 0;
  const flaky: MailboxReader = async (since, until) => {
    call += 1;
    if (call <= 2) return fakeMailbox([CONTROL_E014])(since, until);
    return { ok: false, reason: 'connection reset' };
  };
  const v = await verifyKindleDelivery(flaky, { sentAt: SENT_AT }, NOW);
  assert.equal(v.state, 'blind');
  assert.match(v.detail, /controls passed but the read for this send failed/i);
});

// ── 🔴 silence is never upgraded ─────────────────────────────────────────────

test('🔴 no refusal found says so WITHOUT ever claiming delivery', async () => {
  const v = await verifyKindleDelivery(fakeMailbox([CONTROL_E014]), { sentAt: SENT_AT }, NOW);
  assert.equal(v.state, 'no-failure-seen');
  assert.match(v.detail, /NOT confirmation/i);
  assert.doesNotMatch(v.detail, /\bdelivered\b|\barrived\b(?! )/i);
});

test('🔴 there is no success state to reach — every input lands in three members', async () => {
  const states = new Set<string>();
  const broken: MailboxReader = async () => ({ ok: false, reason: 'x' });
  states.add((await verifyKindleDelivery(broken, { sentAt: SENT_AT }, NOW)).state);
  states.add((await verifyKindleDelivery(fakeMailbox([CONTROL_E014]), { sentAt: SENT_AT }, NOW)).state);
  states.add(
    (await verifyKindleDelivery(fakeMailbox([CONTROL_E014, TONIGHTS_BOUNCE]), { sentAt: SENT_AT }, NOW))
      .state,
  );
  assert.deepEqual([...states].sort(), ['blind', 'failed', 'no-failure-seen']);
});

test('🔴 the two controls must DISAGREE — a check that answers the same either way is blind', async () => {
  // Not a restatement of the tests above: this asserts the DIFFERENTIAL itself,
  // which is what V1's probe lacked. Its bad send and its good sends produced
  // the identical output, so its clean result and its broken result were the
  // same result.
  const report = await runControls(fakeMailbox([CONTROL_E014]));
  assert.equal(report.bounce.passed, true);
  assert.equal(report.quiet.passed, true);
  assert.notEqual(report.bounce.got, report.quiet.got);
});

test('the control windows do not overlap the send being checked', () => {
  // A control window that reached into the present would let tonight's own
  // bounce satisfy the control, and the control would stop being independent.
  assert.ok(CONTROL_BOUNCE.until.getTime() < SENT_AT.getTime());
  assert.ok(CONTROL_QUIET.until.getTime() < SENT_AT.getTime());
  assert.ok(CONTROL_QUIET.since.getTime() > CONTROL_BOUNCE.since.getTime());
});

// ── the MIME decoding the code depends on ────────────────────────────────────

test('🔴 a quoted-printable soft break INSIDE the error code is decoded', () => {
  // This is why the raw source is not handed to the classifier. The soft break
  // lands mid-token and the code silently degrades to UNKNOWN — a failure still
  // reported, minus the only part the person can act on.
  const raw =
    'Content-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n' +
    'could not be processed due to E014 =\r\n- Unapproved sender email address.';
  assert.match(extractText(raw), /E014 - Unapproved sender email address/);
});

test('base64 bodies are decoded', () => {
  const body = Buffer.from('due to E001 - Unsupported File Format').toString('base64');
  const raw = `Content-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\n${body}`;
  assert.match(extractText(raw), /E001 - Unsupported File Format/);
});

test('multipart/alternative prefers text/plain over the HTML twin', () => {
  const raw =
    'Content-Type: multipart/alternative; boundary="B"\r\n\r\n' +
    '--B\r\nContent-Type: text/plain\r\n\r\ndue to E009 - No Attachment\r\n' +
    '--B\r\nContent-Type: text/html\r\n\r\n<p>due to <b>E0</b>09 - No Attachment</p>\r\n' +
    '--B--\r\n';
  assert.match(extractText(raw), /due to E009 - No Attachment/);
});

test('an HTML-only notice still yields readable text', () => {
  const raw =
    'Content-Type: multipart/alternative; boundary="B"\r\n\r\n' +
    '--B\r\nContent-Type: text/html\r\n\r\n<p>due to E999 - Send to Kindle Internal Error</p>\r\n' +
    '--B--\r\n';
  assert.match(extractText(raw), /E999 - Send to Kindle Internal Error/);
});
