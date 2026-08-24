/**
 * Did a book actually reach someone's Kindle?
 *
 * ── 🔴 THIS OVERTURNS A V1 BACKLOG CLAIM, AND THE CORRECTION MATTERS ─────────
 *
 * V1's open task says Kindle delivery verification **cannot fail**: a
 * guaranteed-bad address (`jedd_probe_nonexistent@kindle.com`) produced the
 * *identical* silence as three real successful sends over 22 minutes. The
 * conclusion drawn was that the channel carries no signal.
 *
 * **That conclusion is wrong, and it was drawn from one failure mode.** Searched
 * against the real mailbox on 2026-08-24, Amazon sends detailed, machine-
 * readable failure notices from `do-not-reply@amazon.com` — observed live:
 *
 *   E001 - Unsupported File Format
 *   E009 - No Attachment
 *   E014 - Unapproved sender email address   (naming the offending address)
 *   E999 - Send to Kindle Internal Error     (naming the document)
 *
 * So the truth is narrower and far more useful than "no signal":
 *
 *   **A BOUNCE IS A DEFINITE FAILURE, WITH A REASON.**
 *   **SILENCE IS AMBIGUOUS** — delivered, or sent to an address that does not
 *   exist. Amazon simply drops the second case.
 *
 * ── WHAT THAT MEANS FOR THE TYPE ─────────────────────────────────────────────
 *
 * 🔴 **There is deliberately no `delivered` state.** Success cannot be
 * established from this channel, so it must not be representable — otherwise
 * some future caller sets it on "no bounce yet", which is precisely the false
 * confirmation V1's probe exposed. The instrument DETECTS FAILURE and never
 * CONFIRMS SUCCESS, and the type says so.
 */

export type KindleDeliveryVerdict =
  | { state: 'failed'; code: string; reason: string; detail: string }
  /**
   * No failure notice found. **NOT a success.** Either it arrived, or the
   * address does not exist and Amazon discarded it silently.
   */
  | { state: 'no-failure-seen'; detail: string };

export interface BounceEmail {
  from: string;
  subject: string;
  body: string;
  receivedAt: string;
}

const AMAZON_SENDER = 'do-not-reply@amazon.com';
const BOUNCE_SUBJECT = /problem with the document\(s\) you sent to Kindle/i;
/** `E014 - Unapproved sender email address` — code then dash then description. */
const ERROR_CODE = /\b(E\d{3})\s*-\s*([^.\n]+)/;

/**
 * What a given error code means for the person waiting, and whether anyone can
 * do anything about it. The distinction the user actually needs is
 * **"you must act" vs "I must act" vs "nobody can"**.
 */
const ADVICE: Record<string, string> = {
  E001: 'the file format was rejected — I sent something Kindle will not take, which is mine to fix.',
  E009: 'the message arrived with no attachment, which is a fault on my side.',
  E014:
    'Amazon does not recognise the sender address, so it refused the document. ' +
    'Add the sender to your Amazon approved-senders list and I can try again.',
  E999: "Amazon had an internal error on their side. Nothing was wrong with the request; it is worth retrying.",
};

/**
 * Look for a failure notice about a send.
 *
 * `since` bounds the search to after the send, so an OLD bounce for a different
 * book cannot be read as this one failing — the mailbox holds several, and they
 * all share a subject line.
 */
export function findDeliveryFailure(
  emails: BounceEmail[],
  since: Date,
  documentHint?: string,
): KindleDeliveryVerdict {
  const candidates = emails.filter((e) => {
    if (!e.from.toLowerCase().includes(AMAZON_SENDER)) return false;
    if (!BOUNCE_SUBJECT.test(e.subject)) return false;
    const at = Date.parse(e.receivedAt);
    return Number.isFinite(at) && at >= since.getTime();
  });

  // Prefer one that names the document, when we have a name to match. Several
  // bounces can share a window, and attributing the wrong one is a false report.
  const matched =
    (documentHint
      ? candidates.find((e) => e.body.toLowerCase().includes(documentHint.toLowerCase()))
      : undefined) ?? candidates[0];

  if (!matched) {
    return {
      state: 'no-failure-seen',
      detail:
        'No failure notice from Amazon since the send. That is NOT confirmation it arrived — a ' +
        'nonexistent Kindle address is discarded silently, which looks exactly the same from here.',
    };
  }

  const m = ERROR_CODE.exec(matched.body);
  const code = m?.[1] ?? 'UNKNOWN';
  const reason = (m?.[2] ?? 'Amazon reported a problem').trim();
  return {
    state: 'failed',
    code,
    reason,
    detail: `Amazon refused it: ${code} — ${reason}. ${ADVICE[code] ?? 'Retrying may not help until that is resolved.'}`,
  };
}
