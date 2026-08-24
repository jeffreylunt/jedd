import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BlueBubblesClient, type FetchImpl } from '../src/bluebubbles/client.js';

/**
 * The BlueBubbles HTTP surface, tested against a scripted fetch.
 *
 * The seam is a `FetchImpl` rather than a mocked global so a test can assert on
 * the exact REQUEST that would have gone out — including that a refused
 * operation produced no request at all. A guard that still made the call is the
 * failure mode this seam exists to detect, and it is not visible in a return
 * value.
 */

interface Call {
  url: string;
  method: string;
  body: unknown;
  hasSignal: boolean;
}

function scripted(routes: (c: Call) => { status?: number; body: unknown } | undefined) {
  const calls: Call[] = [];
  const impl: FetchImpl = async (url, init) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      hasSignal: Boolean(init?.signal),
    };
    calls.push(call);
    const r = routes(call);
    if (!r) throw new Error(`unscripted request: ${call.method} ${call.url}`);
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    } as Response;
  };
  return { impl, calls };
}

function client(impl: FetchImpl, expectedIdentity?: string) {
  return new BlueBubblesClient({
    baseUrl: 'http://bb.invalid:1234',
    password: 'pw',
    expectedIdentity,
    fetchImpl: impl,
  });
}

// ── 🔴 the two-servers trap ──────────────────────────────────────────────────

test('🔴 boot REFUSES when the server is the wrong Apple account', async () => {
  // :1234 is Jedd (jeffreylunt@outlook.com); :1235 is Jeff's PERSONAL account,
  // used to read 2FA codes. Both use the literal default password and the same
  // API shape, so a .env typo connects SUCCESSFULLY to the wrong identity.
  const { impl } = scripted(() => ({
    body: { data: { detected_imessage: 'jeffreylunt@gmail.com', server_version: '1.9.9' } },
  }));
  await assert.rejects(
    () => client(impl, 'jeffreylunt@outlook.com').assertIdentity(),
    /jeffreylunt@gmail\.com|wrong|identity/i,
  );
});

test('boot accepts the expected identity', async () => {
  const { impl } = scripted(() => ({
    body: { data: { detected_imessage: 'jeffreylunt@outlook.com', server_version: '1.9.9' } },
  }));
  const info = await client(impl, 'jeffreylunt@outlook.com').assertIdentity();
  assert.equal(info.detectedIMessage, 'jeffreylunt@outlook.com');
});

test('an unreadable server/info is UNKNOWN and still refuses — it is not "probably fine"', async () => {
  const { impl } = scripted(() => ({ status: 500, body: { message: 'boom' } }));
  // Assert the REASON, not merely that it threw. A mutation survived this test
  // when it only checked `rejects`: with the unreadable-check removed, the empty
  // identity still failed the equality test, so the suite stayed green while the
  // UNKNOWN guard was gone. A refusal for the wrong reason is not a passing test.
  await assert.rejects(
    () => client(impl, 'jeffreylunt@outlook.com').assertIdentity(),
    /could not read|unknown/i,
  );
});

test('🔴 an unreadable server/info refuses even with NO expected identity configured', async () => {
  // `expectedIdentity` is optional, so this is the path where the equality check
  // cannot stand in for the unreadable check. Without it, a server that answers
  // nothing at all reads as a successful boot.
  const { impl } = scripted(() => ({ status: 500, body: { message: 'boom' } }));
  await assert.rejects(() => client(impl).assertIdentity(), /could not read|unknown/i);
});

// ── 🔴 webhook registration must UPDATE, never orphan ────────────────────────

test('🔴 registration updates the existing row instead of adding a second', async () => {
  // V1 dedups by exact URL string, so when the URL changed it accumulated an
  // ORPHAN pointing at an unreachable loopback address and nothing failed
  // loudly — BB delivered into a black hole for a whole version.
  const { impl, calls } = scripted((c) => {
    if (c.method === 'GET') {
      return { body: { data: [{ id: 5, url: 'http://old.invalid/webhook', events: ['new-message'] }] } };
    }
    if (c.method === 'DELETE') return { body: { message: 'deleted' } };
    return { body: { data: { id: 9, url: 'http://new.invalid/webhook', events: ['new-message'] } } };
  });
  await client(impl).ensureWebhook('http://new.invalid/webhook', ['new-message']);
  assert.ok(
    calls.some((c) => c.method === 'DELETE' && c.url.includes('/webhook/5')),
    'the stale row must be removed, not left as an orphan',
  );
  assert.ok(calls.some((c) => c.method === 'POST'), 'and the new one registered');
});

test('🔴 registering V2 does NOT delete V1 — a different port is somebody else\'s row', async () => {
  // The live server carries both of these today. The staleness rule matched on
  // PATHNAME, and everybody calls it /webhook — so V2 starting up would have
  // deleted V1's registration and taken the live Jedd off the air, silently,
  // while believing it was tidying up after itself.
  const { impl, calls } = scripted((c) => {
    if (c.method === 'GET') {
      return {
        body: {
          data: [
            { id: 5, url: 'http://192.168.1.7:18790/webhook', events: ['new-message'] },
            { id: 9, url: 'http://127.0.0.1:18795/webhook', events: ['*'] },
          ],
        },
      };
    }
    if (c.method === 'DELETE') return { body: { message: 'deleted' } };
    return { body: { data: { id: 11, url: 'http://127.0.0.1:18796/webhook', events: ['new-message'] } } };
  });
  const res = await client(impl).ensureWebhook('http://127.0.0.1:18796/webhook', ['new-message']);
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0, 'nothing of anyone else\'s may be deleted');
  assert.deepEqual(res.removed, []);
  assert.equal(res.outcome, 'created');
});

test('🔴 the original orphan is still fixed — a HOST change on our own port is ours', async () => {
  // The measured V1 incident: 127.0.0.1:18790 -> 192.168.1.7:18790. Same port,
  // same path, and the old row delivered into a black hole for a whole version.
  const { impl, calls } = scripted((c) => {
    if (c.method === 'GET') {
      return { body: { data: [{ id: 5, url: 'http://127.0.0.1:18790/webhook', events: ['new-message'] }] } };
    }
    if (c.method === 'DELETE') return { body: { message: 'deleted' } };
    return { body: { data: { id: 6 } } };
  });
  const res = await client(impl).ensureWebhook('http://192.168.1.7:18790/webhook', ['new-message']);
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.url.includes('/webhook/5')));
  assert.deepEqual(res.removed, [{ id: 5, url: 'http://127.0.0.1:18790/webhook' }]);
});

test('a removal is REPORTED, so it cannot happen without a log line', async () => {
  const { impl } = scripted((c) => {
    if (c.method === 'GET') {
      return { body: { data: [{ id: 5, url: 'http://old.invalid/webhook', events: ['new-message'] }] } };
    }
    if (c.method === 'DELETE') return { body: { message: 'deleted' } };
    return { body: { data: { id: 9 } } };
  });
  const res = await client(impl).ensureWebhook('http://new.invalid/webhook', ['new-message']);
  assert.equal(res.removed.length, 1, 'an unreported removal is the orphan bug with the opposite sign');
});

test('deleteWebhook takes an ID, because taking Jedd off the air is never a side effect', async () => {
  const { impl, calls } = scripted(() => ({ body: { message: 'deleted' } }));
  const res = await client(impl).deleteWebhook(5);
  assert.equal(res.ok, true);
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.url.includes('/webhook/5')));
});

test('registration is a no-op when the exact url is already registered', async () => {
  const { impl, calls } = scripted((c) => {
    if (c.method === 'GET') {
      return { body: { data: [{ id: 5, url: 'http://same.invalid/webhook', events: ['new-message'] }] } };
    }
    return { body: {} };
  });
  await client(impl).ensureWebhook('http://same.invalid/webhook', ['new-message']);
  assert.equal(calls.filter((c) => c.method !== 'GET').length, 0, 'nothing should be created or deleted');
});

// ── 🔴 replay must page to the watermark ─────────────────────────────────────

test('🔴 replay pages PAST 50 messages to reach the watermark', async () => {
  // V1 queries limit:50 with no pagination, so anything older during a long
  // outage is lost permanently and silently.
  const all = Array.from({ length: 130 }, (_, i) => ({
    originalROWID: 2000 - i, // DESC, newest first
    guid: `g${2000 - i}`,
    text: 'hi',
    isFromMe: false,
    handle: { address: '+1555' },
  }));
  const { impl, calls } = scripted((c) => {
    const offset = (c.body as { offset?: number })?.offset ?? 0;
    const limit = (c.body as { limit?: number })?.limit ?? 50;
    return { body: { data: all.slice(offset, offset + limit) } };
  });
  const res = await client(impl).replaySince(1900);
  assert.equal(res.saturated, false);
  assert.equal(res.messages.length, 100, 'rowids 1901..2000 inclusive');
  assert.equal(res.messages[0]?.originalROWID, 1901, 'oldest first, so they replay in order');
  assert.ok(calls.length > 1, 'must have paged more than once');
});

test('🔴 replay SAYS SO when it cannot reach the watermark, rather than pretending to be complete', async () => {
  // A FULL page every time, all newer than the watermark, so the walk can never
  // terminate. It must be a full page: a short page legitimately means the end
  // of history, which is a complete replay rather than a truncated one.
  const { impl } = scripted((c) => {
    const offset = (c.body as { offset?: number })?.offset ?? 0;
    return {
      body: {
        data: Array.from({ length: 100 }, (_, i) => ({
          originalROWID: 500_000 - offset - i,
          guid: `g${500_000 - offset - i}`,
          text: 'hi',
          isFromMe: false,
          handle: { address: '+1555' },
        })),
      },
    };
  });
  const res = await client(impl).replaySince(1);
  assert.equal(res.saturated, true, 'a truncated replay must announce its truncation');
});

// ── 🔴 outbound: 200 is not delivered ────────────────────────────────────────

test('🔴 a 200 from /message/text does NOT mean delivered', async () => {
  const { impl } = scripted(() => ({ body: { data: { guid: 'SENT-1' } } }));
  const r = await client(impl).sendText('+18015550123', 'hello');
  assert.equal(r.accepted, true);
  assert.equal(r.delivery, 'unknown', '200 means "no error at send time", nothing more');
});

test('🔴 a nonzero error code is a delivery FAILURE that already happened', async () => {
  const { impl } = scripted((c) =>
    c.url.includes('/message/text')
      ? { status: 500, body: { message: 'Message sent with an error. See attached message' } }
      : { body: {} },
  );
  const r = await client(impl).sendText('+18015550123', 'hello');
  assert.equal(r.accepted, false);
  assert.equal(r.delivery, 'failed');
});

test('delivery verdict is three-state and reads isDelivered / error', async () => {
  const mk = (data: unknown) => {
    const { impl } = scripted(() => ({ body: { data } }));
    return client(impl);
  };
  assert.equal(await mk({ isDelivered: true, error: 0 }).deliveryVerdict('g'), 'delivered');
  assert.equal(await mk({ isDelivered: false, error: 22 }).deliveryVerdict('g'), 'failed');
  assert.equal(await mk({ isDelivered: false, error: 0 }).deliveryVerdict('g'), 'unknown');
});

// ── every request is bounded ─────────────────────────────────────────────────

test('🔴 every outbound request carries a timeout', async () => {
  // V1's postText has NO timeout at all, so a hung BB blocks it forever. The
  // attachment endpoint is the proven case: >90s with no response at all.
  const { impl, calls } = scripted(() => ({ body: { data: { guid: 'g' } } }));
  const c = client(impl);
  await c.sendText('+1555', 'hi');
  await c.listWebhooks();
  assert.ok(calls.length >= 2);
  for (const call of calls) assert.equal(call.hasSignal, true, `${call.url} had no AbortSignal`);
});

test('the password is sent as a query param and never in the body', async () => {
  const { impl, calls } = scripted(() => ({ body: { data: { guid: 'g' } } }));
  await client(impl).sendText('+1555', 'hi');
  assert.match(calls[0]!.url, /password=pw/);
  assert.ok(!JSON.stringify(calls[0]!.body).includes('pw'));
});

// ── markdown does not render in iMessage ─────────────────────────────────────

test('markdown is stripped before sending, because iMessage has no renderer', async () => {
  const { impl, calls } = scripted(() => ({ body: { data: { guid: 'g' } } }));
  await client(impl).sendText('+1555', '**Dune** is ready. See `logs` or [here](https://x.invalid/a)');
  const sent = (calls[0]!.body as { message: string }).message;
  assert.equal(sent, 'Dune is ready. See logs or here (https://x.invalid/a)');
});

test('🔴 stripping does NOT mangle ordinary titles and filenames', async () => {
  // This runs on every outbound message, so an over-eager rule corrupts real
  // text. Stripping is cosmetic; mangling a title is a correctness bug.
  const { impl, calls } = scripted(() => ({ body: { data: { guid: 'g' } } }));
  const awkward = '*batteries not included (1987) is in some_file_name.mkv — 2*3 is 6';
  await client(impl).sendText('+1555', awkward);
  assert.equal((calls[0]!.body as { message: string }).message, awkward);
});
