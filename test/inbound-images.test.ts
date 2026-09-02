import assert from 'node:assert/strict';
import { test } from 'node:test';
import { joinBurstText, mergeAttachments, type IncomingMessage } from '../src/connector.js';
import { createImageHydrator } from '../src/bluebubbles/attachments.js';
import { classifyPayload } from '../src/bluebubbles/payload.js';
import type { FetchImpl } from '../src/bluebubbles/client.js';

/**
 * The transport seam for inbound images: what the webhook guard now lets
 * through, what the hydrator makes of it, and how a burst folds together.
 */

const LIMITS = { maxWidth: 1024, maxBytes: 1000, maxCount: 3 };

/**
 * A real inbound photo, captured live from Jedd's own account on 2026-09-01.
 * The `attachments` entry is the reduced shape a `new-message` webhook carries.
 */
function photoPayload(over: Record<string, unknown> = {}): unknown {
  return {
    type: 'new-message',
    data: {
      originalROWID: 780,
      guid: '4BDA375C-599E-4A95-A153-86CE927F2935',
      // 🔴 THE MEASURED VALUE. Not U+FFFC — BlueBubbles' `sanitizeStr` has
      // already stripped that by the time it reaches a webhook.
      text: '',
      isFromMe: false,
      handle: { address: '+18015550123', service: 'iMessage' },
      attachments: [
        {
          originalROWID: 34,
          guid: '7E3D669D-2CC8-447B-B4F1-8FD21DBB00F8',
          uti: 'public.heic',
          mimeType: 'image/heic',
          transferName: 'IMG_9465.HEIC',
          totalBytes: 100,
        },
      ],
      ...over,
    },
  };
}

// ── the guard that was silently eating every photo ───────────────────────────

test('🔴 an attachment-only message (text: "") is DELIVERED, not skipped as "no text"', () => {
  const v = classifyPayload(photoPayload());
  assert.equal(
    v.action,
    'deliver',
    'this is the exact shape a captionless photo arrives in; the old guard dropped it',
  );
});

test('🔴 a message with NEITHER text nor attachments is still skipped', () => {
  // The guard was narrowed, not removed. Losing this is how the fix becomes a
  // regression that answers empty system rows.
  const v = classifyPayload(photoPayload({ text: '', attachments: [] }));
  assert.equal(v.action, 'skip');
  if (v.action !== 'skip') return;
  assert.match(v.reason, /no text and no attachments/);
});

test('an empty text with a MISSING attachments key is skipped', () => {
  const v = classifyPayload({
    type: 'new-message',
    data: {
      originalROWID: 1,
      guid: 'g',
      text: '   ',
      isFromMe: false,
      handle: { address: '+18015550123' },
    },
  });
  assert.equal(v.action, 'skip');
});

test('the raw attachments array is carried through UNFETCHED', () => {
  const v = classifyPayload(photoPayload());
  assert.equal(v.action, 'deliver');
  if (v.action !== 'deliver') return;
  assert.ok(Array.isArray(v.attachmentsRaw));
  assert.equal((v.attachmentsRaw as unknown[]).length, 1);
});

test('a photo WITH a caption keeps the caption', () => {
  const v = classifyPayload(photoPayload({ text: 'get this one' }));
  assert.equal(v.action, 'deliver');
  if (v.action !== 'deliver') return;
  assert.equal(v.message.text, 'get this one');
});

test('🔴 every OTHER inbound guard still runs on a message with attachments', () => {
  // An image must not become a way past the loop guards. A tapback carrying an
  // attachment, or our own outbound photo echoing back, is still skipped.
  const tapback = classifyPayload(photoPayload({ associatedMessageType: 'love' }));
  assert.equal(tapback.action, 'skip');

  const echo = classifyPayload(photoPayload({ isFromMe: true }));
  assert.equal(echo.action, 'skip');

  const self = classifyPayload(photoPayload(), '+18015550123');
  assert.equal(self.action, 'skip', 'a self-addressed photo is still an infinite loop');
});

// ── hydration ────────────────────────────────────────────────────────────────

function hydrator(handler: (url: string) => Response | Promise<Response>) {
  const urls: string[] = [];
  const impl: FetchImpl = async (url) => {
    urls.push(String(url));
    return handler(String(url));
  };
  return {
    urls,
    hydrate: createImageHydrator({
      baseUrl: 'http://bb.invalid:1234',
      password: 'pw',
      limits: LIMITS,
      fetchImpl: impl,
    }),
  };
}

function png(n = 4): Response {
  return new Response(new Uint8Array(n), {
    status: 200,
    headers: { 'content-type': 'image/png' },
  });
}

test('a plain text message hydrates to UNDEFINED, not an empty record', async () => {
  const { hydrate, urls } = hydrator(() => png());
  assert.equal(await hydrate(undefined), undefined);
  assert.equal(await hydrate([]), undefined);
  assert.deepEqual(urls, [], 'nothing to fetch means no request at all');
});

test('a good photo hydrates to one image and no trouble', async () => {
  const { hydrate, urls } = hydrator(() => png());
  const raw = (classifyPayload(photoPayload()) as { attachmentsRaw: unknown }).attachmentsRaw;
  const got = await hydrate(raw);
  assert.ok(got);
  assert.equal(got.images.length, 1);
  assert.equal(got.images[0]?.name, 'IMG_9465.HEIC');
  assert.equal(got.trouble.length, 0);
  assert.equal(urls.length, 1);
  assert.match(urls[0]!, /width=1024/);
});

test('🔴 a fetch failure becomes TROUBLE, never a thrown turn', async () => {
  const { hydrate } = hydrator(() => {
    throw new Error('ECONNREFUSED');
  });
  const raw = (classifyPayload(photoPayload()) as { attachmentsRaw: unknown }).attachmentsRaw;
  const got = await hydrate(raw);
  assert.ok(got);
  assert.equal(got.images.length, 0);
  assert.equal(got.trouble[0]?.reason, 'unfetchable');
});

test('🔴 the three trouble reasons stay DISTINCT through hydration', async () => {
  // Each is a different sentence to the sender. This is the test that fails if
  // anyone ever "simplifies" them into one `failed`.
  const { hydrate } = hydrator(() => new Response(new Uint8Array(0), { status: 200 }));
  const got = await hydrate([
    { guid: 'v', mimeType: 'video/quicktime', uti: 'public.movie', transferName: 'clip.mov' },
    { guid: 'b', mimeType: 'image/png', uti: 'public.png', transferName: 'big.png', totalBytes: 99999 },
    { guid: 'u', mimeType: 'image/png', uti: 'public.png', transferName: 'gone.png', totalBytes: 10 },
  ]);
  assert.ok(got);
  const reasons = got.trouble.map((t) => t.reason).sort();
  assert.deepEqual(reasons, ['oversize', 'unfetchable', 'unsupported']);
});

test('a good image and a bad one in the same message both survive', async () => {
  const { hydrate } = hydrator((url) => (url.includes('bad') ? png(0) : png(4)));
  const got = await hydrate([
    { guid: 'good', mimeType: 'image/png', uti: 'public.png', transferName: 'a.png', totalBytes: 10 },
    { guid: 'bad', mimeType: 'image/png', uti: 'public.png', transferName: 'b.png', totalBytes: 10 },
  ]);
  assert.ok(got);
  assert.equal(got.images.length, 1);
  assert.equal(got.trouble.length, 1);
});

// ── burst folding ────────────────────────────────────────────────────────────

function msg(over: Partial<IncomingMessage> = {}): IncomingMessage {
  return { senderHandle: '+18015550123', text: 'hi', ...over };
}

function withImages(n: number): IncomingMessage {
  return msg({
    attachments: {
      images: Array.from({ length: n }, (_, i) => ({
        base64: 'AAAA',
        name: `p${i}.png`,
        contentType: 'image/png',
      })),
      trouble: [],
      overflow: 0,
    },
  });
}

test('a burst with no attachments folds to undefined', () => {
  assert.equal(mergeAttachments([msg(), msg()], 4), undefined);
});

test('images from every message in the burst are collected', () => {
  const merged = mergeAttachments([withImages(1), msg(), withImages(2)], 4);
  assert.ok(merged);
  assert.equal(merged.images.length, 3);
});

test('🔴 the cap applies ACROSS the burst, not per message', () => {
  // Four messages of two images each. Capped per message they all pass and eight
  // arrive; the cap has to see the burst as one turn.
  const merged = mergeAttachments([withImages(2), withImages(2), withImages(2), withImages(2)], 3);
  assert.ok(merged);
  assert.equal(merged.images.length, 3);
  assert.equal(merged.overflow, 5, 'the ones we did not look at are COUNTED, not dropped silently');
});

test('overflow already counted by a single message is carried, not lost', () => {
  const m = msg({ attachments: { images: [], trouble: [], overflow: 2 } });
  const merged = mergeAttachments([m, withImages(1)], 3);
  assert.ok(merged);
  assert.equal(merged.overflow, 2);
  assert.equal(merged.images.length, 1);
});

test('trouble from every message in the burst is kept', () => {
  const a = msg({
    attachments: {
      images: [],
      trouble: [{ reason: 'unsupported', name: 'a.mov', detail: 'video/quicktime' }],
      overflow: 0,
    },
  });
  const b = msg({
    attachments: {
      images: [],
      trouble: [{ reason: 'oversize', name: 'b.png', detail: 'too big' }],
      overflow: 0,
    },
  });
  const merged = mergeAttachments([a, b], 4);
  assert.ok(merged);
  assert.equal(merged.trouble.length, 2);
});

test('🔴 a lone captionless photo does NOT become a bare newline', () => {
  // `"\n"` is not an empty string, so it passes every downstream emptiness check
  // and the model gets a turn made of whitespace.
  assert.equal(joinBurstText([msg({ text: '' })]), '');
});

test('a caption on one message of a photo burst survives intact', () => {
  assert.equal(
    joinBurstText([msg({ text: '' }), msg({ text: 'which of these?' }), msg({ text: '' })]),
    'which of these?',
  );
});

test('a genuine multi-line burst is still joined with newlines', () => {
  assert.equal(joinBurstText([msg({ text: 'one' }), msg({ text: 'two' })]), 'one\ntwo');
});
