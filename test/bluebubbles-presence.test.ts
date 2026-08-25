import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BlueBubblesClient, chatGuidFor, type FetchImpl } from '../src/bluebubbles/client.js';
import { Presence, type PresenceCapableClient, type TimerSeam } from '../src/bluebubbles/presence.js';
import { BlueBubblesConnector, BlueBubblesReceiver, ShadowConnector } from '../src/bluebubbles/receiver.js';
import { withPresence } from '../src/connector.js';

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
}

function scripted(reply: (c: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const impl: FetchImpl = async (url, init) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      hasSignal: Boolean(init?.signal),
    };
    calls.push(call);
    const r = reply(call);
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      json: async () => r.body,
    } as Response;
  };
  return { impl, calls };
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

test('startTyping POSTs to the chat typing route, stopTyping DELETEs the same one', async () => {
  const { impl, calls } = scripted(() => ({ body: { status: 200, message: 'Success' } }));
  const c = client(impl);
  await c.startTyping(chatGuidFor(OWNER));
  await c.stopTyping(chatGuidFor(OWNER));

  const path = '/api/v1/chat/iMessage%3B-%3B%2B18015550123/typing';
  assert.equal(calls[0]?.method, 'POST');
  assert.ok(calls[0]?.url.startsWith(`http://bb.invalid:1234${path}?`), calls[0]?.url);
  assert.equal(calls[1]?.method, 'DELETE');
  assert.ok(calls[1]?.url.startsWith(`http://bb.invalid:1234${path}?`), calls[1]?.url);
  // Start and stop must address the SAME conversation; a mismatch is a stuck
  // indicator on one thread and a silent one on another.
  assert.equal(calls[0]?.url, calls[1]?.url);
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
  const { impl, calls } = scripted((c) =>
    c.url.includes('/message/text')
      ? { body: { status: 200, data: { guid: 'sent-1' } } }
      : { status: 500, body: HELPER_ABSENT_BODY },
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
  // Every presence call failed, and the only thing said about it was one notice.
  assert.equal(lines.length, 1, `expected one notice, got:\n${lines.join('\n')}`);
  assert.match(lines[0] ?? '', /once per process/);
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
