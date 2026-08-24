import type { IncomingMessage } from '../connector.js';

/**
 * Classify one BlueBubbles webhook payload. PURE — no I/O, no state.
 *
 * It is a pure function on purpose: every rule below is a MEASURED V1 defect,
 * and keeping the decision away from the HTTP layer is what lets each one be
 * pinned by a test without a network or a live server.
 *
 * It returns a verdict rather than a boolean because two callers want different
 * halves of it. The agent loop takes only `deliver`. The shadow recorder wants
 * the skips too — V1's own replies come back through this same webhook as
 * outbound echoes, and those echoes are how the parity corpus gets its ground
 * truth for free.
 */

export type InboundVerdict =
  | {
      action: 'deliver';
      message: IncomingMessage;
      /** What dedup is keyed on. See `dedupKeyFor` for why this is not a composite. */
      dedupKey: string;
      rowid: number | null;
      guid: string | null;
      isFromMe: false;
    }
  | {
      action: 'skip';
      reason: string;
      rowid: number | null;
      guid: string | null;
      /** Set for an outbound echo, so the shadow recorder can keep V1's replies. */
      isFromMe: boolean;
      text: string;
      senderHandle: string;
    };

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * 🔴 THE DEDUP KEY IS THE ROWID. GUID IS A FALLBACK, NOT HALF OF A COMPOSITE.
 *
 * BlueBubbles double-fires the same message within ~1 ms (send, then delivery
 * receipt) — observed live on this server, twice per outbound message.
 *
 * A composite `(originalROWID, guid)` key is the intuitive choice and it is
 * WRONG: if the two fires ever differ in guid, the composite scores them as two
 * distinct messages and dedup silently stops working — turning the guard into
 * the thing it was built to prevent. The rowid alone identifies the message;
 * guid only stands in when there is no rowid at all.
 */
function dedupKeyFor(rowid: number | null, guid: string | null): string | null {
  if (rowid !== null) return `rowid:${rowid}`;
  if (guid) return `guid:${guid}`;
  return null;
}

export function classifyPayload(raw: unknown): InboundVerdict {
  const top = asRecord(raw);
  const data = asRecord(top?.['data']) ?? {};

  const rawRowid = data['originalROWID'];
  const rowid = typeof rawRowid === 'number' && Number.isFinite(rawRowid) ? rawRowid : null;
  const guid = typeof data['guid'] === 'string' && data['guid'] ? data['guid'] : null;
  const text = typeof data['text'] === 'string' ? data['text'] : '';
  const handle = asRecord(data['handle']);
  const senderHandle = typeof handle?.['address'] === 'string' ? handle['address'] : '';
  const isFromMeRaw = data['isFromMe'];
  const isFromMe = isFromMeRaw === true;

  const skip = (reason: string): InboundVerdict => ({
    action: 'skip',
    reason,
    rowid,
    guid,
    isFromMe,
    text,
    senderHandle,
  });

  if (top?.['type'] !== 'new-message') {
    return skip(`event type is "${String(top?.['type'])}", not new-message`);
  }

  /**
   * 🔴 DELIVER ONLY WHEN `isFromMe` IS EXPLICITLY `false`.
   *
   * V1 checks `=== true` and skips. That is right about the common case and
   * wrong about the ambiguous one: if BlueBubbles ever sent `1` or `"true"`,
   * a `=== true` test would fail to match and the message would be treated as
   * INBOUND — which is an infinite self-reply loop, the single most-repeated
   * warning in V1's knowledge base.
   *
   * So this is the same three-state discipline used everywhere else here:
   * UNKNOWN never authorises. The failure mode of being too strict is that Jedd
   * goes quiet, which is loud and obvious. The failure mode of being too lax is
   * a machine talking to itself forever.
   */
  if (isFromMeRaw !== false) {
    return skip(
      isFromMe
        ? 'outbound echo — this is one of our own sends coming back'
        : `isFromMe is ${JSON.stringify(isFromMeRaw)}, not an explicit false — refusing to treat it as inbound`,
    );
  }

  /**
   * 🔴 TAPBACKS. A reaction arrives with `isFromMe: false` and `text` set to
   * JEDD'S OWN PRIOR SENTENCE quoted back, so the echo guard above does not
   * catch it. Unfiltered it becomes a `role: "user"` turn and the grounding
   * check reads a 👍 as literal user consent to provisioning.
   *
   * The test is bare non-null and NOT an allowlist of observed kinds: an
   * allowlist silently readmits a reaction type nobody has seen yet. The field
   * is a STRING here ('like' | 'love' | …), not the numeric enum Apple's docs
   * describe. `associatedMessageGuid` plays no part — a guid with a null type is
   * a real message, not a reaction.
   */
  if (data['associatedMessageType'] != null) {
    return skip(`tapback/reaction (associatedMessageType=${String(data['associatedMessageType'])})`);
  }

  if (!text.trim()) return skip('no text');
  if (!senderHandle) return skip('no sender handle');

  const dedupKey = dedupKeyFor(rowid, guid);
  if (!dedupKey) {
    // Fail closed. Without a key we cannot dedup, and BB double-fires every
    // message — so accepting this would GUARANTEE a duplicate reply.
    return skip('no originalROWID and no guid, so it cannot be deduped');
  }

  return {
    action: 'deliver',
    message: { senderHandle, text: text.trim() },
    dedupKey,
    rowid,
    guid,
    isFromMe: false,
  };
}
