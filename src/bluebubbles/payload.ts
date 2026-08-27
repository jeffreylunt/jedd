import type { IncomingMessage } from '../connector.js';
import { normaliseHandle } from '../permissions.js';

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

/**
 * 🔴 A MESSAGE FROM OUR OWN ADDRESS IS AN INFINITE SELF-REPLY LOOP.
 *
 * MEASURED 2026-08-26, twice, on the live server. A message sent to Jedd's own
 * iMessage address comes back through this webhook **twice**: once with
 * `isFromMe: true` — skipped correctly below as an outbound echo — and once with
 * `isFromMe: false`, because the same account also RECEIVED it.
 *
 * That second copy is not malformed. It is not a tapback. It has a real handle,
 * real text, an explicit `isFromMe: false` and its own `originalROWID`, so the
 * dedup key does not collide either. **Every other guard in this file passes it,
 * correctly**, because by every field BlueBubbles reports it IS a genuine
 * inbound message. Jedd answers it, the answer echoes back the same way, and
 * nothing terminates the cycle — `main.ts` sends `replyText` unconditionally and
 * a one-character reply is not an empty one. It ran at one exchange every ~10
 * seconds until the process was stopped.
 *
 * ⚠️ THE POINT IS THAT `isFromMe` CANNOT EXPRESS THIS. It is a per-message flag
 * and the loop is created by an IDENTITY equality. So this is the only guard
 * here that needs to know who we are — and we already do: `assertIdentity()`
 * reads `detected_imessage` at boot and refuses to start on a mismatch. The
 * value is passed in rather than read from config so that the thing being
 * compared against is the SERVER'S account, not a hopeful constant.
 *
 * Comparison goes through `normaliseHandle`, the same hardened comparator the
 * permission gate uses — deliberately not a suffix match.
 */
export function classifyPayload(raw: unknown, selfIdentity?: string): InboundVerdict {
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

  /**
   * 🔴 Checked BEFORE the empty-text and handle checks are of any consequence,
   * and placed with the other echo guards: this is the same class of failure as
   * `isFromMe`, just the half that a flag cannot see.
   */
  const self = normaliseHandle(selfIdentity ?? '');
  if (self && normaliseHandle(senderHandle) === self) {
    return skip(
      `SELF-ADDRESSED — this arrived from our own iMessage identity (${selfIdentity}). ` +
        'BlueBubbles delivers a self-sent message a second time with isFromMe:false; answering it ' +
        'is an infinite self-reply loop.',
    );
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
    // `sourceGuid` is what a threaded reply anchors to. It is the same `guid`
    // reported alongside — carried on the message itself so the send path does
    // not have to reach back into the verdict to find it.
    message: { senderHandle, text: text.trim(), ...(guid ? { sourceGuid: guid } : {}) },
    dedupKey,
    rowid,
    guid,
    isFromMe: false,
  };
}
