import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { BounceEmail } from '../src/kindle-delivery.js';
import type { MailboxReader } from '../src/kindle-mailbox.js';
import { FollowupStore, MAX_ATTEMPTS } from '../src/followups.js';
import { runDueFollowups, VERIFY_RETRY_MS } from '../src/followup-runner.js';
import { testConfig } from './helpers.js';

/**
 * The wiring, which is the half that was missing.
 *
 * `kindle-delivery.ts` shipped a mutation-tested classifier with **no production
 * caller** — nothing ever handed it a mailbox. These tests are about the thing
 * that now does: a real send schedules a check, the check speaks when Amazon
 * refuses, stays quiet when it has nothing to say, and escalates to the OWNER
 * when it cannot see.
 */

const GUEST = '+18015550188';
const OWNER = '+18015550123';
const SENT_AT = '2026-08-26T21:44:00Z';
const NOW = new Date('2026-08-26T22:00:00Z');

const bounce = (body: string, receivedAt: string): BounceEmail => ({
  from: 'do-not-reply@amazon.com',
  subject: 'There was a problem with the document(s) you sent to Kindle',
  body,
  receivedAt,
});

/** The notice the live control pins, so the controls pass in these runs. */
const CONTROL_E014 = bounce(
  'could not be processed due to E014 - Unapproved sender email address.',
  '2026-03-13T20:07:32Z',
);

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

function store(): FollowupStore {
  return new FollowupStore(join(mkdtempSync(join(tmpdir(), 'jedd-kv-')), 'f.jsonl'));
}

async function run(mailbox: MailboxReader | undefined, handle = GUEST) {
  const s = store();
  s.schedule({
    kind: 'kindle-verify',
    senderHandle: handle,
    dueAt: new Date(Date.parse(SENT_AT)),
    reason: 'sent "Tress of the Emerald Sea" to their Kindle',
    observed: `the mail server accepted it at ${SENT_AT}`,
    verify: { filename: 'Tress.epub', title: 'Tress of the Emerald Sea', sentAt: SENT_AT },
  });
  const sent: { to: string; text: string }[] = [];
  const out = await runDueFollowups(s, {
    config: testConfig({ ownerHandle: OWNER }),
    send: async (to, text) => {
      sent.push({ to, text });
    },
    ...(mailbox ? { mailbox } : {}),
    now: () => NOW,
  });
  return { out, sent, s };
}

// ── 🔴 IT SPEAKS WHEN AMAZON REFUSES. THIS IS THE WHOLE FEATURE. ─────────────

test('🔴 a refusal is reported to the person, with the code and what to do', async () => {
  const refusal = bounce(
    'Your Send to Kindle request at 09:44 PM on Wed, Aug 26, 2026 GMT, could not be processed due ' +
      'to E014 - Unapproved sender email address. * Tress.epub',
    '2026-08-26T21:47:00Z',
  );
  const { out, sent } = await run(fakeMailbox([CONTROL_E014, refusal]));
  assert.equal(out[0]?.action, 'refusal-reported');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.to, GUEST, 'a GUEST is told about their own book');
  assert.match(sent[0]!.text, /E014/);
  assert.match(sent[0]!.text, /approved-senders/i, 'the only fix is theirs to apply');
  assert.match(sent[0]!.text, /did NOT go through/i);
});

test('🔴 a refusal reaches a GUEST — withholding it would restore the silence', async () => {
  // The owner-only rule that is right for homelab follow-ups would, applied
  // here, leave a guest waiting forever on a book that was thrown away.
  const refusal = bounce('could not be delivered due to E001 - Unsupported File Format', '2026-08-26T21:50:00Z');
  const { sent } = await run(fakeMailbox([CONTROL_E014, refusal]), GUEST);
  assert.equal(sent[0]?.to, GUEST);
});

// ── 🔴 IT NEVER CLAIMS DELIVERY, AND STAYS QUIET WHEN IT HAS NOTHING ─────────

test('🔴 no refusal found sends NOTHING and claims nothing', async () => {
  const { out, sent } = await run(fakeMailbox([CONTROL_E014]));
  assert.equal(out[0]?.action, 'no-failure-seen');
  assert.equal(sent.length, 0, 'an unprompted "I found nothing, which proves nothing" is noise');
});

test('🔴 the recorded outcome for silence never reads as delivered', async () => {
  const { s, out } = await run(fakeMailbox([CONTROL_E014]));
  const rec = [...s.all()].find((f) => f.id === out[0]?.id);
  assert.equal(rec?.status, 'done');
  assert.match(rec?.outcome ?? '', /no refusal found/i);
  assert.match(rec?.outcome ?? '', /NOT confirmation/i);
  // 🔴 The recorded outcome is what a later reader — or a later ME — will treat
  // as the answer. If it says "delivered" anywhere, that is the word that gets
  // repeated back to somebody as fact.
  assert.doesNotMatch(rec?.outcome ?? '', /\bdelivered\b/i);
});

// ── 🔴 BLINDNESS GOES TO THE OWNER, AND IS NEVER SILENCE ────────────────────

test('🔴 a blind check retries, then tells the OWNER — not the requester', async () => {
  const broken: MailboxReader = async () => ({ ok: false, reason: 'Invalid credentials' });
  const s = store();
  s.schedule({
    kind: 'kindle-verify',
    senderHandle: GUEST,
    dueAt: new Date(Date.parse(SENT_AT)),
    reason: 'sent a book',
    observed: 'accepted by the mail server',
    verify: { filename: 'Tress.epub', title: 'Tress', sentAt: SENT_AT },
  });
  const sent: { to: string; text: string }[] = [];
  const deps: Parameters<typeof runDueFollowups>[1] = {
    config: testConfig({ ownerHandle: OWNER }),
    send: async (to: string, text: string) => {
      sent.push({ to, text });
    },
    mailbox: broken,
    now: () => NOW,
  };
  // Deferrals first, and NOBODY is bothered while it is still retrying. Time is
  // advanced rather than the record being poked, so the retry budget is the real
  // one and not one this test manufactured.
  let clock = NOW.getTime();
  deps.now = () => new Date(clock);
  let final;
  for (let i = 0; i < MAX_ATTEMPTS + 2; i += 1) {
    const out = await runDueFollowups(s, deps);
    if (out[0]?.action !== 'deferred') {
      final = out;
      break;
    }
    assert.equal(sent.length, 0, 'nothing is said while it is still retrying');
    clock += VERIFY_RETRY_MS;
  }
  assert.ok(final, 'it must stop retrying rather than checking forever');
  assert.equal(final[0]?.action, 'blind');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.to, OWNER, 'a blind checker is an operator problem, not the guest’s');
  assert.match(sent[0]!.text, /BLIND/);
  assert.match(sent[0]!.text, /going undetected/i);
});

test('🔴 a deployment with no mailbox reader SAYS the promise cannot be kept', async () => {
  // The send already told them "I will come back if Amazon refuses it". Quietly
  // resolving would leave that promise standing and unkept.
  const { out, sent } = await run(undefined);
  assert.equal(out[0]?.action, 'abandoned');
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /cannot read the mailbox/i);
  assert.match(sent[0]!.text, /do not know either way/i);
});

// ── attribution: the reason the send instant is stored ──────────────────────

test('🔴 a bounce from BEFORE this send is not reported as this send failing', async () => {
  // Every Amazon notice shares one subject line and the mailbox holds years of
  // them. Without the lower bound this check would manufacture failures.
  const april = bounce('could not be delivered due to E999 - Send to Kindle Internal Error', '2026-04-20T18:44:39Z');
  const { out, sent } = await run(fakeMailbox([CONTROL_E014, april]));
  assert.equal(out[0]?.action, 'no-failure-seen');
  assert.equal(sent.length, 0);
});

// ── 🔴 THE SCHEDULING, ON THE SHARED LEG ────────────────────────────────────
//
// `send_ebook` and the follow-up runner BOTH reach the SMTP hand-off through
// `deliverEbook`, so the check is scheduled there. Scheduling at either call
// site would let a future third caller send a book with no check at all — and
// the missing one would be invisible, because an unchecked send looks exactly
// like a checked one right up until Amazon throws the book away.

/** A real EPUB header, so the validator in front of the send passes. */
const EPUB = Buffer.concat([
  Buffer.from(
    '504b03041400160800004' + '7b9a3526f61ab2c140000001400000008000000' + '6d696d6574797065' +
      Buffer.from('application/epub+zip', 'latin1').toString('hex'),
    'hex',
  ),
  Buffer.alloc(400, 0x41),
]);

async function deliverThroughRunner(mail: (m: unknown) => Promise<{ messageId?: string }>) {
  const { KindleRegistry } = await import('../src/kindle.js');
  const { IrcEbooks } = await import('../src/media/irc-ebooks.js');
  void IrcEbooks;
  const dir = mkdtempSync(join(tmpdir(), 'jedd-sched-'));
  const kindle = new KindleRegistry(join(dir, 'k.jsonl'));
  kindle.save(GUEST, 'a_b@kindle.com', ['a_b@kindle.com']);
  const s = new FollowupStore(join(dir, 'f.jsonl'));
  s.schedule({
    kind: 'ebook-deliver',
    senderHandle: GUEST,
    dueAt: new Date(Date.parse(SENT_AT)),
    reason: 'started fetching "A Book.epub" for them',
    observed: 'queued a request on IRC',
    ebook: { source: 'irc', title: 'A Book.epub', command: '!Bsk A Book.epub', bot: 'Bsk' },
  });
  const irc = {
    rosterHas: () => true,
    async search() {
      return { state: 'none' as const, detail: 'unused' };
    },
    async fetch() {
      return { state: 'ok' as const, filename: 'A Book.epub', bytes: EPUB, detail: 'ok' };
    },
  } as unknown as import('../src/media/irc-ebooks.js').IrcEbooks;

  const out = await runDueFollowups(s, {
    config: testConfig({ ownerHandle: OWNER, readOnly: false }),
    send: async () => {},
    kindle,
    mail: mail as never,
    irc,
    now: () => NOW,
  });
  return { out, s };
}

test('🔴 a send that the mail server ACCEPTED schedules a delivery check', async () => {
  const before = Date.now();
  const { s } = await deliverThroughRunner(async () => ({ messageId: 'x' }));
  const check = s.all().find((f) => f.kind === 'kindle-verify');
  assert.ok(check, 'no check was scheduled, so a refusal would go unnoticed exactly as before');
  assert.equal(check.status, 'pending');
  assert.equal(check.senderHandle, GUEST);
  assert.equal(check.verify?.filename, 'A Book.epub');
  // 🔴 The instant is taken BEFORE the SMTP hand-off, so the round trip is
  // inside the searched window rather than in front of it. `before` is read here
  // rather than a frozen clock precisely because this must track the REAL time
  // of the send, not the runner's tick.
  assert.ok(Date.parse(check.verify!.sentAt) >= before, 'not taken at send time');
  assert.ok(Date.parse(check.verify!.sentAt) <= Date.now());
  assert.ok(Date.parse(check.dueAt) > Date.parse(check.verify!.sentAt));
});

test('🔴 a send the mail server REFUSED schedules NO check — there is nothing to check', async () => {
  const { out, s } = await deliverThroughRunner(async () => {
    throw new Error('550 mailbox unavailable');
  });
  assert.equal(s.all().filter((f) => f.kind === 'kindle-verify').length, 0);
  assert.match(out[0]?.detail ?? '', /refused it/i);
});
