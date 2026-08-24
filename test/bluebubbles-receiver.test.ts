import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BlueBubblesClient, type FetchImpl } from '../src/bluebubbles/client.js';
import {
  BlueBubblesReceiver,
  ShadowConnector,
  BlueBubblesConnector,
  parseSendAudience,
} from '../src/bluebubbles/receiver.js';
import { SeenStore } from '../src/bluebubbles/seen.js';
import type { IncomingMessage } from '../src/connector.js';

/**
 * The receiver, against a REAL http server on an ephemeral port.
 *
 * Not mocked: the whole claim is "it answers BlueBubbles immediately and does
 * the work afterwards", and a fake transport would let that pass while the
 * ordering was wrong. The only way to observe the ordering is to make a real
 * request and watch when the response lands.
 */

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'jedd-recv-')), 'seen.jsonl');
}

function msg(over: Record<string, unknown> = {}) {
  return {
    type: 'new-message',
    data: {
      originalROWID: 2600,
      guid: 'G-1',
      text: 'do you have dune?',
      isFromMe: false,
      handle: { address: '+18015550123' },
      ...over,
    },
  };
}

function stubClient(fetchImpl?: FetchImpl): BlueBubblesClient {
  return new BlueBubblesClient({
    baseUrl: 'http://bb.invalid:1234',
    password: 'pw',
    fetchImpl: fetchImpl ?? (async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }) as Response),
  });
}

async function withReceiver(
  opts: { seen?: SeenStore; onSkipped?: (v: unknown) => void; client?: BlueBubblesClient },
  body: (r: BlueBubblesReceiver, port: number, got: IncomingMessage[]) => Promise<void>,
) {
  const got: IncomingMessage[] = [];
  const receiver = new BlueBubblesReceiver({
    client: opts.client ?? stubClient(),
    seen: opts.seen ?? new SeenStore(tempFile()),
    host: '127.0.0.1',
    port: 0,
    path: '/webhook',
    onSkipped: opts.onSkipped,
  });
  const port = await receiver.start(async (m) => {
    got.push(m);
  });
  try {
    await body(receiver, port, got);
  } finally {
    await receiver.stop();
  }
}

const post = (port: number, payload: unknown) =>
  fetch(`http://127.0.0.1:${port}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

// ── 🔴 answer first, work second ─────────────────────────────────────────────

test('🔴 the 200 is returned BEFORE the handler runs, not after', async () => {
  // BlueBubbles dispatches fire-and-forget (`// We don't need to await this`),
  // so a slow subscriber cannot delay another. That is not a licence to be slow:
  // this is the design rule for any listener we point at a live server.
  let release!: () => void;
  const blocked = new Promise<void>((r) => (release = r));
  const receiver = new BlueBubblesReceiver({
    client: stubClient(),
    seen: new SeenStore(tempFile()),
    host: '127.0.0.1',
    port: 0,
    path: '/webhook',
  });
  let handlerStarted = false;
  const port = await receiver.start(async () => {
    handlerStarted = true;
    await blocked; // never resolves until we say so
  });
  try {
    const res = await post(port, msg());
    assert.equal(res.status, 200, 'the response must arrive while the handler is still blocked');
    assert.equal(handlerStarted, true);
  } finally {
    release();
    await receiver.stop();
  }
});

test('a handler that throws does not break the listener or the response', async () => {
  const receiver = new BlueBubblesReceiver({
    client: stubClient(),
    seen: new SeenStore(tempFile()),
    host: '127.0.0.1',
    port: 0,
    path: '/webhook',
  });
  const port = await receiver.start(async () => {
    throw new Error('handler exploded');
  });
  try {
    assert.equal((await post(port, msg())).status, 200);
    assert.equal((await post(port, msg({ originalROWID: 2601, guid: 'G-2' }))).status, 200);
  } finally {
    await receiver.stop();
  }
});

// ── dedup and the skip path ──────────────────────────────────────────────────

test('🔴 a double-fired rowid reaches the handler exactly once', async () => {
  await withReceiver({}, async (_r, port, got) => {
    await post(port, msg());
    await post(port, msg()); // BB's ~1ms twin
    assert.equal(got.length, 1);
  });
});

test('🔴 an outbound echo is withheld from the handler but OFFERED to the shadow recorder', async () => {
  // V1's own replies come back on this same webhook as isFromMe:true. The loop
  // must never see them; the corpus is built out of exactly those rows.
  const skipped: { isFromMe?: boolean; reason?: string }[] = [];
  await withReceiver(
    { onSkipped: (v) => skipped.push(v as { isFromMe?: boolean; reason?: string }) },
    async (_r, port, got) => {
      await post(port, msg({ isFromMe: true, text: 'All done! Dune is ready.' }));
      assert.equal(got.length, 0, 'the loop must not see its own send');
      assert.equal(skipped.length, 1, 'but the shadow recorder must');
      assert.equal(skipped[0]?.isFromMe, true);
    },
  );
});

test('a tapback is withheld from the handler', async () => {
  await withReceiver({}, async (_r, port, got) => {
    await post(port, msg({ associatedMessageType: 'love', text: 'Loved "All done!"' }));
    assert.equal(got.length, 0);
  });
});

// ── the watermark ────────────────────────────────────────────────────────────

test('🔴 a live message advances the replay watermark', async () => {
  const seen = new SeenStore(tempFile());
  await withReceiver({ seen }, async (_r, port) => {
    await post(port, msg({ originalROWID: 2600 }));
    assert.equal(seen.watermark(), 2600);
  });
});

test('🔴 an outbound echo advances the watermark too', async () => {
  // Otherwise a quiet period of our own sends leaves the watermark stale and
  // replay re-delivers messages that were never missed.
  const seen = new SeenStore(tempFile());
  await withReceiver({ seen }, async (_r, port) => {
    await post(port, msg({ originalROWID: 2700, isFromMe: true }));
    assert.equal(seen.watermark(), 2700);
  });
});

// ── boot replay ──────────────────────────────────────────────────────────────

test('🔴 boot replay delivers missed messages oldest-first and advances the watermark', async () => {
  const seen = new SeenStore(tempFile());
  seen.advanceWatermark(2500);
  const rows = [2503, 2502, 2501].map((r) => ({
    originalROWID: r,
    guid: `g${r}`,
    text: `m${r}`,
    isFromMe: false,
    handle: { address: '+18015550123' },
  }));
  const client = stubClient(async (_u, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const data = (body.offset ?? 0) === 0 ? rows : [];
    return { ok: true, status: 200, json: async () => ({ data }) } as Response;
  });
  await withReceiver({ seen, client }, async (r, _port, got) => {
    const res = await r.replayMissed(async (m) => {
      got.push(m);
    });
    assert.equal(res.delivered, 3);
    assert.equal(res.saturated, false);
    assert.deepEqual(got.map((m) => m.text), ['m2501', 'm2502', 'm2503']);
    assert.equal(seen.watermark(), 2503);
  });
});

test('🔴 a replayed message already seen live is not delivered twice', async () => {
  const seen = new SeenStore(tempFile());
  const rows = [{ originalROWID: 2600, guid: 'G-1', text: 'x', isFromMe: false, handle: { address: '+1555' } }];
  const client = stubClient(async (_u, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    return { ok: true, status: 200, json: async () => ({ data: (body.offset ?? 0) === 0 ? rows : [] }) } as Response;
  });
  await withReceiver({ seen, client }, async (r, port, got) => {
    await post(port, msg({ originalROWID: 2600, guid: 'G-1' })); // live first
    assert.equal(got.length, 1);
    await r.replayMissed(async (m) => {
      got.push(m);
    });
    assert.equal(got.length, 1, 'dedup spans the live and replay paths');
  });
});

test('🔴 a saturated replay is reported, not swallowed', async () => {
  const seen = new SeenStore(tempFile());
  seen.advanceWatermark(1);
  const client = stubClient(async (_u, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const off = body.offset ?? 0;
    const data = Array.from({ length: 100 }, (_, i) => ({
      originalROWID: 900_000 - off - i,
      guid: `g${900_000 - off - i}`,
      text: 'x',
      isFromMe: false,
      handle: { address: '+1555' },
    }));
    return { ok: true, status: 200, json: async () => ({ data }) } as Response;
  });
  await withReceiver({ seen, client }, async (r) => {
    const res = await r.replayMissed(async () => {});
    assert.equal(res.saturated, true);
    assert.match(res.detail, /incomplete|saturat|older/i);
  });
});

// ── send is absent by construction in shadow mode ────────────────────────────

test('🔴 ShadowConnector cannot send, and holds nothing that could', async () => {
  const receiver = new BlueBubblesReceiver({
    client: stubClient(),
    seen: new SeenStore(tempFile()),
    host: '127.0.0.1',
    port: 0,
    path: '/webhook',
  });
  const shadow = new ShadowConnector(receiver);
  await assert.rejects(() => shadow.send('+1555', 'hello'), /shadow|cannot send/i);
  // Not a flag someone can flip: there is no client on the object at all.
  assert.equal(
    Object.values(shadow as unknown as Record<string, unknown>).some(
      (v) => v instanceof BlueBubblesClient,
    ),
    false,
    'a shadow connector must not hold anything capable of sending',
  );
});

test('the real connector does send, so the shadow refusal is a real difference', async () => {
  const calls: string[] = [];
  const client = stubClient(async (u) => {
    calls.push(String(u));
    return { ok: true, status: 200, json: async () => ({ data: { guid: 'g' } }) } as Response;
  });
  const receiver = new BlueBubblesReceiver({
    client,
    seen: new SeenStore(tempFile()),
    host: '127.0.0.1',
    port: 0,
    path: '/webhook',
  });
  await new BlueBubblesConnector(receiver, client, 'everyone').send('+18015550123', 'hi');
  assert.ok(calls.some((u) => u.includes('/message/text')));
});

// ── 🔴 the send audience: who V2 may text during a rehearsal ─────────────────

test('🔴 an unset JEDD_SEND_TO is a REFUSAL, never "everyone"', () => {
  // The rehearsal and the cutover run the same binary against the same server.
  // If forgetting the variable meant "everyone", the dangerous case would be the
  // one you get by not thinking about it.
  assert.throws(() => parseSendAudience(undefined), /I will not guess/);
  assert.throws(() => parseSendAudience('   '), /I will not guess/);
  assert.throws(() => parseSendAudience(' , , '), /empty list/);
});

test('the cutover value has to be typed out in full', () => {
  assert.equal(parseSendAudience('everyone'), 'everyone');
  // Nothing else is quietly promoted to it.
  assert.deepEqual(parseSendAudience('all'), ['all']);
  assert.deepEqual(parseSendAudience('EVERYONE'), ['EVERYONE']);
});

test('a rehearsal audience is parsed as a handle list', () => {
  assert.deepEqual(parseSendAudience(' +15555550100 , jeff@example.com '), ['+15555550100', 'jeff@example.com']);
});

test('🔴 a reply to a handle outside the audience never reaches sendText', async () => {
  const sent: string[] = [];
  const client = {
    async sendText(to: string) {
      sent.push(to);
      return { accepted: true, detail: 'ok' };
    },
  } as unknown as BlueBubblesClient;
  const suppressed: string[] = [];
  const connector = new BlueBubblesConnector(
    null as unknown as BlueBubblesReceiver,
    client,
    ['+15555550100'],
    (to) => suppressed.push(to),
  );

  await connector.send('+15555550100', 'hello Jeff');
  await connector.send('+15551112222', 'hello somebody else');

  // 🔴 The gate is above the transport. Not a prompt line, not an agent check —
  // the suppressed reply has no path to the wire even if every layer above it
  // decided to answer.
  assert.deepEqual(sent, ['+15555550100']);
  assert.deepEqual(suppressed, ['+15551112222']);
});

test('the everyone audience does send to everyone', async () => {
  const sent: string[] = [];
  const client = {
    async sendText(to: string) {
      sent.push(to);
      return { accepted: true, detail: 'ok' };
    },
  } as unknown as BlueBubblesClient;
  const connector = new BlueBubblesConnector(null as unknown as BlueBubblesReceiver, client, 'everyone');
  await connector.send('+15551112222', 'hi');
  assert.deepEqual(sent, ['+15551112222'], 'the gate must not be so tight that a real cutover is silent');
});

test('a suppressed send resolves quietly — it is not an error the loop should log as a failure', async () => {
  const client = {
    async sendText() {
      throw new Error('sendText must not be reached');
    },
  } as unknown as BlueBubblesClient;
  const connector = new BlueBubblesConnector(null as unknown as BlueBubblesReceiver, client, []);
  await connector.send('+15551112222', 'hi');
});
