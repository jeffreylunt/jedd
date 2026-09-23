import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BlueBubblesClient, canonicalPhone, chatGuidFor, type FetchImpl } from '../src/bluebubbles/client.js';

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
  // :1234 is Jedd (personone@example.com); :1235 is Jeff's PERSONAL account,
  // used to read 2FA codes. Both use the literal default password and the same
  // API shape, so a .env typo connects SUCCESSFULLY to the wrong identity.
  const { impl } = scripted(() => ({
    body: { data: { detected_imessage: 'persontwo@example.com', server_version: '1.9.9' } },
  }));
  await assert.rejects(
    () => client(impl, 'personone@example.com').assertIdentity(),
    /persontwo@example\.com|wrong|identity/i,
  );
});

test('boot accepts the expected identity', async () => {
  const { impl } = scripted(() => ({
    body: { data: { detected_imessage: 'personone@example.com', server_version: '1.9.9' } },
  }));
  const info = await client(impl, 'personone@example.com').assertIdentity();
  assert.equal(info.detectedIMessage, 'personone@example.com');
});

test('an unreadable server/info is UNKNOWN and still refuses — it is not "probably fine"', async () => {
  const { impl } = scripted(() => ({ status: 500, body: { message: 'boom' } }));
  // Assert the REASON, not merely that it threw. A mutation survived this test
  // when it only checked `rejects`: with the unreadable-check removed, the empty
  // identity still failed the equality test, so the suite stayed green while the
  // UNKNOWN guard was gone. A refusal for the wrong reason is not a passing test.
  await assert.rejects(
    () => client(impl, 'personone@example.com').assertIdentity(),
    /could not read|unknown/i,
  );
});

test('🔴 NO CONFIGURED IDENTITY IS A REFUSAL — an unset expectation must not pass', async () => {
  // Found 2026-08-26 while removing the owner's Apple ID from source. The check
  // read `if (want && ...)`, so an absent value SKIPPED it — invisible for as
  // long as a hardcoded default stood in for the config. Deleting that default
  // without this guard would have turned "his name is not in the tree" into
  // "Jedd will happily text from whichever account answers".
  const { impl } = scripted(() => ({
    body: { status: 200, data: { detected_imessage: 'someone.else@invalid', server_version: '1.9.9' } },
  }));
  await assert.rejects(() => client(impl).assertIdentity(), /NO EXPECTED IMESSAGE IDENTITY/);
});

test('CONTROL: a MATCHING configured identity still boots', async () => {
  const { impl } = scripted(() => ({
    body: { status: 200, data: { detected_imessage: 'jedd@invalid', server_version: '1.9.9' } },
  }));
  const info = await client(impl, 'jedd@invalid').assertIdentity();
  assert.equal(info.detectedIMessage, 'jedd@invalid');
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
            { id: 5, url: 'http://10.0.0.10:18790/webhook', events: ['new-message'] },
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
  // The measured V1 incident: 127.0.0.1:18790 -> 10.0.0.10:18790. Same port,
  // same path, and the old row delivered into a black hole for a whole version.
  const { impl, calls } = scripted((c) => {
    if (c.method === 'GET') {
      return { body: { data: [{ id: 5, url: 'http://127.0.0.1:18790/webhook', events: ['new-message'] }] } };
    }
    if (c.method === 'DELETE') return { body: { message: 'deleted' } };
    return { body: { data: { id: 6 } } };
  });
  const res = await client(impl).ensureWebhook('http://10.0.0.10:18790/webhook', ['new-message']);
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
  const textCall = calls.find((c) => String(c.url).includes('/message/text'));
  assert.ok(textCall, 'expected a /message/text call');
  const sent = (textCall.body as { message: string }).message;
  assert.equal(sent, 'Dune is ready. See logs or here (https://x.invalid/a)');
});

test('🔴 stripping does NOT mangle ordinary titles and filenames', async () => {
  // This runs on every outbound message, so an over-eager rule corrupts real
  // text. Stripping is cosmetic; mangling a title is a correctness bug.
  const { impl, calls } = scripted(() => ({ body: { data: { guid: 'g' } } }));
  const awkward = '*batteries not included (1987) is in some_file_name.mkv — 2*3 is 6';
  await client(impl).sendText('+1555', awkward);
  const textCall = calls.find((c) => String(c.url).includes('/message/text'));
  assert.ok(textCall, 'expected a /message/text call');
  assert.equal((textCall.body as { message: string }).message, awkward);
});

// ── live thread resolution ────────────────────────────────────────────────────

function chatQueryReply(chats: unknown[], total = chats.length) {
  return { status: 200, data: chats, metadata: { total, count: chats.length, limit: 100 } };
}

test('resolveChatGuid reads the live thread guid from /chat/query', async () => {
  const handle = '+18015550123';
  const { impl, calls } = scripted((call) => {
    if (String(call.url).includes('/chat/query')) {
      return {
        body: chatQueryReply([
          { guid: `any;-;${handle}`, chatIdentifier: handle, participants: [{ address: handle }] },
        ]),
      };
    }
    return { body: { status: 200, data: { guid: 'sent' } } };
  });

  const guid = await client(impl).resolveChatGuid(handle);

  assert.equal(guid, `any;-;${handle}`);
  assert.ok(calls.some((call) => String(call.url).includes('/chat/query')), 'expected a /chat/query call');
});

test('sendText addresses the live thread guid, not the constructed iMessage guid', async () => {
  const handle = '+18015550123';
  const { impl, calls } = scripted((call) => {
    if (String(call.url).includes('/chat/query')) {
      return {
        body: chatQueryReply([
          { guid: `any;-;${handle}`, chatIdentifier: handle, participants: [{ address: handle }] },
        ]),
      };
    }
    return { body: { status: 200, data: { guid: 'sent' } } };
  });

  const result = await client(impl).sendText(handle, 'hello');

  assert.equal(result.accepted, true);
  const textCall = calls.find((call) => String(call.url).includes('/message/text'));
  assert.ok(textCall, 'expected a /message/text call');
  assert.equal((textCall.body as { chatGuid: string }).chatGuid, `any;-;${handle}`);
  assert.ok(calls.some((call) => String(call.url).includes('/chat/query')), 'send should resolve the live guid');
});

test('resolveChatGuid falls back to a participant match when chatIdentifier is absent', async () => {
  const handle = '+15551234567';
  const { impl } = scripted((call) => {
    if (String(call.url).includes('/chat/query')) {
      return { body: chatQueryReply([{ guid: `any;-;${handle}`, participants: [{ address: handle }] }]) };
    }
    return { body: { status: 200, data: { guid: 'sent' } } };
  });

  assert.equal(await client(impl).resolveChatGuid(handle), `any;-;${handle}`);
});

test('an exact chatIdentifier match wins over a participant match', async () => {
  const handle = '+15551234567';
  const { impl } = scripted((call) => {
    if (String(call.url).includes('/chat/query')) {
      return {
        body: chatQueryReply([
          { guid: 'any;-;participant-only', participants: [{ address: handle }] },
          { guid: `any;-;${handle}`, chatIdentifier: handle },
        ]),
      };
    }
    return { body: { status: 200, data: { guid: 'sent' } } };
  });

  assert.equal(await client(impl).resolveChatGuid(handle), `any;-;${handle}`);
});

// ── typed-form canonicalization ─────────────────────────────────────────────
// A person types a number the way they wrote it — "(801) 555-4271" — while the
// thread the server stored is +180****4271. 2026-09-22: the exact-match lookup
// found nothing, fell back to a constructed guid, and the invite send 500'd.

test('canonicalPhone maps the stored and the typed forms of one US number', () => {
  assert.equal(canonicalPhone('(801) 555-4271'), '+18015554271');
  assert.equal(canonicalPhone('801 555 4271'), '+18015554271');
  assert.equal(canonicalPhone('8015554271'), '+18015554271');
  assert.equal(canonicalPhone('+18015554271'), '+18015554271');
  // Ambiguity and non-phones: never guess.
  assert.equal(canonicalPhone('18015554271'), null); // 11 bare digits
  assert.equal(canonicalPhone('+33612345678'), null); // non-US
  assert.equal(canonicalPhone('jeff'), null);
});

test('resolveChatGuid finds a +1-stored thread from a typed (801) 555-4271', async () => {
  const typed = '(801) 555-4271';
  const stored = '+18015554271';
  const { impl } = scripted((call) => {
    if (String(call.url).includes('/chat/query')) {
      return {
        body: chatQueryReply([
          { guid: `any;-;${stored}`, chatIdentifier: stored, participants: [{ address: stored }] },
        ]),
      };
    }
    return { body: { status: 200, data: { guid: 'sent' } } };
  });

  const guid = await client(impl).resolveChatGuid(typed);
  assert.equal(guid, `any;-;${stored}`);
});

test('resolveChatGuid matches a +1 participant when the thread has no chatIdentifier', async () => {
  const typed = '8015554271';
  const stored = '+18015554271';
  const { impl } = scripted((call) => {
    if (String(call.url).includes('/chat/query')) {
      return { body: chatQueryReply([{ guid: `any;-;${stored}`, participants: [{ address: stored }] }]) };
    }
    return { body: { status: 200, data: { guid: 'sent' } } };
  });

  assert.equal(await client(impl).resolveChatGuid(typed), `any;-;${stored}`);
});

test('the send is addressed to the resolved thread, not the typed string', async () => {
  const typed = '(801) 555-4271';
  const stored = '+18015554271';
  const { impl, calls } = scripted((call) => {
    if (String(call.url).includes('/chat/query')) {
      return {
        body: chatQueryReply([
          { guid: `any;-;${stored}`, chatIdentifier: stored, participants: [{ address: stored }] },
        ]),
      };
    }
    return { body: { status: 200, data: { guid: 'sent' } } };
  });

  await client(impl).sendText(typed, 'hi');
  const textCall = calls.find((c) => String(c.url).includes('/message/text'));
  assert.ok(textCall, 'expected a /message/text call');
  assert.equal((textCall.body as { chatGuid: string }).chatGuid, `any;-;${stored}`);
});

test('🔴 a refused /chat/query falls back to the old guid and the send still proceeds', async () => {
  const handle = '+15551234567';
  const { impl, calls } = scripted((call) => {
    if (String(call.url).includes('/chat/query')) return { status: 500, body: { status: 500, message: 'boom' } };
    return { body: { status: 200, data: { guid: 'sent' } } };
  });
  const c = client(impl);

  assert.equal(await c.resolveChatGuid(handle), chatGuidFor(handle));
  const result = await c.sendText(handle, 'hello');

  assert.equal(result.accepted, true);
  const textCall = calls.find((call) => String(call.url).includes('/message/text'));
  assert.ok(textCall, 'expected a /message/text call');
  assert.equal((textCall.body as { chatGuid: string }).chatGuid, chatGuidFor(handle));
  assert.equal(calls.filter((call) => String(call.url).includes('/chat/query')).length, 1);
});

test('🔴 a transport failure in /chat/query falls back and never breaks the send', async () => {
  const handle = '+15551234567';
  const { impl, calls } = scripted((call) => {
    if (String(call.url).includes('/chat/query')) throw new Error('ECONNREFUSED 127.0.0.1:1234');
    return { body: { status: 200, data: { guid: 'sent' } } };
  });
  const c = client(impl);

  assert.equal(await c.resolveChatGuid(handle), chatGuidFor(handle));
  const result = await c.sendText(handle, 'hello');

  assert.equal(result.accepted, true);
  const textCall = calls.find((call) => String(call.url).includes('/message/text'));
  assert.ok(textCall, 'expected a /message/text call');
  assert.equal((textCall.body as { chatGuid: string }).chatGuid, chatGuidFor(handle));
});

test('a resolved guid is cached, so a second send does not re-query the chat list', async () => {
  const handle = '+18015550123';
  const { impl, calls } = scripted((call) => {
    if (String(call.url).includes('/chat/query')) {
      return {
        body: chatQueryReply([
          { guid: `any;-;${handle}`, chatIdentifier: handle, participants: [{ address: handle }] },
        ]),
      };
    }
    return { body: { status: 200, data: { guid: 'sent' } } };
  });
  const c = client(impl);

  await c.sendText(handle, 'one');
  await c.sendText(handle, 'two');

  assert.equal(calls.filter((call) => String(call.url).includes('/chat/query')).length, 1);
  assert.equal(calls.filter((call) => String(call.url).includes('/message/text')).length, 2);
});

test('🔴 a miss is cached briefly, so an empty chat list is not re-queried on every send', async () => {
  const handle = '+15551234567';
  const { impl, calls } = scripted((call) => {
    if (String(call.url).includes('/chat/query')) return { body: chatQueryReply([]) };
    return { body: { status: 200, data: { guid: 'sent' } } };
  });
  const c = client(impl);

  await c.sendText(handle, 'one');
  await c.sendText(handle, 'two');

  const queryCalls = calls.filter((call) => String(call.url).includes('/chat/query'));
  const textCalls = calls.filter((call) => String(call.url).includes('/message/text'));
  assert.equal(queryCalls.length, 1);
  assert.equal(textCalls.length, 2);
  for (const call of textCalls) {
    assert.equal((call.body as { chatGuid: string }).chatGuid, chatGuidFor(handle));
  }
});

/**
 * A clock-injected client. `client()` cannot express what follows: the hit and
 * miss guid TTLs differ by 25 minutes, and a test that asks its second question
 * immediately reads the two as one value — which is how collapsing them
 * SURVIVED a mutation sweep on 2026-09-17.
 */
function clientAt(impl: FetchImpl, nowImpl: () => number) {
  return new BlueBubblesClient({
    baseUrl: 'http://bb.invalid:1234',
    password: 'pw',
    fetchImpl: impl,
    nowImpl,
  });
}

test('🔴 a cached MISS is re-checked on its OWN short TTL — the thread can appear later', async () => {
  const handle = '+15551234567';
  let threadExists = false;
  const { impl, calls } = scripted((call) => {
    if (String(call.url).includes('/chat/query')) {
      return {
        body: chatQueryReply(
          threadExists
            ? [{ guid: `any;-;${handle}`, chatIdentifier: handle, participants: [{ address: handle }] }]
            : [],
        ),
      };
    }
    return { body: { status: 200, data: { guid: 'sent' } } };
  });
  let clock = 0;
  const c = clientAt(impl, () => clock);

  // No thread yet: the fallback, remembered.
  assert.equal(await c.resolveChatGuid(handle), chatGuidFor(handle));
  assert.equal(calls.length, 1);

  // The thread now exists, but four minutes in the miss is still warm.
  threadExists = true;
  clock = 4 * 60_000;
  assert.equal(await c.resolveChatGuid(handle), chatGuidFor(handle));
  assert.equal(calls.length, 1);

  // Six minutes in the miss has expired, and the thread that appeared is found.
  // Under the HIT ttl this would stay on the fallback for another 24 minutes —
  // every reply in that window landing in a thread that does not exist.
  clock = 6 * 60_000;
  assert.equal(await c.resolveChatGuid(handle), `any;-;${handle}`);
  assert.equal(calls.length, 2);
});

test('CONTROL: a cached HIT holds past the miss TTL, and is re-read after its own', async () => {
  const handle = '+15551234567';
  const { impl, calls } = scripted((call) => {
    if (String(call.url).includes('/chat/query')) {
      return {
        body: chatQueryReply([
          { guid: `any;-;${handle}`, chatIdentifier: handle, participants: [{ address: handle }] },
        ]),
      };
    }
    return { body: { status: 200, data: { guid: 'sent' } } };
  });
  let clock = 0;
  const c = clientAt(impl, () => clock);

  assert.equal(await c.resolveChatGuid(handle), `any;-;${handle}`);
  assert.equal(calls.length, 1);

  // Six minutes: past the MISS ttl, and a hit must not be re-queried there —
  // this is the half that proves the two TTLs are genuinely different values
  // rather than one value the test above happens to agree with.
  clock = 6 * 60_000;
  assert.equal(await c.resolveChatGuid(handle), `any;-;${handle}`);
  assert.equal(calls.length, 1);

  clock = 31 * 60_000;
  assert.equal(await c.resolveChatGuid(handle), `any;-;${handle}`);
  assert.equal(calls.length, 2);
});

test('🔴 a REFUSED chat/query is not mined for rows — a 500 is "unknown", not an answer', async () => {
  const handle = '+15551234567';
  const { impl, calls } = scripted((call) => {
    if (String(call.url).includes('/chat/query')) {
      // A non-2xx that still carries a body is the shape that makes the status
      // check look redundant: the rows are RIGHT THERE. Reading them addresses
      // whatever thread the error copy happens to hold — here, someone else's.
      return {
        status: 500,
        body: chatQueryReply([
          { guid: 'any;-;+19995550000', chatIdentifier: handle, participants: [{ address: handle }] },
        ]),
      };
    }
    return { body: { status: 200, data: { guid: 'sent' } } };
  });
  const c = client(impl);

  assert.equal(await c.resolveChatGuid(handle), chatGuidFor(handle));

  const result = await c.sendText(handle, 'hello');
  assert.equal(result.accepted, true);
  const textCall = calls.find((call) => String(call.url).includes('/message/text'));
  assert.ok(textCall, 'expected a /message/text call');
  assert.equal((textCall.body as { chatGuid: string }).chatGuid, chatGuidFor(handle));
});

test('recentlySent looks back in the same resolved thread the send addresses', async () => {
  const handle = '+18015550123';
  const { impl, calls } = scripted((call) => {
    const url = String(call.url);
    if (url.includes('/chat/query')) {
      return {
        body: chatQueryReply([
          { guid: `any;-;${handle}`, chatIdentifier: handle, participants: [{ address: handle }] },
        ]),
      };
    }
    if (url.includes('/message/query')) return { body: { status: 200, data: [] } };
    return { body: { status: 200, data: { guid: 'sent' } } };
  });

  const found = await client(impl).recentlySent(handle, 'hello');

  assert.equal(found, false);
  const messageQuery = calls.find((call) => String(call.url).includes('/message/query'));
  assert.ok(messageQuery, 'expected a /message/query call');
  assert.equal((messageQuery.body as { chatGuid: string }).chatGuid, `any;-;${handle}`);
});

test('resolveChatGuid paginates the chat list past the first 100 rows', async () => {
  const handle = '+n120';
  const { impl, calls } = scripted((call) => {
    if (String(call.url).includes('/chat/query')) {
      const offset = Number((call.body as { offset?: number } | undefined)?.offset ?? 0);
      const count = offset === 0 ? 100 : 50;
      const chats = Array.from({ length: count }, (_, i) => {
        const n = offset + i;
        return { guid: `any;-;+n${n}`, chatIdentifier: `+n${n}` };
      });
      return { body: chatQueryReply(chats, 150) };
    }
    return { body: { status: 200, data: { guid: 'sent' } } };
  });

  const guid = await client(impl).resolveChatGuid(handle);

  assert.equal(guid, `any;-;${handle}`);
  assert.equal(calls.filter((call) => String(call.url).includes('/chat/query')).length, 2);
});
