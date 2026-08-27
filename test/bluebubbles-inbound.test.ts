import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { classifyPayload } from '../src/bluebubbles/payload.js';
import { SeenStore } from '../src/bluebubbles/seen.js';

/**
 * The inbound BlueBubbles traps, each one a MEASURED V1 defect rather than a
 * hypothetical. Every test here exists because this exact thing went wrong in
 * production, and the classification half is a pure function precisely so these
 * can be pinned without a network.
 */

/** Narrow to a delivered verdict, failing the test if it was skipped. */
function delivered(v: ReturnType<typeof classifyPayload>) {
  assert.equal(v.action, 'deliver', v.action === 'skip' ? `skipped: ${v.reason}` : '');
  if (v.action !== 'deliver') throw new Error('unreachable');
  return v;
}

function payload(over: Record<string, unknown> = {}): unknown {
  return {
    type: 'new-message',
    data: {
      originalROWID: 2600,
      guid: 'ABC-123',
      text: 'do you have dune?',
      dateCreated: 1787590040000,
      isFromMe: false,
      handle: { address: '+18015550123', service: 'iMessage' },
      chats: [{ chatIdentifier: '+18015550123', originalROWID: 44 }],
      ...over,
    },
  };
}

// ── isFromMe: the infinite self-reply loop ───────────────────────────────────

test('🔴 an outbound echo is never delivered', () => {
  const v = classifyPayload(payload({ isFromMe: true }));
  assert.equal(v.action, 'skip');
  if (v.action !== 'skip') throw new Error('unreachable');
  assert.match(v.reason, /outbound/i);
});

test('🔴 isFromMe is only trusted when it is explicitly false', () => {
  // BB sending anything other than a real `false` must NOT be read as inbound.
  // Getting this wrong is an infinite self-reply loop, which is the single
  // most-repeated warning in V1's knowledge base — so UNKNOWN does not deliver.
  for (const weird of [1, 'true', 'false', null, undefined, {}]) {
    const v = classifyPayload(payload({ isFromMe: weird }));
    assert.equal(v.action, 'skip', `isFromMe=${JSON.stringify(weird)} must not be delivered`);
  }
  assert.equal(classifyPayload(payload({ isFromMe: false })).action, 'deliver');
});

// ── tapbacks: they masquerade as ordinary inbound messages ───────────────────

test('🔴 a tapback is skipped even though isFromMe is false', () => {
  // A reaction arrives with isFromMe:false and `text` set to JEDD'S OWN prior
  // sentence quoted back. Unfiltered it becomes a role:"user" turn, and the
  // grounding check then reads a 👍 as literal consent to provisioning.
  const v = classifyPayload(
    payload({
      associatedMessageType: 'love',
      text: 'Loved "All done! Dune is ready to watch now."',
    }),
  );
  assert.equal(v.action, 'skip');
  if (v.action !== 'skip') throw new Error('unreachable');
  assert.match(v.reason, /tapback|reaction/i);
});

test('🔴 tapback detection is non-null, NOT an allowlist of known kinds', () => {
  // An allowlist silently readmits reaction kinds nobody has observed yet.
  const v = classifyPayload(payload({ associatedMessageType: 'a-reaction-invented-in-2027' }));
  assert.equal(v.action, 'skip');
});

test('a real message with a guid but no associated type is delivered', () => {
  // A guid with associatedMessageType null is a real message, not a reaction —
  // so associatedMessageGuid must play no part in the test.
  const v = classifyPayload(payload({ associatedMessageGuid: 'SOME-GUID', associatedMessageType: null }));
  assert.equal(v.action, 'deliver');
});

// ── things that cannot be deduped must not be delivered ──────────────────────

test('🔴 a payload with neither rowid nor guid is skipped, because it cannot be deduped', () => {
  const v = classifyPayload(payload({ originalROWID: null, guid: null }));
  assert.equal(v.action, 'skip');
  if (v.action !== 'skip') throw new Error('unreachable');
  assert.match(v.reason, /dedup/i);
});

test('guid is a FALLBACK dedup key when the rowid is missing, not half of a composite', () => {
  // A composite (rowid, guid) key would FAIL to dedup if the two fires of one
  // message ever differ in guid — it would score them as two messages. rowid
  // alone is the key; guid only stands in when there is no rowid.
  assert.equal(delivered(classifyPayload(payload({ originalROWID: null }))).dedupKey, 'guid:ABC-123');
  assert.equal(delivered(classifyPayload(payload())).dedupKey, 'rowid:2600');
});

// ── the ordinary cases ───────────────────────────────────────────────────────

test('a normal inbound message is delivered with its sender and text', () => {
  const v = delivered(classifyPayload(payload()));
  assert.equal(v.message.senderHandle, '+18015550123');
  assert.equal(v.message.text, 'do you have dune?');
});

test('non new-message events and empty text are skipped', () => {
  assert.equal(classifyPayload({ type: 'typing-indicator', data: {} }).action, 'skip');
  assert.equal(classifyPayload(payload({ text: '   ' })).action, 'skip');
  assert.equal(classifyPayload(payload({ text: null })).action, 'skip');
  assert.equal(classifyPayload('not even an object').action, 'skip');
});

// ── dedup and the watermark ──────────────────────────────────────────────────

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'jedd-bb-')), 'seen.jsonl');
}

test('🔴 BB double-fires one rowid and it is delivered exactly once', () => {
  const seen = new SeenStore(tempFile());
  assert.equal(seen.firstSight('rowid:2600'), true);
  assert.equal(seen.firstSight('rowid:2600'), false);
});

test('🔴 dedup survives a restart — a redelivered rowid is still a duplicate', () => {
  const path = tempFile();
  new SeenStore(path).firstSight('rowid:2600');
  assert.equal(new SeenStore(path).firstSight('rowid:2600'), false);
});

test('🔴 the watermark is a ROWID and rejects a timestamp-shaped value', () => {
  // V1's watermark holds 1783501783569848 -- a microsecond timestamp in a rowid
  // field -- against real rowids of ~2601, so `rowid > watermark` is ALWAYS
  // false and replay can never return anything. It reports that as the
  // reassuring "no messages after rowid ...", so the failure state and the
  // all-clear state are the same string.
  const seen = new SeenStore(tempFile());
  assert.equal(seen.watermark(), 0);
  seen.advanceWatermark(2600);
  assert.equal(seen.watermark(), 2600);
  assert.throws(() => seen.advanceWatermark(1783501783569848), /implausible|timestamp/i);
  assert.equal(seen.watermark(), 2600, 'a rejected value must not be stored');
});

test('the watermark never moves backwards', () => {
  const seen = new SeenStore(tempFile());
  seen.advanceWatermark(2600);
  seen.advanceWatermark(2500);
  assert.equal(seen.watermark(), 2600);
});

test('the watermark survives a restart', () => {
  const path = tempFile();
  new SeenStore(path).advanceWatermark(2600);
  assert.equal(new SeenStore(path).watermark(), 2600);
});
