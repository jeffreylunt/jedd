import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { classifyPayload } from '../src/bluebubbles/payload.js';
import { ShadowRecorder, assertShadowSafe, type ShadowEntry } from '../src/bluebubbles/shadow.js';
import { testConfig } from './helpers.js';

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'jedd-shadow-')), 'shadow.jsonl');
}

function read(path: string): ShadowEntry[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ShadowEntry);
}

const echo = (text: string) =>
  classifyPayload({
    type: 'new-message',
    data: {
      originalROWID: 2601,
      guid: 'G',
      text,
      isFromMe: true,
      handle: { address: '+15555550100' },
    },
  });

test("🔴 V1's own replies are captured — that is what makes the pairing free", () => {
  const path = tempFile();
  new ShadowRecorder(path).recordSkipped(echo('All done! Dune is ready to watch now.'));
  const [entry] = read(path);
  assert.equal(entry?.kind, 'v1-actual-reply');
  assert.equal(entry?.replyText, 'All done! Dune is ready to watch now.');
});

test('a non-echo skip is recorded but not mistaken for a V1 reply', () => {
  const path = tempFile();
  const tapback = classifyPayload({
    type: 'new-message',
    data: {
      originalROWID: 2602,
      guid: 'G2',
      text: 'Loved "All done!"',
      isFromMe: false,
      associatedMessageType: 'love',
      handle: { address: '+18015550123' },
    },
  });
  new ShadowRecorder(path).recordSkipped(tapback);
  const [entry] = read(path);
  assert.equal(entry?.kind, 'skipped');
  assert.equal(entry?.replyText, undefined, 'a tapback is not a reply from V1');
  assert.match(entry?.reason ?? '', /tapback/i);
});

test("V2's would-be reply is recorded with its tool calls", () => {
  const path = tempFile();
  new ShadowRecorder(path).recordTurn({
    at: '2026-08-24T18:00:00.000Z',
    senderHandle: '+18015550123',
    role: 'guest',
    userText: 'do you have dune?',
    toolCalls: [{ name: 'library_search', args: {}, ok: true }],
    replyText: 'Yes — both are on Jellyfin.',
    steps: 2,
  });
  const [entry] = read(path);
  assert.equal(entry?.kind, 'v2-would-reply');
  assert.equal(entry?.userText, 'do you have dune?');
  // `refused` is absent rather than undefined: JSON.stringify drops undefined
  // keys, so a round-tripped record is not deep-equal to the object it came from.
  assert.deepEqual(entry?.toolCalls, [{ name: 'library_search', ok: true }]);
});

test('a delivered verdict is never recorded as a skip', () => {
  const path = tempFile();
  const inbound = classifyPayload({
    type: 'new-message',
    data: { originalROWID: 3, guid: 'G3', text: 'hi', isFromMe: false, handle: { address: '+1555' } },
  });
  new ShadowRecorder(path).recordSkipped(inbound);
  assert.throws(() => readFileSync(path, 'utf8'), /ENOENT/, 'nothing should have been written');
});

// ── the read-only contradiction ──────────────────────────────────────────────

test('🔴 shadow mode REFUSES when writes are enabled, rather than silently coercing', () => {
  // Coercing would be friendlier and wrong: a caller who set JEDD_ALLOW_WRITES
  // and asked for shadow mode holds two contradictory beliefs, and quietly
  // picking one leaves them believing the other.
  assert.throws(
    () => assertShadowSafe(testConfig({ readOnly: false })),
    /writes ENABLED|refusing/i,
  );
  assert.doesNotThrow(() => assertShadowSafe(testConfig({ readOnly: true })));
});
