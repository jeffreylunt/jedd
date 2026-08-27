import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findDeliveryFailure, type BounceEmail } from '../src/kindle-delivery.js';

/**
 * Every fixture below is a REAL Amazon notice, taken verbatim from the mailbox
 * on 2026-08-24. None is invented — the whole point of this file is that the
 * instrument was designed against the artefact rather than against a guess.
 */

const bounce = (body: string, receivedAt: string): BounceEmail => ({
  from: 'do-not-reply@amazon.com',
  subject: 'There was a problem with the document(s) you sent to Kindle',
  body,
  receivedAt,
});

// Verbatim, thread 19ce8cfb60e359dd, 2026-03-13.
const E014 = bounce(
  'Dear customer,\nYour Send to Kindle request at 08:07 PM on Fri, Mar 13, 2026 GMT, could not be ' +
    'processed due to E014 - Unapproved sender email address.\nUnapproved sender email address: ' +
    'personthree@example.com\nTo learn more about the error and sending documents to Kindle, please ' +
    'visit our trouble shooting and help page.\nRegards, Amazon Kindle Support',
  '2026-03-13T20:07:32Z',
);

// Verbatim, thread 19dac357cb313212, 2026-04-20.
const E999 = bounce(
  'Dear customer, The following document(s), sent at 06:44 PM on Mon, Apr 20, 2026 GMT, could not ' +
    'be delivered due to E999 - Send to Kindle Internal Error: * East of Eden - John Steinbeck.epub',
  '2026-04-20T18:44:39Z',
);

const E001 = bounce(
  'Dear customer, The following document(s), sent at 06:51 PM on Mon, Apr 20, 2026 GMT, could not ' +
    'be delivered due to E001 - Unsupported File Format: * Steinbeck, John - East of Eden.mobi',
  '2026-04-20T18:51:21Z',
);

const E009 = bounce(
  'Dear customer, Your Send to Kindle request at 05:01 AM on Mon, Apr 20, 2026 GMT, could not be ' +
    'processed due to E009 - No Attachment.',
  '2026-04-20T05:01:34Z',
);

// ── 🔴 THE INSTRUMENT CAN FAIL — which V1 concluded it could not ─────────────

test('🔴 E014 unapproved sender is detected, with actionable advice', () => {
  const v = findDeliveryFailure([E014], new Date('2026-03-13T19:00:00Z'));
  assert.equal(v.state, 'failed');
  if (v.state !== 'failed') throw new Error('unreachable');
  assert.equal(v.code, 'E014');
  assert.match(v.detail, /approved-senders/i, 'the user can only fix this if told what to do');
});

test('🔴 every observed error code is recognised', () => {
  for (const [email, code] of [
    [E999, 'E999'],
    [E001, 'E001'],
    [E009, 'E009'],
  ] as const) {
    const v = findDeliveryFailure([email], new Date('2026-04-20T00:00:00Z'));
    assert.equal(v.state, 'failed');
    if (v.state !== 'failed') throw new Error('unreachable');
    assert.equal(v.code, code);
  }
});

test('🔴 the advice distinguishes MY fault from YOUR action from nobody-can', () => {
  const mine = findDeliveryFailure([E001], new Date('2026-04-20T00:00:00Z'));
  const theirs = findDeliveryFailure([E014], new Date('2026-03-13T00:00:00Z'));
  const amazon = findDeliveryFailure([E999], new Date('2026-04-20T00:00:00Z'));
  if (mine.state !== 'failed' || theirs.state !== 'failed' || amazon.state !== 'failed') {
    throw new Error('unreachable');
  }
  assert.match(mine.detail, /mine to fix/i);
  assert.match(theirs.detail, /Add the sender/i);
  assert.match(amazon.detail, /their side|worth retrying/i);
});

// ── 🔴 silence is NOT success ────────────────────────────────────────────────

test('🔴 no bounce is NO-FAILURE-SEEN, and explicitly not a confirmation', () => {
  // V1's probe was right about THIS case: a nonexistent address produces the
  // same silence as a success. The fix is that silence has its own state and
  // says so, rather than being read as delivery.
  const v = findDeliveryFailure([], new Date('2026-08-24T00:00:00Z'));
  assert.equal(v.state, 'no-failure-seen');
  assert.match(v.detail, /NOT confirmation/i);
  assert.match(v.detail, /discarded silently/i);
});

test('🔴 there is NO delivered state to set — success is unrepresentable', () => {
  // A `delivered` member would eventually be set on "no bounce yet", which is
  // exactly the false confirmation the V1 probe exposed.
  const states = new Set<string>();
  states.add(findDeliveryFailure([], new Date()).state);
  states.add(findDeliveryFailure([E014], new Date('2026-03-13T00:00:00Z')).state);
  assert.deepEqual([...states].sort(), ['failed', 'no-failure-seen']);
});

// ── attribution ──────────────────────────────────────────────────────────────

test('🔴 a bounce from BEFORE the send is not attributed to it', () => {
  // The mailbox holds many of these and they all share a subject line. Reading
  // an old one as this send's failure is a false report.
  const v = findDeliveryFailure([E014], new Date('2026-08-01T00:00:00Z'));
  assert.equal(v.state, 'no-failure-seen');
});

test('when several bounces share a window, the one naming the document wins', () => {
  const v = findDeliveryFailure(
    [E999, E001],
    new Date('2026-04-20T00:00:00Z'),
    'Steinbeck, John - East of Eden.mobi',
  );
  assert.equal(v.state, 'failed');
  if (v.state !== 'failed') throw new Error('unreachable');
  assert.equal(v.code, 'E001', 'the one that names this document, not merely the first');
});

test('mail that is not an Amazon Kindle notice is ignored', () => {
  const unrelated: BounceEmail = {
    from: 'store-news@amazon.com',
    subject: 'Important Updates to Our Terms & Conditions',
    body: 'We are writing to let you know that we have updated our Conditions of Use',
    receivedAt: '2026-08-14T19:28:01Z',
  };
  assert.equal(findDeliveryFailure([unrelated], new Date('2026-08-01T00:00:00Z')).state, 'no-failure-seen');
});
