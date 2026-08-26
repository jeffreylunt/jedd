import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BlueBubblesClient, type FetchImpl } from '../src/bluebubbles/client.js';
import { BlueBubblesConnector, BlueBubblesReceiver } from '../src/bluebubbles/receiver.js';
import { SeenStore } from '../src/bluebubbles/seen.js';
import { classifyPayload } from '../src/bluebubbles/payload.js';
import { BURST_TTL_MS, ReplyThreading } from '../src/bluebubbles/threading.js';

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

const JEFF = '+18018396586';

// ── the rule itself, with no transport anywhere near it ─────────────────────

test('one message in play sends PLAIN — the ordinary exchange is left alone', () => {
  const t = new ReplyThreading();
  t.arrived(JEFF, 'G-1');
  const d = t.decide(JEFF, 'G-1');
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
  t.arrived(JEFF, 'G-1');
  // ⚠️ The second message arrives while the first turn is still thinking. That
  // is the whole scenario — turns run concurrently (`void this.ingest(...)`), so
  // the reply to G-1 lands after G-2 is already on Jeff's screen.
  t.arrived(JEFF, 'G-2');

  const first = t.decide(JEFF, 'G-1');
  assert.equal(first.replyTo, 'G-1', 'the late reply must quote the message it actually answers');
  assert.equal(first.burstSize, 2);
  t.answered(JEFF, 'G-1');

  // And the reply to the NEWEST message is anchored too. It is the newest, so a
  // "is this their latest message" rule would send it plain — and it would still
  // be ambiguous, because Jeff is looking at two messages and one bare reply.
  const second = t.decide(JEFF, 'G-2');
  assert.equal(second.replyTo, 'G-2');
  assert.equal(second.burstSize, 2);
});

test('a reply anchors to ITS OWN message, never to the newest one', () => {
  const t = new ReplyThreading();
  t.arrived(JEFF, 'G-1');
  t.arrived(JEFF, 'G-2');
  t.arrived(JEFF, 'G-3');
  // The point of the whole feature: the answer to the first question quotes the
  // first question, so it cannot be mistaken for an answer to the third.
  assert.equal(t.decide(JEFF, 'G-1').replyTo, 'G-1');
  assert.equal(t.decide(JEFF, 'G-2').replyTo, 'G-2');
});

test('once the burst is answered, the next lone message goes back to plain', () => {
  const t = new ReplyThreading();
  t.arrived(JEFF, 'G-1');
  t.arrived(JEFF, 'G-2');
  t.answered(JEFF, 'G-1');
  t.answered(JEFF, 'G-2');
  assert.equal(t.inPlay(JEFF), 0, 'a fully answered burst must not linger');

  t.arrived(JEFF, 'G-3');
  assert.equal(t.decide(JEFF, 'G-3').replyTo, null);
});

test('a half-answered burst still counts — the other reply is still owed', () => {
  const t = new ReplyThreading();
  t.arrived(JEFF, 'G-1');
  t.arrived(JEFF, 'G-2');
  t.answered(JEFF, 'G-1');
  assert.equal(t.inPlay(JEFF), 2);
  assert.equal(t.decide(JEFF, 'G-2').replyTo, 'G-2');
});

test('bursts are per person: someone else texting does not anchor Jeff\'s reply', () => {
  const t = new ReplyThreading();
  t.arrived(JEFF, 'G-1');
  t.arrived('+13854346068', 'G-2');
  t.arrived('+13854346068', 'G-3');
  assert.equal(t.decide(JEFF, 'G-1').replyTo, null);
  assert.equal(t.decide('+13854346068', 'G-2').replyTo, 'G-2');
});

test('BlueBubbles double-firing the same message does not fake a burst', () => {
  // The same `guid` arrives twice within ~1ms (send + delivery receipt). If that
  // counted as two messages, EVERY reply would be anchored and the "only in that
  // case" half of the request would be silently dead.
  const t = new ReplyThreading();
  t.arrived(JEFF, 'G-1');
  t.arrived(JEFF, 'G-1');
  assert.equal(t.inPlay(JEFF), 1);
  assert.equal(t.decide(JEFF, 'G-1').replyTo, null);
});

test('🔴 a turn that never sends cannot anchor every later reply forever', () => {
  // `answered()` runs on the send path, so a turn that throws inside the model
  // call never closes its message. Without the age bound that message sits in
  // the burst for the life of the process and everything afterwards is quoted.
  const t = new ReplyThreading();
  const t0 = 1_000_000;
  t.arrived(JEFF, 'G-lost', t0);
  t.arrived(JEFF, 'G-next', t0 + BURST_TTL_MS + 1);
  assert.equal(t.inPlay(JEFF, t0 + BURST_TTL_MS + 1), 1, 'the abandoned message must have aged out');
  assert.equal(t.decide(JEFF, 'G-next', t0 + BURST_TTL_MS + 1).replyTo, null);
});

test('a message with no guid can never be anchored, and never inflates a burst', () => {
  const t = new ReplyThreading();
  t.arrived(JEFF, null);
  t.arrived(JEFF, 'G-1');
  assert.equal(t.inPlay(JEFF), 1);
  assert.equal(t.decide(JEFF, undefined).replyTo, null);
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
      handle: { address: JEFF },
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
  await client.sendText(JEFF, 'here you go', 'ANCHOR-1');
  const sent = bodies.find((b) => String(b['__url']).includes('/message/text'));
  assert.equal(sent?.['selectedMessageGuid'], 'ANCHOR-1');
  assert.equal(sent?.['partIndex'], 0);
});

test('a plain send does NOT — the field alone reroutes BlueBubbles to the Private API', async () => {
  // `if (effectId || subject || selectedMessageGuid || …) saniMethod = "private-api"`.
  // Sending the key with a null value would put every ordinary reply through a
  // path that needs the helper bundle connected, which was dead two days ago.
  const { client, bodies } = capturingClient(() => ({ status: 200, data: { guid: 'sent-1' } }));
  await client.sendText(JEFF, 'here you go');
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

  threading.arrived(JEFF, 'G-1');
  await connector.send(JEFF, 'one', 'G-1');
  assert.ok(!('selectedMessageGuid' in bodies[0]!), 'the ordinary exchange must not be quoted');

  threading.arrived(JEFF, 'G-2');
  threading.arrived(JEFF, 'G-3');
  await connector.send(JEFF, 'two', 'G-2');
  assert.equal(bodies[1]?.['selectedMessageGuid'], 'G-2');
});

test('a follow-up sends plain even mid-burst — it answers no incoming message', async () => {
  // `runDueFollowups` speaks unprompted ("that download finished"). Anchoring it
  // to whatever happened to be outstanding would quote an unrelated message.
  const threading = new ReplyThreading();
  const { connector, bodies } = connectorWith(threading, () => ({ status: 200, data: { guid: 'sent' } }));
  threading.arrived(JEFF, 'G-1');
  threading.arrived(JEFF, 'G-2');
  await connector.send(JEFF, 'your download finished');
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
  threading.arrived(JEFF, 'G-1');
  threading.arrived(JEFF, 'G-2');

  const out = await connector.sendReporting(JEFF, 'the answer', 'G-1');
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
  threading.arrived(JEFF, 'G-1');
  threading.arrived(JEFF, 'G-2');

  const out = await connector.sendReporting(JEFF, 'the answer', 'G-1');
  assert.equal(bodies.filter((b) => String(b['__url']).includes('/message/text')).length, 1);
  assert.match(out.detail, /ALREADY IN the sent history/);
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
  threading.arrived(JEFF, 'G-1');
  threading.arrived(JEFF, 'G-2');

  const out = await connector.sendReporting(JEFF, 'the answer', 'G-1');
  assert.equal(bodies.filter((b) => String(b['__url']).includes('/message/text')).length, 1);
  assert.equal(out.delivered, null, 'UNKNOWN is not "failed" and is not "sent"');
  assert.match(out.detail, /UNKNOWN whether it went out/);
});

test('a plain send that fails is still a throw — the fallback did not swallow it', async () => {
  const threading = new ReplyThreading();
  const { connector } = connectorWith(threading, () => ({ status: 500, data: null }));
  threading.arrived(JEFF, 'G-1');
  await assert.rejects(() => connector.send(JEFF, 'the answer', 'G-1'), /send failed/);
});
