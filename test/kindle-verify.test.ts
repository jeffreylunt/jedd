import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BounceEmail } from '../src/kindle-delivery.js';
import {
  arrivalTime,
  extractText,
  planFolders,
  toBounceEmail,
  WANTED_SPECIAL_USE,
  type MailboxReader,
} from '../src/kindle-mailbox.js';
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
    'personthree@example.com',
  '2026-03-13T20:07:32Z',
);

/** An in-memory mailbox that honours the window, like the real reader does. */
function fakeMailbox(emails: BounceEmail[], skipped: string[] = []): MailboxReader {
  return async (windows) => ({
    ok: true,
    folders: ['INBOX', '[Gmail]/All Mail', '[Gmail]/Spam', '[Gmail]/Trash'],
    skipped,
    windows: windows.map((w) =>
      emails.filter((e) => {
        const at = Date.parse(e.receivedAt);
        return at >= w.since.getTime() && at <= (w.until?.getTime() ?? Number.POSITIVE_INFINITY);
      }),
    ),
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

test('🔴 a refusal that cannot be tied to THIS send is not reported as this send failing', async () => {
  // Two books twelve minutes apart is the ordinary case. The version before this
  // fell through to `candidates[0]` — ARRAY order, which is FOLDER order, not
  // time — and told the wrong person their book had been thrown away.
  const someoneElses = bounce(
    'Your Send to Kindle request could not be processed due to E014 - Unapproved sender email address.',
    '2026-08-26T21:46:00Z',
  );
  const v = await verifyKindleDelivery(
    fakeMailbox([CONTROL_E014, someoneElses, TONIGHTS_BOUNCE]),
    { sentAt: SENT_AT, filename: 'A Completely Different Book.epub' },
    NOW,
  );
  assert.equal(v.state, 'failed-unattributed');
  if (v.state !== 'failed-unattributed') throw new Error('unreachable');
  assert.match(v.detail, /cannot be sure it was this book/i);
});

test('🔴 a SOLE refusal in the window is attributed even with no filename in it', async () => {
  // E009 and E014 carry no filename at all, and E014 is the failure that matters
  // most. Requiring a name match would miss every one of them.
  const noFilename = bounce(
    'Your Send to Kindle request could not be processed due to E014 - Unapproved sender email address.',
    '2026-08-26T21:46:00Z',
  );
  const v = await verifyKindleDelivery(
    fakeMailbox([CONTROL_E014, noFilename]),
    { sentAt: SENT_AT, filename: 'Tress.epub' },
    NOW,
  );
  assert.equal(v.state, 'failed');
});

test('🔴 the window is bounded to the send, not to "everything since"', async () => {
  // Run unbounded against the Mistborn sends the live harness reported
  // failed/E009 — from a bounce twenty hours later belonging to another probe.
  const muchLater = bounce(
    'could not be processed due to E009 - No Attachment.',
    '2026-08-27T18:00:00Z',
  );
  const v = await verifyKindleDelivery(
    fakeMailbox([CONTROL_E014, muchLater]),
    { sentAt: SENT_AT },
    new Date('2026-08-28T00:00:00Z'),
  );
  assert.equal(v.state, 'no-failure-seen');
});

test('🔴 a mailbox that cannot be read is blind, and the controls cannot have passed', async () => {
  const broken: MailboxReader = async () => ({ ok: false, reason: 'connection reset' });
  const v = await verifyKindleDelivery(broken, { sentAt: SENT_AT }, NOW);
  assert.equal(v.state, 'blind');
  assert.match(v.detail, /nothing was searched/i);
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

test('🔴 a folder that could NOT be opened makes the whole run blind', async () => {
  // Amazon's notices land in Spam and Gmail's All Mail excludes Spam and Trash,
  // so an unsearched Spam folder turns a real refusal into a clean result. The
  // reader used to `continue` past a folder it could not lock and still return
  // ok — partial coverage reported as full coverage.
  const v = await verifyKindleDelivery(
    fakeMailbox([CONTROL_E014], ['[Gmail]/Spam (NONEXISTENT)']),
    { sentAt: SENT_AT },
    NOW,
  );
  assert.equal(v.state, 'blind');
  assert.match(v.detail, /could not be searched/i);
  assert.match(v.detail, /Spam/);
});

test('🔴 the folder sweep names Spam and Trash, and the reason is measured', () => {
  // Pinned as a constant because no unit test can open a real IMAP folder. The
  // BEHAVIOURAL proof that all four are really opened is the live harness,
  // `scripts/kindle-verify-live.ts`, which asserts the four real paths.
  assert.deepEqual([...WANTED_SPECIAL_USE], ['\\All', '\\Junk', '\\Trash']);
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

// ── the two reader guards that no end-to-end test can reach ──────────────────

test('🔴 a wanted folder the server never ADVERTISED is recorded as unsearched', () => {
  // The failure this closes is invisible from outside: if SPECIAL-USE is absent
  // on a session, the sweep silently narrows to INBOX and returns ok. The
  // controls cannot catch it — the pinned control notice lives in All Mail, so
  // it passes on a narrow sweep, and a real refusal sitting in SPAM comes back
  // clean. Only `skipped` makes that visible, and only then does the verifier
  // go blind on it.
  const plan = planFolders([
    { path: '[Gmail]/All Mail', specialUse: '\\All' },
    { path: '[Gmail]/Sent Mail', specialUse: '\\Sent' },
  ]);
  assert.deepEqual(plan.paths, ['INBOX', '[Gmail]/All Mail']);
  assert.equal(plan.unadvertised.length, 2, 'Junk and Trash were never offered');
  assert.match(plan.unadvertised.join(' '), /Junk/);
  assert.match(plan.unadvertised.join(' '), /Trash/);
});

test('a full Gmail listing leaves nothing unsearched', () => {
  const plan = planFolders([
    { path: '[Gmail]/All Mail', specialUse: '\\All' },
    { path: '[Gmail]/Spam', specialUse: '\\Junk' },
    { path: '[Gmail]/Trash', specialUse: '\\Trash' },
  ]);
  assert.equal(plan.paths.length, 4);
  assert.deepEqual(plan.unadvertised, []);
});

test('🔴 a message with no usable timestamp is NaN, so it cannot be silently dropped', () => {
  // It used to become epoch, fail the lower bound, and vanish with no trace in
  // `skipped` or anywhere else — a real bounce lost for a timekeeping reason.
  assert.ok(Number.isNaN(arrivalTime({})));
  assert.ok(Number.isNaN(arrivalTime({ envelope: { date: 'not a date' } })));
});

test('🔴 the SERVER arrival stamp wins over the sender-written Date header', () => {
  // Amazon's clock running seconds ahead of ours pushed a real refusal past the
  // upper bound, and it came back clean.
  const at = arrivalTime({
    internalDate: new Date('2026-08-26T21:47:00Z'),
    envelope: { date: new Date('2026-08-26T23:00:00Z') },
  });
  assert.equal(new Date(at).toISOString(), '2026-08-26T21:47:00.000Z');
  // …and a string internalDate, which imapflow's types also allow, is parsed.
  assert.equal(arrivalTime({ internalDate: '2026-08-26T21:47:00Z' }), Date.parse('2026-08-26T21:47:00Z'));
});

test('🔴 a quoted-printable soft break with TRANSPORT PADDING is still joined', () => {
  // RFC 2045 permits `=  \r\n`. A relay that adds a space defeated the bare
  // `=\r?\n` join, leaving `E014 = \n- Unapproved` and degrading the code to
  // UNKNOWN — one space to the left of the test that already pinned this.
  const raw =
    'Content-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n' +
    'could not be processed due to E014 =  \r\n- Unapproved sender email address.';
  assert.match(extractText(raw), /E014 - Unapproved sender email address/);
});

test('an unquoted boundary followed by another parameter still splits', () => {
  // `[^";\r\n]+` ran past the space `unfold()` inserts, swallowing the next
  // parameter into the boundary and splitting on nothing — returning the whole
  // raw body undecoded, which hides a base64 part entirely.
  const raw =
    'Content-Type: multipart/alternative; boundary=B charset=utf-8\r\n\r\n' +
    '--B\r\nContent-Type: text/plain\r\n\r\ndue to E009 - No Attachment\r\n' +
    '--B--\r\n';
  assert.match(extractText(raw), /E009 - No Attachment/);
});

test('🔴 an untimestampable message is UNPLACEABLE, not absent', () => {
  // The distinction is the whole file: a message we could not place in time is
  // recorded as unsearched, which makes the run blind. Silently dropping it
  // reports a clean mailbox for a mailbox with a refusal in it.
  const out = toBounceEmail({ envelope: { subject: 'There was a problem' } });
  assert.deepEqual(out, { unplaceable: true });

  const placed = toBounceEmail({
    internalDate: new Date('2026-08-26T21:47:00Z'),
    envelope: { subject: 'There was a problem', from: [{ address: 'do-not-reply@amazon.com' }] },
    source: Buffer.from('Content-Type: text/plain\r\n\r\ndue to E014 - Unapproved sender email address'),
  });
  assert.ok(!('unplaceable' in placed));
  if ('unplaceable' in placed) throw new Error('unreachable');
  assert.equal(placed.receivedAt, '2026-08-26T21:47:00.000Z');
  assert.equal(placed.from, 'do-not-reply@amazon.com');
  assert.match(placed.body, /E014 - Unapproved sender email address/);
});
