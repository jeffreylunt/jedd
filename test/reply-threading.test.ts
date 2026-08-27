import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BlueBubblesClient, type FetchImpl } from '../src/bluebubbles/client.js';
import { BlueBubblesConnector, BlueBubblesReceiver } from '../src/bluebubbles/receiver.js';
import { SeenStore } from '../src/bluebubbles/seen.js';
import { classifyPayload } from '../src/bluebubbles/payload.js';
import { sendToken } from '../src/connector.js';
import { BURST_TTL_MS, REPLY_THREADING_ENABLED, ReplyThreading } from '../src/bluebubbles/threading.js';

/**
 * "Reply to a specific message", and the narrow case it is allowed to fire in.
 *
 * Jeff: "if the user sends more than one message before a response from Jedd,
 * we should have Jedd reply to the specific message so it is clear that it isn't
 * responding to the most recent one. Only in that case."
 *
 * So there are two claims to pin and the SECOND one matters as much as the
 * first: it anchors when a person is waiting on more than one reply, and it
 * does NOT anchor otherwise. A version that anchored everything would satisfy
 * every test about threading and still be the wrong feature.
 */

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'jedd-thread-')), 'seen.jsonl');
}

// The reserved +1555 range, like every other test here: a real-looking number
// in the committed tree is caught by `owner-config-fail-closed.test.ts`.
const OWNER = '+15550001001';
const SOMEONE_ELSE = '+15550001002';

// ── the rule itself, with no transport anywhere near it ─────────────────────

test('one message in play sends PLAIN — the ordinary exchange is left alone', () => {
  const t = new ReplyThreading();
  t.arrived(OWNER, 'G-1');
  const d = t.decide(OWNER, 'G-1');
  assert.equal(d.replyTo, null);
  assert.equal(d.burstSize, 1);
  assert.match(d.detail, /noise/);
});

/**
 * 🔴 THE MUTATION CHECK LIVES HERE.
 *
 * Loosen `size >= 2` to `size >= 1` in `ReplyThreading.decide` and the test
 * above fails: a lone message starts being anchored. Tighten it to `>= 3` and
 * the test below fails: a two-message burst stops being anchored. The condition
 * is pinned from both sides, so it cannot be quietly deleted and still pass.
 */
test('🔴 two messages in play: BOTH replies are anchored to the message they answer', () => {
  const t = new ReplyThreading();
  t.arrived(OWNER, 'G-1');
  // ⚠️ The second message arrives while the first turn is still thinking. That
  // is the whole scenario — turns run concurrently (`void this.ingest(...)`), so
  // the reply to G-1 lands after G-2 is already on Jeff's screen.
  t.arrived(OWNER, 'G-2');

  const first = t.decide(OWNER, 'G-1');
  assert.equal(first.replyTo, 'G-1', 'the late reply must quote the message it actually answers');
  assert.equal(first.burstSize, 2);
  t.answered(OWNER, 'G-1');

  // And the reply to the NEWEST message is anchored too. It is the newest, so a
  // "is this their latest message" rule would send it plain — and it would still
  // be ambiguous, because Jeff is looking at two messages and one bare reply.
  const second = t.decide(OWNER, 'G-2');
  assert.equal(second.replyTo, 'G-2');
  assert.equal(second.burstSize, 2);
});

test('a reply anchors to ITS OWN message, never to the newest one', () => {
  const t = new ReplyThreading();
  t.arrived(OWNER, 'G-1');
  t.arrived(OWNER, 'G-2');
  t.arrived(OWNER, 'G-3');
  // The point of the whole feature: the answer to the first question quotes the
  // first question, so it cannot be mistaken for an answer to the third.
  assert.equal(t.decide(OWNER, 'G-1').replyTo, 'G-1');
  assert.equal(t.decide(OWNER, 'G-2').replyTo, 'G-2');
});

test('once the burst is answered, the next lone message goes back to plain', () => {
  const t = new ReplyThreading();
  t.arrived(OWNER, 'G-1');
  t.arrived(OWNER, 'G-2');
  t.answered(OWNER, 'G-1');
  t.answered(OWNER, 'G-2');
  assert.equal(t.inPlay(OWNER), 0, 'a fully answered burst must not linger');

  t.arrived(OWNER, 'G-3');
  assert.equal(t.decide(OWNER, 'G-3').replyTo, null);
});

test('a half-answered burst still counts — the other reply is still owed', () => {
  const t = new ReplyThreading();
  t.arrived(OWNER, 'G-1');
  t.arrived(OWNER, 'G-2');
  t.answered(OWNER, 'G-1');
  assert.equal(t.inPlay(OWNER), 2);
  assert.equal(t.decide(OWNER, 'G-2').replyTo, 'G-2');
});

test('bursts are per person: someone else texting does not anchor Jeff\'s reply', () => {
  const t = new ReplyThreading();
  t.arrived(OWNER, 'G-1');
  t.arrived(SOMEONE_ELSE, 'G-2');
  t.arrived(SOMEONE_ELSE, 'G-3');
  assert.equal(t.decide(OWNER, 'G-1').replyTo, null);
  assert.equal(t.decide(SOMEONE_ELSE, 'G-2').replyTo, 'G-2');
});

test('BlueBubbles double-firing the same message does not fake a burst', () => {
  // The same `guid` arrives twice within ~1ms (send + delivery receipt). If that
  // counted as two messages, EVERY reply would be anchored and the "only in that
  // case" half of the request would be silently dead.
  const t = new ReplyThreading();
  t.arrived(OWNER, 'G-1');
  t.arrived(OWNER, 'G-1');
  assert.equal(t.inPlay(OWNER), 1);
  assert.equal(t.decide(OWNER, 'G-1').replyTo, null);
});

test('🔴 a turn that never sends cannot anchor every later reply forever', () => {
  // `answered()` runs on the send path, so a turn that throws inside the model
  // call never closes its message. Without the age bound that message sits in
  // the burst for the life of the process and everything afterwards is quoted.
  const t = new ReplyThreading();
  const t0 = 1_000_000;
  t.arrived(OWNER, 'G-lost', t0);
  t.arrived(OWNER, 'G-next', t0 + BURST_TTL_MS + 1);
  assert.equal(t.inPlay(OWNER, t0 + BURST_TTL_MS + 1), 1, 'the abandoned message must have aged out');
  assert.equal(t.decide(OWNER, 'G-next', t0 + BURST_TTL_MS + 1).replyTo, null);
});

test('a message with no guid can never be anchored, and never inflates a burst', () => {
  const t = new ReplyThreading();
  t.arrived(OWNER, null);
  t.arrived(OWNER, 'G-1');
  assert.equal(t.inPlay(OWNER), 1);
  assert.equal(t.decide(OWNER, undefined).replyTo, null);
});

// ── the guid has to survive the trip from the webhook payload ───────────────

test('classifyPayload carries the message guid, or the anchor has nothing to point at', () => {
  const v = classifyPayload({
    type: 'new-message',
    data: {
      originalROWID: 2600,
      guid: 'ABC-123',
      text: 'do you have dune?',
      isFromMe: false,
      handle: { address: OWNER },
    },
  });
  assert.equal(v.action, 'deliver');
  if (v.action !== 'deliver') return;
  assert.equal(v.message.sourceGuid, 'ABC-123');
});

// ── the wire format, against the parameter names read out of app.asar ───────

function capturingClient(
  onCall: (url: string, body: Record<string, unknown>) => { status: number; data: unknown },
): { client: BlueBubblesClient; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl: FetchImpl = async (u, init) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    bodies.push({ __url: String(u), ...body });
    const r = onCall(String(u), body);
    return { ok: r.status < 400, status: r.status, json: async () => ({ data: r.data }) } as Response;
  };
  return {
    client: new BlueBubblesClient({ baseUrl: 'http://bb.invalid:1234', password: 'pw', fetchImpl }),
    bodies,
  };
}

test('an anchored send puts selectedMessageGuid + partIndex on the wire', async () => {
  // These two names are not a guess. They are `MessageValidator.sendTextRules`
  // in the shipped BlueBubbles 1.9.9 `app.asar`, and a live send with them came
  // back with `threadOriginatorGuid` set to the anchor.
  const { client, bodies } = capturingClient(() => ({ status: 200, data: { guid: 'sent-1' } }));
  await client.sendText(OWNER, 'here you go', 'ANCHOR-1');
  const sent = bodies.find((b) => String(b['__url']).includes('/message/text'));
  assert.equal(sent?.['selectedMessageGuid'], 'ANCHOR-1');
  assert.equal(sent?.['partIndex'], 0);
});

test('a plain send does NOT — the field alone reroutes BlueBubbles to the Private API', async () => {
  // `if (effectId || subject || selectedMessageGuid || …) saniMethod = "private-api"`.
  // Sending the key with a null value would put every ordinary reply through a
  // path that needs the helper bundle connected, which was dead two days ago.
  const { client, bodies } = capturingClient(() => ({ status: 200, data: { guid: 'sent-1' } }));
  await client.sendText(OWNER, 'here you go');
  const sent = bodies.find((b) => String(b['__url']).includes('/message/text'));
  assert.ok(sent && !('selectedMessageGuid' in sent), 'the key must be absent, not null');
  assert.ok(sent && !('partIndex' in sent));
});

// ── end to end through the connector, including the failure path ────────────

function connectorWith(
  threading: ReplyThreading,
  onCall: (url: string, body: Record<string, unknown>) => { status: number; data: unknown },
): { connector: BlueBubblesConnector; bodies: Record<string, unknown>[] } {
  const { client, bodies } = capturingClient(onCall);
  const receiver = new BlueBubblesReceiver({
    selfIdentity: 'jedd-under-test@example.invalid',
    client,
    seen: new SeenStore(tempFile()),
    host: '127.0.0.1',
    port: 0,
    path: '/webhook',
    threading,
  });
  return {
    connector: new BlueBubblesConnector(receiver, client, 'everyone', undefined, undefined, threading),
    bodies,
  };
}

test('end to end: a lone reply is plain, a reply from a burst is anchored', async () => {
  const threading = new ReplyThreading();
  const { connector, bodies } = connectorWith(threading, () => ({ status: 200, data: { guid: 'sent' } }));

  threading.arrived(OWNER, 'G-1');
  await connector.send(OWNER, 'one', 'G-1');
  assert.ok(!('selectedMessageGuid' in bodies[0]!), 'the ordinary exchange must not be quoted');

  threading.arrived(OWNER, 'G-2');
  threading.arrived(OWNER, 'G-3');
  await connector.send(OWNER, 'two', 'G-2');
  assert.equal(bodies[1]?.['selectedMessageGuid'], 'G-2');
});

test('a follow-up sends plain even mid-burst — it answers no incoming message', async () => {
  // `runDueFollowups` speaks unprompted ("that download finished"). Anchoring it
  // to whatever happened to be outstanding would quote an unrelated message.
  const threading = new ReplyThreading();
  const { connector, bodies } = connectorWith(threading, () => ({ status: 200, data: { guid: 'sent' } }));
  threading.arrived(OWNER, 'G-1');
  threading.arrived(OWNER, 'G-2');
  await connector.send(OWNER, 'your download finished');
  assert.ok(!('selectedMessageGuid' in bodies[0]!));
});

test('🔴 a failed anchored send is downgraded to a plain one, not lost', async () => {
  // Measured on the live server: an unresolvable reply target stalls 120s and
  // then returns 500 "Transaction timeout" having sent NOTHING. Threading is
  // cosmetic; the reply is not.
  const threading = new ReplyThreading();
  const { connector, bodies } = connectorWith(threading, (url, body) => {
    if (url.includes('/message/query')) return { status: 200, data: [] }; // nothing was sent
    if ('selectedMessageGuid' in body) return { status: 500, data: null };
    return { status: 200, data: { guid: 'sent-plain' } };
  });
  threading.arrived(OWNER, 'G-1');
  threading.arrived(OWNER, 'G-2');

  const out = await connector.sendReporting(OWNER, 'the answer', 'G-1');
  assert.equal(out.state, 'accepted');
  assert.match(out.detail, /sent PLAIN/);
  const texts = bodies.filter((b) => String(b['__url']).includes('/message/text'));
  assert.equal(texts.length, 2);
  assert.ok(!('selectedMessageGuid' in texts[1]!), 'the retry must drop the anchor');
});

test('🔴 the retry does NOT fire when the first send already landed', async () => {
  const threading = new ReplyThreading();
  const { connector, bodies } = connectorWith(threading, (url, body) => {
    if (url.includes('/message/query')) {
      // BlueBubbles' own history says our text is already there.
      return { status: 200, data: [{ isFromMe: true, text: 'the answer', dateCreated: Date.now() }] };
    }
    if ('selectedMessageGuid' in body) return { status: 500, data: null };
    return { status: 200, data: { guid: 'sent-plain' } };
  });
  threading.arrived(OWNER, 'G-1');
  threading.arrived(OWNER, 'G-2');

  const out = await connector.sendReporting(OWNER, 'the answer', 'G-1');
  assert.equal(bodies.filter((b) => String(b['__url']).includes('/message/text')).length, 1);
  assert.match(out.detail, /ALREADY IN the sent history/);
  // 🔴 And it reports ACCEPTED, not failed. The message landed; only our answer
  // was lost. `failed` would make `send()` throw and the turn would be logged as
  // having thrown while the person was reading the reply.
  assert.equal(out.state, 'accepted');
});

test('🔴 an UNREADABLE history is not a licence to resend', async () => {
  // `recentlySent` returns null when it could not check. Treating null as "did
  // not send" is how a real person gets the same message twice.
  const threading = new ReplyThreading();
  const { connector, bodies } = connectorWith(threading, (url, body) => {
    if (url.includes('/message/query')) return { status: 500, data: null };
    if ('selectedMessageGuid' in body) return { status: 500, data: null };
    return { status: 200, data: { guid: 'sent-plain' } };
  });
  threading.arrived(OWNER, 'G-1');
  threading.arrived(OWNER, 'G-2');

  const out = await connector.sendReporting(OWNER, 'the answer', 'G-1');
  assert.equal(bodies.filter((b) => String(b['__url']).includes('/message/text')).length, 1);
  assert.equal(out.delivered, null, 'UNKNOWN is not "failed" and is not "sent"');
  assert.match(out.detail, /UNKNOWN whether it went out/);
});

test('a plain send that fails is still a throw — the fallback did not swallow it', async () => {
  const threading = new ReplyThreading();
  const { connector } = connectorWith(threading, () => ({ status: 500, data: null }));
  threading.arrived(OWNER, 'G-1');
  await assert.rejects(() => connector.send(OWNER, 'the answer', 'G-1'), /send failed/);
});

// ── 🔴 the self-address loop, measured live 2026-08-26 ──────────────────────

const SELF = 'personone@example.com';

function selfPayload(over: Record<string, unknown> = {}) {
  // The shape BlueBubbles actually delivered. Note `isFromMe: false` — this is
  // the SECOND copy, the one the account RECEIVED, and it is indistinguishable
  // from real inbound by every field here.
  return {
    type: 'new-message',
    data: {
      originalROWID: 2731,
      guid: 'SELF-1',
      text: "I'm not replying to my own text.",
      isFromMe: false,
      handle: { address: SELF },
      ...over,
    },
  };
}

test('🔴 a message from OUR OWN identity is skipped — it is an infinite self-reply loop', () => {
  const v = classifyPayload(selfPayload(), SELF);
  assert.equal(v.action, 'skip');
  if (v.action !== 'skip') return;
  assert.match(v.reason, /SELF-ADDRESSED/);
});

test('🔴 CONTROL: without the identity, that exact payload is DELIVERED', () => {
  // The control has to invert, or the test above is only asserting that some
  // payload gets skipped. This is the live defect: every other guard passes it.
  const v = classifyPayload(selfPayload());
  assert.equal(v.action, 'deliver', 'this is precisely the message that looped');
});

test('the guard is identity, not the isFromMe flag — both copies are stopped', () => {
  // BlueBubbles delivers the self-sent message twice. The `true` copy was always
  // caught as an outbound echo; the `false` copy is the one that looped.
  assert.equal(classifyPayload(selfPayload({ isFromMe: true }), SELF).action, 'skip');
  assert.equal(classifyPayload(selfPayload({ isFromMe: false }), SELF).action, 'skip');
});

test('the self guard is case- and formatting-insensitive, like every other handle compare', () => {
  assert.equal(classifyPayload(selfPayload({ handle: { address: '  PersonOne@example.com ' } }), SELF).action, 'skip');
});

test('🔴 the self guard is NOT a suffix match — a lookalike address still gets answered', () => {
  // `normaliseHandle` exists because a suffix compare was a full auth bypass.
  // Someone who can pick their own handle must not be able to silence Jedd by
  // ending it in our address.
  assert.equal(classifyPayload(selfPayload({ handle: { address: `not${SELF}` } }), SELF).action, 'deliver');
  assert.equal(classifyPayload(selfPayload({ handle: { address: `${SELF}.evil.com` } }), SELF).action, 'deliver');
});

test('a real person is unaffected by the self guard', () => {
  const v = classifyPayload(selfPayload({ handle: { address: OWNER } }), SELF);
  assert.equal(v.action, 'deliver');
});

// ── 🔴 the anchored fact has to REACH the log, or it may as well not exist ──

test('🔴 an anchored send reports anchoredTo — the fact is a FIELD, not a substring', async () => {
  // Measured 2026-08-26: `grep -c anchored jedd.log` returned 0 on a day
  // threading demonstrably worked twice, because `send()` returns void and
  // dropped the outcome. The first person to debug threading had to read
  // BlueBubbles' database instead.
  const threading = new ReplyThreading();
  const { connector } = connectorWith(threading, () => ({ status: 200, data: { guid: 'sent' } }));
  threading.arrived(OWNER, 'G-1');
  threading.arrived(OWNER, 'G-2');
  const out = await connector.sendReporting(OWNER, 'answer', 'G-1');
  assert.equal(out.anchoredTo, 'G-1');
});

test('a plain send reports anchoredTo: null', async () => {
  const threading = new ReplyThreading();
  const { connector } = connectorWith(threading, () => ({ status: 200, data: { guid: 'sent' } }));
  threading.arrived(OWNER, 'G-1');
  const out = await connector.sendReporting(OWNER, 'answer', 'G-1');
  assert.equal(out.anchoredTo, null);
});

test('🔴 a DOWNGRADED send reports plain, not the intention it started with', async () => {
  // Reporting "anchored" here would make the log lie about what the person saw.
  const threading = new ReplyThreading();
  const { connector } = connectorWith(threading, (url, body) => {
    if (url.includes('/message/query')) return { status: 200, data: [] };
    if ('selectedMessageGuid' in body) return { status: 500, data: null };
    return { status: 200, data: { guid: 'sent-plain' } };
  });
  threading.arrived(OWNER, 'G-1');
  threading.arrived(OWNER, 'G-2');
  const out = await connector.sendReporting(OWNER, 'answer', 'G-1');
  assert.match(out.detail, /sent PLAIN/);
  assert.equal(out.anchoredTo, null, 'it went out plain, so it must not read as anchored');
});

test('🔴 send() fills the record BEFORE it throws — which kind of send failed is half the diagnosis', async () => {
  const threading = new ReplyThreading();
  const { connector } = connectorWith(threading, () => ({ status: 500, data: null }));
  threading.arrived(OWNER, 'G-1');
  const rec = { anchored: false, detail: 'no send reached' };
  await assert.rejects(() => connector.send(OWNER, 'answer', 'G-1', rec));
  assert.notEqual(rec.detail, 'no send reached', 'the record must survive the throw');
});

test('sendToken renders the turn-log word', () => {
  assert.equal(sendToken({ anchored: true, detail: '' }), 'anchored');
  assert.equal(sendToken({ anchored: false, detail: '' }), 'plain');
  assert.equal(sendToken(undefined), 'unknown');
});

test('🔴 send() marks the record ANCHORED on the success path — the log line depends on it', async () => {
  // The gap this closes: every other test here asserts on `SendOutcome`, which
  // `send()` does not return. A mutation that re-derived `record.anchored` from a
  // REWORDED substring of `detail` passed the whole suite — the field was right
  // and the thing the log actually reads was silently always false.
  const threading = new ReplyThreading();
  const { connector } = connectorWith(threading, () => ({ status: 200, data: { guid: 'sent' } }));
  threading.arrived(OWNER, 'G-1');
  threading.arrived(OWNER, 'G-2');

  const rec = { anchored: false, detail: 'no send reached' };
  await connector.send(OWNER, 'answer', 'G-1', rec);
  assert.equal(rec.anchored, true, 'a quoted reply must read as anchored in the turn log');
  assert.equal(sendToken(rec), 'anchored');
});

test('send() marks the record PLAIN for an ordinary reply', async () => {
  const threading = new ReplyThreading();
  const { connector } = connectorWith(threading, () => ({ status: 200, data: { guid: 'sent' } }));
  threading.arrived(OWNER, 'G-1');
  const rec = { anchored: true, detail: 'stale' };
  await connector.send(OWNER, 'answer', 'G-1', rec);
  assert.equal(rec.anchored, false);
  assert.equal(sendToken(rec), 'plain');
});

// ── 🔴 the kill switch, and why the rule's own tests must keep passing ──────

test('🔴 threading is DISABLED — the trigger is not the subject (2026-08-26)', () => {
  // Jeff caught both anchors pointing at the other question. The anchors were
  // FAITHFUL to the message that triggered each turn; the turns answered each
  // other's questions. A confidently-wrong quote is worse than no quote.
  //
  // This asserts the shipped default, so re-enabling cannot happen by accident
  // or by a stray edit — it takes deleting this test, which means reading why.
  assert.equal(REPLY_THREADING_ENABLED, false);
});

test('the rule itself is kept intact and still correct about bursts', () => {
  // ⚠️ The flag is off because the INPUT (trigger→content) is unsound, not
  // because the rule is wrong. Every test above still passes and must keep
  // passing: when concurrency is fixed this is the logic that comes back, and
  // deleting it would mean re-deriving it from scratch.
  const t = new ReplyThreading();
  t.arrived(OWNER, 'G-1');
  assert.equal(t.decide(OWNER, 'G-1').replyTo, null);
  t.arrived(OWNER, 'G-2');
  assert.equal(t.decide(OWNER, 'G-1').replyTo, 'G-1');
});
