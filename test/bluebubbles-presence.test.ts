import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  BlueBubblesClient,
  chatGuidFor,
  type FetchImpl,
  type PrivateApiResult,
} from '../src/bluebubbles/client.js';
import { CEILING_MS, Presence, type PresenceCapableClient, type TimerSeam } from '../src/bluebubbles/presence.js';
import { MAX_STEPS } from '../src/agent.js';
import { TURN_TIMEOUT_MS } from '../src/llm.js';
import { BlueBubblesConnector, BlueBubblesReceiver, ShadowConnector } from '../src/bluebubbles/receiver.js';
import { presenceToken, withPresence, type PresenceRecord } from '../src/connector.js';

/**
 * Typing indicators and read receipts.
 *
 * ── 🔴 WHAT THESE TESTS CAN AND CANNOT PROVE ──────────────────────────────────
 *
 * They CANNOT prove the feature works. Both signals require the BlueBubbles
 * Private API helper bundle, the helper requires SIP to be disabled, and on this
 * machine `server/info` reports `helper_connected: false`. Nothing below has
 * ever put a "…" on anybody's phone, and a green run here must not be read as if
 * it had.
 *
 * What they DO prove is the property that matters while that is true: **the
 * feature cannot hurt anything.** With the helper absent every call fails, and a
 * turn must still deliver its reply, unchanged, silently. That is the test worth
 * having tonight — it says the thing is safe to leave switched on until the day
 * it starts working.
 *
 * The helper-absent response below is the REAL one, copied from a live call to
 * `127.0.0.1:1234` on 2026-08-25, not an invented shape:
 *
 *   HTTP 500 in ~3ms
 *   {"status":500,
 *    "message":"Please make sure you have completed the setup for the Private API,
 *               and your helper is connected!",
 *    "error":{"type":"iMessage Error",
 *             "message":"iMessage Private API Helper is not connected!"}}
 */

const HELPER_ABSENT_BODY = {
  status: 500,
  message: 'Please make sure you have completed the setup for the Private API, and your helper is connected!',
  error: { type: 'iMessage Error', message: 'iMessage Private API Helper is not connected!' },
};

/**
 * ⚠️ Reserved-for-fiction, deliberately. The real owner handle is configuration,
 * not source — `owner-config-fail-closed.test.ts` scans the tracked tree for it
 * and fails. The percent-encoded literals below are this number, not Jeff's.
 */
const OWNER = '+18015550123';

/** Let the fire-and-forget chain drain. Presence never gives the caller a promise. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface Call {
  url: string;
  method: string;
  body: unknown;
  hasSignal: boolean;
  /** The request body exactly as it went out. Engine.IO frames are not JSON. */
  raw: string | undefined;
}

function scripted(reply: (c: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const impl: FetchImpl = async (url, init) => {
    const raw = init?.body === undefined ? undefined : String(init.body);
    let parsed: unknown;
    // ⚠️ Defensive: the socket transport puts Engine.IO frames (`40`, `42[…]`)
    // on the wire, and those are not JSON objects. A harness that assumed JSON
    // would throw inside the fake fetch and report as a client bug.
    try {
      parsed = raw === undefined ? undefined : JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      body: parsed,
      hasSignal: Boolean(init?.signal),
      raw,
    };
    calls.push(call);
    const r = reply(call);
    const payload = r.body;
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      json: async () => payload,
      text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    } as Response;
  };
  return { impl, calls };
}

/** Engine.IO's packet separator (0x1e), named so it is not an invisible byte. */
const RS = '\u001e';

/**
 * A BlueBubbles that speaks Engine.IO polling the way the real one does.
 *
 * The shapes are copied off the live `127.0.0.1:1234` on 2026-08-25, not
 * invented: the handshake answers a `0{…}` packet carrying the session id, and
 * ONE poll returns both the namespace ack and the server-emitted event,
 * separated by the record separator.
 */
function socketServer(
  opts: {
    channel?: (event: string) => string;
    data?: unknown;
    sid?: string | null;
    /** Status for the `40` join POST. */
    joinStatus?: number;
    /** Status for the `42` emit POST. */
    emitStatus?: number;
    /**
     * Frames to put in front of our answer, as BlueBubbles does — it broadcasts
     * every server event to every connected socket, and we stop typing at the
     * exact moment it is dispatching webhooks for the message just sent.
     */
    noise?: [string, unknown][];
    /**
     * Hold the answer back for this many polls, returning only the join ack.
     * Engine.IO flushes whatever is buffered the instant a poll opens.
     */
    withholdPolls?: number;
  } = {},
) {
  let emitted: [string, unknown] | null = null;
  let polls = 0;
  const handle = (c: Call): { status?: number; body: unknown } | null => {
    if (!c.url.includes('/socket.io/')) return null;
    if (c.method === 'GET' && !c.url.includes('sid=')) {
      const sid = opts.sid === undefined ? 'FAKESID' : opts.sid;
      return { body: sid === null ? '0{"upgrades":[]}' : `0{"sid":"${sid}","upgrades":[]}` };
    }
    if (c.method === 'POST') {
      if (c.raw === '40' && opts.joinStatus) return { status: opts.joinStatus, body: 'nope' };
      if (c.raw?.startsWith('42')) {
        if (opts.emitStatus) return { status: opts.emitStatus, body: 'nope' };
        emitted = JSON.parse(c.raw.slice(2)) as [string, unknown];
      }
      return { body: 'ok' };
    }
    polls += 1;
    const ack = polls === 1 ? `40{"sid":"FAKESID"}${RS}` : '';
    const noise = (opts.noise ?? []).map((n) => `42${JSON.stringify(n)}${RS}`).join('');
    if (polls <= (opts.withholdPolls ?? 0)) return { body: `${ack}${noise}` };
    const event = emitted?.[0] ?? 'nothing-was-emitted';
    const channel = opts.channel ? opts.channel(event) : `${event}-sent`;
    const data = opts.data ?? { status: 200, message: 'Success', data: null, encrypted: false };
    return { body: `${ack}${noise}42${JSON.stringify([channel, data])}` };
  };
  return { handle, emitted: () => emitted };
}

function client(impl: FetchImpl): BlueBubblesClient {
  return new BlueBubblesClient({ baseUrl: 'http://bb.invalid:1234', password: 'pw', fetchImpl: impl });
}

/** A hand-cranked clock, so the 30s refresh and the 6-minute ceiling are testable. */
function fakeTimers() {
  let seq = 0;
  let clock = 0;
  const pending = new Map<number, { fn: () => void; at: number }>();
  const timers: TimerSeam = {
    set(fn, ms) {
      const id = (seq += 1);
      pending.set(id, { fn, at: clock + ms });
      return id;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
  };
  const advance = (ms: number): void => {
    clock += ms;
    for (let guard = 0; guard < 1000; guard += 1) {
      const due = [...pending].find(([, t]) => t.at <= clock);
      if (!due) return;
      pending.delete(due[0]);
      due[1].fn();
    }
    throw new Error('fake clock ran away — a timer is re-arming in the past');
  };
  return { timers, advance, now: () => clock, pending: () => pending.size };
}

/** Records what was asked of the Private API, and can be made to fail either way. */
function stubClient(behaviour: 'ok' | 'helper-absent' | 'throw' = 'ok') {
  const calls: string[] = [];
  const answer = async (op: string, guid: string) => {
    calls.push(`${op} ${guid}`);
    if (behaviour === 'throw') throw new Error('ECONNREFUSED 127.0.0.1:1234');
    return behaviour === 'ok'
      ? { ok: true, status: 200, helperAbsent: false, detail: 'http 200' }
      : { ok: false, status: 500, helperAbsent: true, detail: 'Private API helper is not connected (http 500).' };
  };
  const impl: PresenceCapableClient = {
    startTyping: (g) => answer('start', g),
    stopTyping: (g) => answer('stop', g),
    markChatRead: (g) => answer('read', g),
  };
  return { impl, calls };
}

// ─────────────────────────────────────────────────────────────────────────────
// CALL CONSTRUCTION — the right verb at the right URL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ── 🔴 THE STOP DOES NOT GO OVER HTTP, AND THESE TESTS ARE WHY ────────────────
 *
 * `DELETE /api/v1/chat/{guid}/typing` on BlueBubbles 1.9.9 calls
 * `ChatInterface.startTyping` and answers HTTP 200 "Successfully stopped
 * typing!" — read out of the shipped `dist/main.js`, still on upstream `master`,
 * and confirmed live: BlueBubbles logs `Executing Action: Change Typing Status`
 * for the socket route and NOTHING for the DELETE.
 *
 * ⚠️ THE TEST THAT USED TO LIVE HERE ASSERTED THE BUG. It read
 * "startTyping POSTs to the chat typing route, stopTyping DELETEs the same one",
 * it was green for every one of the DELETEs that turned Jeff's indicator back on
 * after every reply, and it would have gone RED against the fix. A test that
 * pins the call to the route rather than to the OUTCOME cannot tell a stop from
 * a start.
 */

test('🔴 stopTyping issues NO DELETE to the typing route — that route starts typing', async () => {
  const socket = socketServer();
  const { impl, calls } = scripted((c) => socket.handle(c) ?? { body: { status: 200 } });
  await client(impl).stopTyping(chatGuidFor(OWNER));

  const deletes = calls.filter((k) => k.method === 'DELETE');
  assert.deepEqual(
    deletes.map((k) => k.url),
    [],
    'a DELETE went out — on BlueBubbles 1.9.9 that STARTS the indicator and reports success',
  );
});

test('🔴 stopTyping emits the socket.io stopped-typing event for the right chat', async () => {
  const socket = socketServer();
  const { impl, calls } = scripted((c) => socket.handle(c) ?? { body: { status: 200 } });
  const r = await client(impl).stopTyping(chatGuidFor(OWNER));

  assert.deepEqual(socket.emitted(), ['stopped-typing', { chatGuid: chatGuidFor(OWNER) }]);
  assert.equal(r.ok, true);
  assert.ok(
    calls.every((k) => k.url.includes('/socket.io/')),
    'stopTyping touched something other than the socket transport',
  );
});

test('🔴 startTyping STAYS on the HTTP POST — it is what arms BlueBubbles stop-on-send', async () => {
  // `ChatInterface.startTyping` is the only thing that pushes the guid into
  // `Server().typingCache`, and that cache is the sole trigger for BlueBubbles'
  // own stopTyping inside its send path. Move start onto the socket for symmetry
  // and the indicator still appears, every test still passes, and the last
  // independent stop this design has is silently gone.
  const socket = socketServer();
  const { impl, calls } = scripted((c) => socket.handle(c) ?? { body: { status: 200, message: 'Success' } });
  await client(impl).startTyping(chatGuidFor(OWNER));

  const path = '/api/v1/chat/iMessage%3B-%3B%2B18015550123/typing';
  assert.equal(calls.length, 1, 'startTyping should be one plain HTTP call');
  assert.equal(calls[0]?.method, 'POST');
  assert.ok(calls[0]?.url.startsWith(`http://bb.invalid:1234${path}?`), calls[0]?.url);
  assert.equal(socket.emitted(), null, 'startTyping went over the socket — stop-on-send is now unarmed');
});

test('start and stop address the SAME conversation, over two different transports', async () => {
  const socket = socketServer();
  const { impl, calls } = scripted((c) => socket.handle(c) ?? { body: { status: 200, message: 'Success' } });
  const c = client(impl);
  await c.startTyping(chatGuidFor(OWNER));
  await c.stopTyping(chatGuidFor(OWNER));

  // Read the guid the START actually put on the wire rather than restating the
  // literal: a mismatch is a stuck indicator on one thread and a silent one on
  // another, and each call looks right on its own.
  const started = decodeURIComponent(String(calls[0]?.url.split('/chat/')[1]?.split('/typing')[0]));
  assert.equal((socket.emitted()?.[1] as { chatGuid?: string })?.chatGuid, started);
});

test('🔴 a socket error answer is NOT laundered into a success', async () => {
  const socket = socketServer({
    channel: (e) => `${e}-error`,
    data: { status: 500, message: 'Failed to stop typing!' },
  });
  const { impl } = scripted((c) => socket.handle(c) ?? { body: { status: 200 } });
  const r = await client(impl).stopTyping(chatGuidFor(OWNER));

  assert.equal(r.ok, false);
  assert.equal(r.status, 500);
  assert.match(r.detail, /stopped-typing-error/);
});

test('a handshake that yields no session id is a reported failure, not a throw', async () => {
  const socket = socketServer({ sid: null });
  const { impl } = scripted((c) => socket.handle(c) ?? { body: { status: 200 } });
  const r = await client(impl).stopTyping(chatGuidFor(OWNER));

  assert.equal(r.ok, false);
  assert.match(r.detail, /no session id/);
});

test('the socket session is CLOSED, not left for BlueBubbles to time out', async () => {
  const socket = socketServer();
  const { impl, calls } = scripted((c) => socket.handle(c) ?? { body: { status: 200 } });
  await client(impl).stopTyping(chatGuidFor(OWNER));

  assert.ok(
    calls.some((k) => k.method === 'POST' && k.raw === '41' && k.url.includes('sid=')),
    'no Engine.IO disconnect frame at the SESSION — a 41 with no sid closes nothing',
  );
});

test('🔴 an unrelated broadcast in front of the answer is not mistaken for it', async () => {
  // BlueBubbles broadcasts every server event to every connected socket, and we
  // stop typing at the exact moment it is dispatching webhooks for the message
  // just sent. Taking the FIRST `42` frame reports a healthy stop as a failure,
  // once per turn.
  const socket = socketServer({
    noise: [
      ['new-message', { status: 200, data: { guid: 'just-sent' } }],
      ['typing-indicator', { status: 200, data: { display: false } }],
    ],
  });
  const { impl } = scripted((c) => socket.handle(c) ?? { body: { status: 200 } });
  const r = await client(impl).stopTyping(chatGuidFor(OWNER));

  assert.equal(r.ok, true, r.detail);
  assert.match(r.detail, /stopped-typing-sent/);
});

test('a poll carrying only the join ack is retried, not called a failure', async () => {
  // Engine.IO flushes whatever is buffered the instant a poll opens, so the
  // first poll can return the `40` ack alone with the answer a tick behind. The
  // emit already landed; the indicator really did stop.
  const socket = socketServer({ withholdPolls: 1 });
  const { impl } = scripted((c) => socket.handle(c) ?? { body: { status: 200 } });
  const r = await client(impl).stopTyping(chatGuidFor(OWNER));

  assert.equal(r.ok, true, r.detail);
});

test('a silent server is reported as no answer rather than retried forever', async () => {
  const socket = socketServer({ withholdPolls: 99 });
  const { impl, calls } = scripted((c) => socket.handle(c) ?? { body: { status: 200 } });
  const r = await client(impl).stopTyping(chatGuidFor(OWNER));

  assert.equal(r.ok, false);
  assert.match(r.detail, /no answer to stopped-typing/);
  assert.ok(calls.filter((k) => k.method === 'GET' && k.url.includes('sid=')).length <= 2, 'unbounded polling');
});

test('🔴 a refused namespace join is named as such, not surfaced three steps later', async () => {
  // A rejected join means the emit is dropped server-side and the stop is
  // genuinely lost. Reported as "no answer" it would point at the wrong leg.
  const socket = socketServer({ joinStatus: 401 });
  const { impl } = scripted((c) => socket.handle(c) ?? { body: { status: 200 } });
  const r = await client(impl).stopTyping(chatGuidFor(OWNER));

  assert.equal(r.ok, false);
  assert.match(r.detail, /join refused/);
});

test('a refused emit is named as such', async () => {
  const socket = socketServer({ emitStatus: 400 });
  const { impl } = scripted((c) => socket.handle(c) ?? { body: { status: 200 } });
  const r = await client(impl).stopTyping(chatGuidFor(OWNER));

  assert.equal(r.ok, false);
  assert.match(r.detail, /emit refused/);
});

test('🔴 CONTROL: a transport failure still THROWS out of stopTyping', async () => {
  // The swallow belongs in `Presence`, not here. If this could not throw, every
  // "the turn still delivers" test above would be proving nothing.
  const impl: FetchImpl = async () => {
    throw new Error('ECONNREFUSED 127.0.0.1:1234');
  };
  await assert.rejects(() => client(impl).stopTyping(chatGuidFor(OWNER)), /ECONNREFUSED/);
});

test('markChatRead POSTs to the chat read route', async () => {
  const { impl, calls } = scripted(() => ({ body: { status: 200, message: 'Success' } }));
  await client(impl).markChatRead(chatGuidFor(OWNER));
  assert.equal(calls[0]?.method, 'POST');
  assert.ok(calls[0]?.url.includes('/api/v1/chat/iMessage%3B-%3B%2B18015550123/read?'), calls[0]?.url);
});

test('every presence call is bounded — a hung BlueBubbles cannot hold a socket open', async () => {
  const { impl, calls } = scripted(() => ({ body: { status: 200 } }));
  const c = client(impl);
  await c.startTyping(chatGuidFor(OWNER));
  await c.stopTyping(chatGuidFor(OWNER));
  await c.markChatRead(chatGuidFor(OWNER));
  assert.equal(calls.length, 3);
  assert.ok(
    calls.every((k) => k.hasSignal),
    'a presence call went out with no AbortSignal',
  );
});

test('🔴 typing addresses the SAME chat guid that a send addresses — not a second scheme', async () => {
  const { impl, calls } = scripted(() => ({ body: { status: 200, data: { guid: 'g' } } }));
  const c = client(impl);
  await c.sendText(OWNER, 'hello');
  await c.startTyping(chatGuidFor(OWNER));

  // 🔴 Read the guid the SEND actually put on the wire, rather than restating
  // the literal in the assertion. Restating it is exactly what lets the two
  // drift: each would still look right on its own, and only the PAIRING would
  // be wrong — a typing indicator on one thread, the reply on another.
  const sentGuid = (calls[0]?.body as { chatGuid?: string } | undefined)?.chatGuid;
  assert.equal(sentGuid, chatGuidFor(OWNER));
  assert.ok(calls[1]?.url.includes(encodeURIComponent(String(sentGuid))), calls[1]?.url);
});

test('🔴 serverInfo reports the SETTING and the HELPER separately — either alone lies', async () => {
  // The live state on 2026-08-25: the Private API setting is ON and the helper
  // is NOT loaded. Reading only `private_api` says the feature is available,
  // and every call would still fail.
  const { impl } = scripted(() => ({
    body: {
      status: 200,
      data: {
        detected_imessage: 'jedd@invalid',
        server_version: '1.9.9',
        private_api: true,
        helper_connected: false,
      },
    },
  }));
  const info = await client(impl).serverInfo();
  assert.equal(info.privateApiEnabled, true);
  assert.equal(info.helperConnected, false);
});

test('a missing or non-boolean helper flag is NOT read as a capability', async () => {
  for (const helper of [undefined, 'true', 1, null]) {
    const { impl } = scripted(() => ({
      body: {
        status: 200,
        data: { detected_imessage: 'jedd@invalid', server_version: '1.9.9', helper_connected: helper },
      },
    }));
    const info = await client(impl).serverInfo();
    assert.equal(info.helperConnected, false, `helper_connected=${JSON.stringify(helper)} was read as available`);
  }
});

test('🔴 the LIVE helper-absent 500 is recognised as expected, not as a fault', async () => {
  const { impl } = scripted(() => ({ status: 500, body: HELPER_ABSENT_BODY }));
  const r = await client(impl).startTyping(chatGuidFor(OWNER));
  assert.equal(r.ok, false);
  assert.equal(r.status, 500);
  assert.equal(r.helperAbsent, true);
  assert.match(r.detail, /SIP/);
});

test('a 500 that is NOT the helper is not laundered into the expected case', async () => {
  const { impl } = scripted(() => ({
    status: 500,
    body: { status: 500, message: 'Something went wrong', error: { message: 'unexpected' } },
  }));
  const r = await client(impl).startTyping(chatGuidFor(OWNER));
  assert.equal(r.helperAbsent, false);
  assert.match(r.detail, /Something went wrong/);
});

test('🔴 CONTROL: the client itself still THROWS on transport failure', async () => {
  // If it did not, every "the turn survives a failure" test below would be
  // asserting against a subject that cannot fail, and would prove nothing.
  const impl: FetchImpl = async () => {
    throw new Error('ECONNREFUSED');
  };
  await assert.rejects(() => client(impl).startTyping(chatGuidFor(OWNER)), /ECONNREFUSED/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE FAILURE PATH — the test that matters while the helper is absent
// ─────────────────────────────────────────────────────────────────────────────

test('🔴 with the helper ABSENT, a turn returns its reply exactly as it would have', async () => {
  // ⚠️ The socket leg is scripted the way a real helper-absent server answers
  // it, NOT as another 500. `/socket.io/` is not behind the Private API
  // middleware, so the handshake succeeds and the failure comes back as
  // `stopped-typing-error` with BlueBubbles' fixed wording — which is exactly
  // why the stop cannot identify itself as helper-absent. Scripting a 500 there
  // would have tested a server that does not exist.
  const socket = socketServer({
    channel: (e) => `${e}-error`,
    data: { status: 500, message: 'Failed to stop typing!' },
  });
  const { impl, calls } = scripted(
    (c) =>
      socket.handle(c) ??
      (c.url.includes('/message/text')
        ? { body: { status: 200, data: { guid: 'sent-1' } } }
        : { status: 500, body: HELPER_ABSENT_BODY }),
  );
  const bb = client(impl);
  const lines: string[] = [];
  const presence = new Presence({ client: bb, log: (l) => lines.push(l) });

  presence.markRead(OWNER);
  const reply = await presence.withTyping(OWNER, async () => {
    await bb.sendText(OWNER, 'Dune is ready to watch.');
    return 'Dune is ready to watch.';
  });
  await flush();

  assert.equal(reply, 'Dune is ready to watch.');
  assert.ok(
    calls.some((c) => c.url.includes('/message/text')),
    'the reply never went out',
  );
});

test('🔴 the helper being absent does not add a line per turn, forever', async () => {
  // Its own test: the assertion above dies on the reply, and if these shared a
  // test body this one would never run. Every presence call fails on every turn
  // here, which is the state this machine has been in since the feature shipped.
  const socket = socketServer({
    channel: (e) => `${e}-error`,
    data: { status: 500, message: 'Failed to stop typing!' },
  });
  const { impl } = scripted((c) => socket.handle(c) ?? { status: 500, body: HELPER_ABSENT_BODY });
  const bb = client(impl);
  const lines: string[] = [];
  const presence = new Presence({ client: bb, log: (l) => lines.push(l) });

  for (let turn = 0; turn < 5; turn += 1) {
    presence.markRead(OWNER);
    await presence.withTyping(OWNER, async () => 'ok');
    await flush();
  }

  // One notice naming the cause, and one line for the stop — which cannot name
  // it, because BlueBubbles' socket handler discards the helper's wording.
  assert.equal(lines.length, 2, `five turns produced ${lines.length} lines:\n${lines.join('\n')}`);
  assert.equal(lines.filter((l) => l.includes('once per process')).length, 1, lines.join('\n'));
});

test('🔴 with the transport THROWING, a turn still returns its reply', async () => {
  const { impl } = stubClient('throw');
  const lines: string[] = [];
  const presence = new Presence({ client: impl, log: (l) => lines.push(l) });

  presence.markRead(OWNER);
  const reply = await presence.withTyping(OWNER, async () => 'the answer');
  await flush();

  assert.equal(reply, 'the answer');
  assert.ok(lines.every((l) => l.includes('a reply is unaffected')), lines.join('\n'));
});

test('markRead hands the caller no promise at all, so it cannot be awaited by accident', async () => {
  const { impl } = stubClient('throw');
  const presence = new Presence({ client: impl, log: () => {} });
  assert.equal(presence.markRead(OWNER), undefined);
  await flush(); // an unhandled rejection here would fail the run
});

test('the helper-absent notice is said ONCE, not on every turn for the rest of time', async () => {
  const { impl } = stubClient('helper-absent');
  const lines: string[] = [];
  const presence = new Presence({ client: impl, log: (l) => lines.push(l) });
  for (let i = 0; i < 5; i += 1) {
    presence.markRead(OWNER);
    await presence.withTyping(OWNER, async () => 'ok');
    await flush();
  }
  assert.equal(lines.length, 1, `expected one notice across five turns, got:\n${lines.join('\n')}`);
});

/**
 * A hand-built presence client whose answer can be set PER OPERATION.
 *
 * ⚠️ Per-operation on purpose. An earlier version returned one answer for all
 * three, which made "the stop is the call that cannot self-identify" untestable:
 * the START failed identically, so an assertion about the stop was satisfied by
 * the start being quiet.
 */
function switchableClient() {
  const ok: PrivateApiResult = { ok: true, status: 200, helperAbsent: false, detail: 'http 200' };
  const next: Record<'start' | 'stop' | 'read', PrivateApiResult> = { start: ok, stop: ok, read: ok };
  const impl: PresenceCapableClient = {
    startTyping: async () => next.start,
    stopTyping: async () => next.stop,
    markChatRead: async () => next.read,
  };
  return {
    impl,
    ok,
    set: (which: Partial<typeof next>) => Object.assign(next, which),
  };
}

const HELPER_ABSENT: PrivateApiResult = {
  ok: false, status: 500, helperAbsent: true, detail: 'Private API helper is not connected (http 500).',
};
/** BlueBubbles' socket handler discards the helper's wording and says only this. */
const SOCKET_STOP_ERROR: PrivateApiResult = {
  ok: false, status: 500, helperAbsent: false, detail: 'stopped-typing-error: Failed to stop typing!',
};

/**
 * ⚠️ A TEST THAT SAID THE OPPOSITE USED TO LIVE HERE. It asserted that a
 * repeated stop failure was said ONCE, which was right before a failing stop
 * was understood to mean a stranded indicator and wrong after. It is replaced
 * by the loud-stop tests below plus this one, which keeps the quiet rule where
 * it still belongs: the signals nobody can see.
 */
test('a standing failure on an INVISIBLE signal is said once, not once per turn', async () => {
  // A read receipt that does not go out costs nothing anybody is looking at, so
  // a per-turn red line about a standing cause is pure noise.
  const { impl, set } = switchableClient();
  const lines: string[] = [];
  const presence = new Presence({ client: impl, log: (l) => lines.push(l) });

  set({ read: { ok: false, status: 503, helperAbsent: false, detail: 'http 503: upstream gone' } });
  for (let turn = 0; turn < 4; turn += 1) {
    presence.markRead(OWNER);
    await flush();
  }

  const about = lines.filter((l) => l.includes('upstream gone'));
  assert.equal(about.length, 1, `four turns, ${about.length} lines about one standing condition:\n${lines.join('\n')}`);
});

test('🔴 a failed STOP is LOUD — every occurrence, no deduplication', async () => {
  // The entire reason the inverted-DELETE bug survived is that a failing stop
  // reported success. A stop that does not land leaves a "…" on a real person's
  // phone, and each occurrence is a different person at a different moment —
  // quieting a repeat would be quieting a second stranded indicator.
  const { impl, set } = switchableClient();
  const lines: string[] = [];
  const presence = new Presence({ client: impl, log: (l) => lines.push(l) });

  set({ stop: SOCKET_STOP_ERROR });
  for (let turn = 0; turn < 4; turn += 1) {
    await presence.withTyping(OWNER, async () => 'ok');
    await flush();
  }

  const stranded = lines.filter((l) => l.includes('STOP FAILED'));
  assert.equal(stranded.length, 4, `four failed stops, ${stranded.length} lines:\n${lines.join('\n')}`);
});

test('🔴 the loud stop names the consequence, not just the error', async () => {
  // Its own test: the count above can pass while the line says nothing a reader
  // can act on. Somebody reading this at 2am needs to know a real person is
  // looking at a "…" that will never resolve.
  const { impl, set } = switchableClient();
  const lines: string[] = [];
  const presence = new Presence({ client: impl, log: (l) => lines.push(l) });

  set({ stop: SOCKET_STOP_ERROR });
  await presence.withTyping(OWNER, async () => 'ok');
  await flush();

  assert.match(lines.join('\n'), /STRANDED/);
  assert.match(lines.join('\n'), new RegExp(OWNER.replace('+', '\\+')));
});

test('🔴 a failed stop stays loud even while the helper-absent notice stands', async () => {
  // The suppression that quiets everything else must not reach this one. With
  // the helper absent EVERY call fails, and that is exactly when a blanket rule
  // is most tempting.
  const { impl, set } = switchableClient();
  const lines: string[] = [];
  const presence = new Presence({ client: impl, log: (l) => lines.push(l) });

  set({ read: HELPER_ABSENT, stop: SOCKET_STOP_ERROR });
  presence.markRead(OWNER);
  await flush();
  for (let turn = 0; turn < 3; turn += 1) {
    await presence.withTyping(OWNER, async () => 'ok');
    await flush();
  }

  assert.equal(lines.filter((l) => l.includes('once per process')).length, 1, lines.join('\n'));
  assert.equal(lines.filter((l) => l.includes('STOP FAILED')).length, 3, lines.join('\n'));
});

test('🔴 CONTROL: a failed stop is QUIET when no start ever landed — nothing can be stranded', async () => {
  // The asymmetry is the whole point. If the start never landed there is no
  // indicator showing, so a failed stop has no visible cost and is a
  // consequence of the same cause. Without this the helper being absent would
  // print a red STRANDED line every turn about an indicator that never existed.
  const { impl, set } = switchableClient();
  const lines: string[] = [];
  const presence = new Presence({ client: impl, log: (l) => lines.push(l) });

  set({ start: HELPER_ABSENT, stop: SOCKET_STOP_ERROR });
  for (let turn = 0; turn < 3; turn += 1) {
    await presence.withTyping(OWNER, async () => 'ok');
    await flush();
  }

  assert.equal(lines.filter((l) => l.includes('STOP FAILED')).length, 0, lines.join('\n'));
});

test('🔴 a DIFFERENT failure is still reported while the first one stands', async () => {
  // The mute must be per-message, not a blanket. A blanket version would have
  // hidden every fault in the new socket transport behind an unrelated notice,
  // for the life of the process.
  const { impl, set } = switchableClient();
  const lines: string[] = [];
  const presence = new Presence({ client: impl, log: (l) => lines.push(l) });

  set({ stop: SOCKET_STOP_ERROR });
  await presence.withTyping(OWNER, async () => 'ok');
  await flush();

  set({ stop: { ok: false, status: 401, helperAbsent: false, detail: 'socket handshake refused (http 401)' } });
  await presence.withTyping(OWNER, async () => 'ok');
  await flush();

  assert.ok(
    lines.some((l) => l.includes('handshake refused')),
    `a new fault was muted by an unrelated standing one:\n${lines.join('\n')}`,
  );
});

test('🔴 the helper-absent notice does not repeat while every call keeps failing', async () => {
  const { impl, set } = switchableClient();
  const lines: string[] = [];
  const presence = new Presence({ client: impl, log: (l) => lines.push(l) });

  set({ start: HELPER_ABSENT, read: HELPER_ABSENT, stop: SOCKET_STOP_ERROR });
  for (let turn = 0; turn < 4; turn += 1) {
    presence.markRead(OWNER);
    await presence.withTyping(OWNER, async () => 'ok');
    await flush();
  }

  const notices = lines.filter((l) => l.includes('once per process'));
  assert.equal(notices.length, 1, `expected one notice across four turns:\n${lines.join('\n')}`);
});

test('🔴 a SUCCESS re-arms reporting — the suppression must not outlive its cause', async () => {
  const { impl, set, ok } = switchableClient();
  const lines: string[] = [];
  const presence = new Presence({ client: impl, log: (l) => lines.push(l) });

  set({ stop: SOCKET_STOP_ERROR });
  await presence.withTyping(OWNER, async () => 'ok');
  await flush();

  // Whatever was wrong is over...
  set({ stop: ok });
  await presence.withTyping(OWNER, async () => 'ok');
  await flush();

  // ...so the same condition returning is news again, not old news.
  set({ stop: SOCKET_STOP_ERROR });
  await presence.withTyping(OWNER, async () => 'ok');
  await flush();

  const about = lines.filter((l) => l.includes('Failed to stop typing'));
  assert.equal(about.length, 2, `a recurrence after a success was muted:\n${lines.join('\n')}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 STOP-ALWAYS — a stuck "…" is worse than no indicator
// ─────────────────────────────────────────────────────────────────────────────

test('typing stops when the turn succeeds', async () => {
  const { impl, calls } = stubClient();
  const presence = new Presence({ client: impl, log: () => {} });
  await presence.withTyping(OWNER, async () => 'done');
  await flush();
  assert.deepEqual(calls, [`start ${chatGuidFor(OWNER)}`, `stop ${chatGuidFor(OWNER)}`]);
});

test('🔴 typing stops when the turn THROWS — and the error reaches the caller unchanged', async () => {
  const { impl, calls } = stubClient();
  const presence = new Presence({ client: impl, log: () => {} });
  const boom = new Error('the model timed out after 240000ms');
  await assert.rejects(
    () =>
      presence.withTyping(OWNER, async () => {
        throw boom;
      }),
    (e) => e === boom, // identity, not shape: a wrapper here would hide the real fault
  );
  await flush();
  assert.deepEqual(calls, [`start ${chatGuidFor(OWNER)}`, `stop ${chatGuidFor(OWNER)}`]);
});

test('🔴 stop can never overtake start, even on an instantaneous turn', async () => {
  // Both are fire-and-forget. Issued unordered, they can land either way round
  // at the server — and the losing order leaves the indicator ON with nothing
  // left to turn it off.
  const order: string[] = [];
  let releaseStart = (): void => {};
  const impl: PresenceCapableClient = {
    startTyping: async () => {
      await new Promise<void>((r) => {
        releaseStart = r;
      });
      order.push('start');
      return { ok: true, status: 200, helperAbsent: false, detail: '' };
    },
    stopTyping: async () => {
      order.push('stop');
      return { ok: true, status: 200, helperAbsent: false, detail: '' };
    },
    markChatRead: async () => ({ ok: true, status: 200, helperAbsent: false, detail: '' }),
  };
  const presence = new Presence({ client: impl, log: () => {} });
  await presence.withTyping(OWNER, async () => 'instant');
  await flush();
  // The turn is over and `stopTyping` is already queued, but `startTyping` has
  // not come back yet — so nothing has been sent in either direction.
  assert.deepEqual(order, [], 'start has not been allowed to finish yet');
  releaseStart();
  await flush();
  assert.deepEqual(order, ['start', 'stop']);
});

test('🔴 two concurrent turns from one sender share ONE indicator, stopped by the LAST', async () => {
  // The receiver kicks off `void ingest(...)` per webhook POST, so a person who
  // sends two lines in a row has two turns running at once.
  const { impl, calls } = stubClient();
  const presence = new Presence({ client: impl, log: () => {} });
  let finishFirst = (): void => {};
  const first = presence.withTyping(OWNER, () => new Promise<string>((r) => (finishFirst = () => r('a'))));
  const second = presence.withTyping(OWNER, async () => 'b');
  await second;
  await flush();
  assert.deepEqual(calls, [`start ${chatGuidFor(OWNER)}`], 'the first turn is still thinking');
  finishFirst();
  await first;
  await flush();
  assert.deepEqual(calls, [`start ${chatGuidFor(OWNER)}`, `stop ${chatGuidFor(OWNER)}`]);
});

test('the indicator is refreshed while a long turn runs, and refreshes stop when it does', async () => {
  const { impl, calls } = stubClient();
  const clock = fakeTimers();
  const presence = new Presence({
    client: impl,
    log: () => {},
    timers: clock.timers,
    now: clock.now,
    refreshMs: 30_000,
  });
  let finish = (): void => {};
  const turn = presence.withTyping(OWNER, () => new Promise<string>((r) => (finish = () => r('ok'))));
  await flush();
  clock.advance(30_000);
  clock.advance(30_000);
  clock.advance(30_000);
  await flush();
  assert.equal(calls.filter((c) => c.startsWith('start')).length, 4, calls.join(', '));

  finish();
  await turn;
  await flush();
  assert.equal(clock.pending(), 0, 'the refresh loop outlived the turn');
  const before = calls.length;
  clock.advance(300_000);
  await flush();
  assert.equal(calls.length, before, 'a cancelled refresh loop still fired');
});

test('🔴 the ceiling stops the indicator even if the turn never ends', async () => {
  // The backstop for a `finally` that never runs because somebody dropped an
  // await. Going quiet is the safe direction; a permanent "…" is not.
  const { impl, calls } = stubClient();
  const clock = fakeTimers();
  const lines: string[] = [];
  const presence = new Presence({
    client: impl,
    log: (l) => lines.push(l),
    timers: clock.timers,
    now: clock.now,
    refreshMs: 30_000,
    ceilingMs: 120_000,
  });
  presence.withTyping(OWNER, () => new Promise<string>(() => {})).catch(() => {});
  await flush();
  for (let i = 0; i < 5; i += 1) clock.advance(30_000);
  await flush();

  assert.ok(calls.includes(`stop ${chatGuidFor(OWNER)}`), calls.join(', '));
  assert.equal(clock.pending(), 0, 'the refresh loop survived the ceiling');
  assert.ok(lines.some((l) => l.includes('ceiling')), lines.join('\n'));
});

test('🔴 shutdown stops a live indicator — a pm2 restart lands mid-turn sooner or later', async () => {
  const { impl, calls } = stubClient();
  const presence = new Presence({ client: impl, log: () => {} });
  presence.withTyping(OWNER, () => new Promise<string>(() => {})).catch(() => {});
  await flush();
  assert.deepEqual(calls, [`start ${chatGuidFor(OWNER)}`]);
  await presence.stopAll();
  assert.deepEqual(calls, [`start ${chatGuidFor(OWNER)}`, `stop ${chatGuidFor(OWNER)}`]);
});

/**
 * ── 🔴 THE SIGTERM PATH HAS NEVER ONCE DONE ITS JOB ───────────────────────────
 *
 * Follows from the inverted-DELETE finding: every SIGTERM this process has ever
 * received *started* indicators instead of clearing them. So this path is not
 * "well covered because it is simple" — it is entirely unexercised, and it runs
 * on EVERY deploy. Each property below is its own test.
 */

test('🔴 SIGTERM stops EVERY live indicator, not just the first', async () => {
  // `stopAll` iterates a map. A break, an early return, or a `find` instead of a
  // loop leaves the second person watching a "…" forever, and with one handle in
  // the test nothing would ever notice.
  const { impl, calls } = stubClient();
  const presence = new Presence({ client: impl, log: () => {} });
  const held: (() => void)[] = [];
  for (const handle of ['+15550001111', '+15550002222', '+15550003333']) {
    void presence.withTyping(handle, () => new Promise<string>((r) => held.push(() => r('ok'))));
  }
  await flush();
  await presence.stopAll();

  for (const handle of ['+15550001111', '+15550002222', '+15550003333']) {
    assert.ok(calls.includes(`stop ${chatGuidFor(handle)}`), `no stop for ${handle}: ${calls.join(', ')}`);
  }
  for (const release of held) release();
});

test('🔴 SIGTERM stops an indicator whose turn is still running', async () => {
  // The whole point. A pm2 restart lands mid-turn sooner or later, and that is
  // the only moment at which there is a live indicator left to strand.
  const { impl, calls } = stubClient();
  const presence = new Presence({ client: impl, log: () => {} });
  let endTurn = (): void => {};
  void presence.withTyping(OWNER, () => new Promise<string>((r) => { endTurn = () => r('ok'); }));
  await flush();
  await presence.stopAll();

  assert.ok(calls.includes(`stop ${chatGuidFor(OWNER)}`), calls.join(', '));
  endTurn();
});

test('🔴 a stop that fails during SIGTERM is LOUD — that is a stranded indicator on a deploy', async () => {
  const { impl, set } = switchableClient();
  const lines: string[] = [];
  const presence = new Presence({ client: impl, log: (l) => lines.push(l) });
  let endTurn = (): void => {};
  void presence.withTyping(OWNER, () => new Promise<string>((r) => { endTurn = () => r('ok'); }));
  await flush();

  set({ stop: SOCKET_STOP_ERROR });
  await presence.stopAll();

  assert.match(lines.join('\n'), /STOP FAILED/, `shutdown swallowed a failed stop:\n${lines.join('\n')}`);
  endTurn();
});

test('🔴 the shipped SIGTERM handler still calls stopAll, and does it BEFORE exiting', async () => {
  // A source scan, because the wiring is what the tests above cannot reach: they
  // prove `stopAll` works, not that anything calls it. Deleting the call, or
  // moving it after `process.exit`, leaves every test above green.
  const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const shutdown = main.slice(main.indexOf('const shutdown ='), main.indexOf("process.on('SIGINT'"));

  assert.ok(shutdown.includes('presence.stopAll()'), 'the SIGTERM handler no longer stops live indicators');
  assert.ok(
    shutdown.indexOf('presence.stopAll()') < shutdown.indexOf('process.exit'),
    'stopAll runs after process.exit — it would never run at all',
  );
  assert.match(main, /process\.on\('SIGTERM'/, 'nothing is listening for SIGTERM');
  // 🔴 SIGINT IS THE ONE THAT MATTERS MOST HERE. `pm2 restart` delivers SIGINT,
  // not SIGTERM — measured in data/jedd.log, which reads `[jedd] SIGINT —
  // deregistering` for the restarts. A deploy is the exact case this path
  // exists for, so losing this listener loses the path in practice while
  // SIGTERM keeps it looking covered.
  assert.match(main, /process\.on\('SIGINT'/, 'nothing is listening for SIGINT — pm2 restart sends THAT');
});

test('stopAll is bounded — an unreachable BlueBubbles cannot stop the process dying', async () => {
  const impl: PresenceCapableClient = {
    startTyping: async () => ({ ok: true, status: 200, helperAbsent: false, detail: '' }),
    stopTyping: () => new Promise(() => {}), // never settles
    markChatRead: async () => ({ ok: true, status: 200, helperAbsent: false, detail: '' }),
  };
  const presence = new Presence({ client: impl, log: () => {} });
  presence.withTyping(OWNER, () => new Promise<string>(() => {})).catch(() => {});
  await flush();
  await presence.stopAll(20); // resolves via the bound, not via the hung call
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE AUDIENCE GATE — a read receipt is visible, and silence must be silent
// ─────────────────────────────────────────────────────────────────────────────

function connectorWith(audience: 'everyone' | string[], presence?: Presence): BlueBubblesConnector {
  return new BlueBubblesConnector(
    null as unknown as BlueBubblesReceiver,
    null as unknown as BlueBubblesClient,
    audience,
    undefined,
    presence,
  );
}

test('🔴 stopAll WAITS for a stop that takes several sequential round trips', async () => {
  // A stop is no longer one request: `client.stopTyping` handshakes, joins and
  // emits, and the emit that actually stops typing is the third leg. A bound
  // that expires before the legs finish exits with the emit in flight, and the
  // "…" is stranded on a real person's phone. Real timers, deliberately — the
  // point is elapsed work, not a clock this test controls.
  let landed = false;
  const impl: PresenceCapableClient = {
    startTyping: async () => ({ ok: true, status: 200, helperAbsent: false, detail: 'http 200' }),
    markChatRead: async () => ({ ok: true, status: 200, helperAbsent: false, detail: 'http 200' }),
    stopTyping: async () => {
      for (let leg = 0; leg < 3; leg += 1) await new Promise((r) => setTimeout(r, 20));
      landed = true;
      return { ok: true, status: 200, helperAbsent: false, detail: 'http 200' };
    },
  };
  const presence = new Presence({ client: impl, log: () => {} });
  // A SIGTERM lands MID-turn — that is the case `stopAll` exists for, and the
  // only one in which there is a live indicator left to strand.
  let endTurn = (): void => {};
  void presence.withTyping(OWNER, () => new Promise<string>((r) => {
    endTurn = () => r('ok');
  }));
  await flush();
  await presence.stopAll();
  endTurn();

  assert.equal(landed, true, 'shutdown returned with the stop still in flight — that strands the indicator');
});

test('🔴 a handle outside JEDD_SEND_TO gets NO read receipt and NO typing bubble', async () => {
  const { impl, calls } = stubClient();
  const presence = new Presence({ client: impl, log: () => {} });
  const connector = connectorWith(['+15550001111'], presence);

  connector.markRead('+15559998888');
  const reply = await connector.withTyping('+15559998888', async () => 'the turn still ran');
  await flush();

  assert.equal(reply, 'the turn still ran');
  assert.deepEqual(calls, [], 'a suppressed handle saw "Read" and a typing bubble, then silence');
});

test('CONTROL: a handle INSIDE the audience gets both', async () => {
  const { impl, calls } = stubClient();
  const presence = new Presence({ client: impl, log: () => {} });
  const connector = connectorWith([OWNER], presence);

  connector.markRead(OWNER);
  await connector.withTyping(OWNER, async () => 'ok');
  await flush();

  assert.deepEqual(calls, [`read ${chatGuidFor(OWNER)}`, `start ${chatGuidFor(OWNER)}`, `stop ${chatGuidFor(OWNER)}`]);
});

test('a connector built with NO Presence still runs the turn', async () => {
  const connector = connectorWith('everyone');
  connector.markRead(OWNER);
  assert.equal(await connector.withTyping(OWNER, async () => 'ok'), 'ok');
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 OBSERVABILITY — a successful signal and a signal that was never sent used
// to look identical in the log. Each property below gets its OWN test: an
// assertion that dies first hides every assertion after it.
// ─────────────────────────────────────────────────────────────────────────────

const turnOf = async (connector: BlueBubblesConnector): Promise<PresenceRecord> => {
  const signals: PresenceRecord = { signalled: [] };
  await withPresence(connector, { senderHandle: OWNER, text: 'hi' }, async () => 'reply', signals);
  await flush();
  return signals;
};

test('🔴 Connector.markRead hands back a boolean, never a promise', async () => {
  // The interface makes this claim explicitly. A promise here would be a thing a
  // caller could await on the reply path, which is the one rule presence.ts
  // exists to enforce — and `withPresence` puts the return value in an `if`,
  // where a promise is always truthy and the mistake is invisible.
  const { impl } = stubClient();
  const connector = connectorWith('everyone', new Presence({ client: impl, log: () => {} }));
  const returned: unknown = connector.markRead(OWNER);
  assert.equal(typeof returned, 'boolean');
  assert.equal(returned instanceof Promise, false);
});

test('🔴 a wired connector records BOTH signals — read and typing', async () => {
  const { impl } = stubClient();
  const record = await turnOf(connectorWith('everyone', new Presence({ client: impl, log: () => {} })));
  assert.equal(presenceToken(record), 'read+typing');
});

test('🔴 CONTROL: a connector built with presence UNDEFINED records none', async () => {
  // This is the mutation the log line has to survive: remove the wiring and the
  // token must change. A token that reads the same either way is decoration.
  const record = await turnOf(connectorWith('everyone'));
  assert.equal(presenceToken(record), 'none');
});

test('🔴 a handle outside the send audience records none, even though presence is wired', async () => {
  const { impl } = stubClient();
  const connector = connectorWith(['+15550001111'], new Presence({ client: impl, log: () => {} }));
  assert.equal(presenceToken(await turnOf(connector)), 'none');
});

test('🔴 the token says ATTEMPTED, not arrived — a failing call still reads read+typing', async () => {
  // Deliberate, and the comments say so. The outcome does not exist yet at the
  // line that prints this: presence runs on a chain nobody awaits, and awaiting
  // it to improve a log line would put presence latency on the reply path. A
  // FAILURE announces itself separately on its own [presence] line, so the pair
  // is unambiguous — this token alone is not, and must not be read as delivery.
  const { impl } = stubClient('helper-absent');
  const record = await turnOf(connectorWith('everyone', new Presence({ client: impl, log: () => {} })));
  assert.equal(presenceToken(record), 'read+typing');
});

test('the turn still returns its reply while nothing is signalled', async () => {
  const connector = connectorWith('everyone');
  const signals: PresenceRecord = { signalled: [] };
  const reply = await withPresence(
    connector,
    { senderHandle: OWNER, text: 'hi' },
    async () => 'the answer',
    signals,
  );
  assert.equal(reply, 'the answer');
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 ON THE ACTUAL TURN PATH — a working Presence nothing calls is worth nothing
// ─────────────────────────────────────────────────────────────────────────────

test('🔴 a message arriving over the real webhook marks read, types, and stops — in that order', async () => {
  // Everything above tests `Presence` in isolation, which cannot tell you
  // whether the turn path reaches it. This drives a REAL `BlueBubblesReceiver`
  // over a REAL HTTP POST, in the payload shape BlueBubbles sends.
  const { impl: presenceStub, calls } = stubClient();
  const presence = new Presence({ client: presenceStub, log: () => {} });

  const seen = { firstSight: () => true, advanceWatermark: () => {}, watermark: () => 5 };
  const receiver = new BlueBubblesReceiver({
    selfIdentity: 'jedd-under-test@example.invalid',
    client: { newestRowid: async () => 5 } as unknown as BlueBubblesClient,
    seen: seen as unknown as ConstructorParameters<typeof BlueBubblesReceiver>[0]['seen'],
    host: '127.0.0.1',
    port: 0,
    path: '/webhook',
    log: () => {},
  });
  const connector = new BlueBubblesConnector(
    receiver,
    null as unknown as BlueBubblesClient,
    [OWNER],
    undefined,
    presence,
  );

  // 🔴 `withPresence` is the function `main.ts` and `index.ts` actually call.
  // Re-typing the two lines here instead would prove the shape is possible, not
  // that the shipped loop does it — and a turn missing its read receipt answers
  // perfectly and reports nothing.
  const order: string[] = [];
  const port = await receiver.start(async (message) => {
    await withPresence(connector, message, async () => {
      order.push(`turn:${message.text}`);
    });
  });

  await fetch(`http://127.0.0.1:${port}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'new-message',
      data: {
        originalROWID: 2602,
        guid: 'p:0/ABC',
        text: 'is dune downloaded yet',
        isFromMe: false,
        handle: { address: OWNER, service: 'iMessage' },
        chats: [{ chatIdentifier: OWNER, originalROWID: 1 }],
      },
    }),
  });
  await flush();
  await flush();
  await receiver.stop();

  assert.deepEqual(order, ['turn:is dune downloaded yet'], 'the turn never ran');
  assert.deepEqual(calls, [
    `read ${chatGuidFor(OWNER)}`,
    `start ${chatGuidFor(OWNER)}`,
    `stop ${chatGuidFor(OWNER)}`,
  ]);
});

test('🔴 ShadowConnector cannot signal presence, and holds nothing that could', async () => {
  // A shadow is supposed to be invisible. A read receipt is the one outward
  // sign it could produce, appearing beside V1's real replies.
  const shadow = new ShadowConnector(null as unknown as BlueBubblesReceiver);
  shadow.markRead(OWNER);
  assert.equal(await shadow.withTyping(OWNER, async () => 'ok'), 'ok');
  assert.equal(
    Object.values(shadow).filter((v) => v && typeof v === 'object' && 'startTyping' in v).length,
    0,
    'the shadow is holding something that can type',
  );
});

// ── 🔴 the ceiling is DERIVED, not retyped (2026-08-26, Jeff's instruction) ──

test('🔴 the typing ceiling is derived from the turn budget, not a magic number', () => {
  // Jeff: "Let's keep the typing indicator going until we fully time out."
  //
  // It was a flat 360_000 beside a 900_000 turn budget it had no relationship
  // to, and they drifted: the indicator died at 6 minutes on a turn that ran
  // 787s and completed fine.
  assert.equal(CEILING_MS, TURN_TIMEOUT_MS * MAX_STEPS);
});

test('🔴 the ceiling covers a turn that uses EVERY step at the full per-call budget', () => {
  // TURN_TIMEOUT_MS is per model CALL. A turn makes up to MAX_STEPS of them —
  // the 787s turn used all 8 — so a ceiling equal to the per-call budget would
  // cut a slow multi-step turn off early and reproduce the same complaint.
  assert.ok(CEILING_MS >= TURN_TIMEOUT_MS * MAX_STEPS, 'must cover the worst-case turn, not one call');
  assert.ok(CEILING_MS > 787_000, 'must cover the real turn that triggered this change');
});

test('🔴 the refresh loop keeps re-arming right up to the ceiling', async () => {
  // Raising the number is only sufficient if nothing ELSE disarms first.
  // `arm()` re-arms every refreshMs and its only exits are `stopped` — set
  // solely by `finish()` — and the ceiling test itself. This walks a turn well
  // past the OLD 360s ceiling and asserts the indicator is still being kept
  // alive, which is the behaviour Jeff asked for.
  const { impl, calls } = stubClient();
  const clock = fakeTimers();
  const presence = new Presence({
    client: impl,
    log: () => {},
    timers: clock.timers,
    now: clock.now,
    refreshMs: 30_000,
    ceilingMs: CEILING_MS,
  });
  presence.withTyping(OWNER, () => new Promise<string>(() => {})).catch(() => {});
  await flush();

  // 787s is the real turn that triggered this change; walk past it to 900s.
  for (let i = 0; i < 30; i += 1) clock.advance(30_000);
  await flush();

  assert.ok(
    !calls.includes(`stop ${chatGuidFor(OWNER)}`),
    'the indicator must still be alive 900s in — the old 360s ceiling killed it at 6 minutes',
  );
  assert.ok(clock.pending() > 0, 'the refresh loop must still be armed');
  const starts = calls.filter((c) => c === `start ${chatGuidFor(OWNER)}`).length;
  assert.ok(starts >= 30, `expected continuous refreshes, saw ${starts}`);
});
