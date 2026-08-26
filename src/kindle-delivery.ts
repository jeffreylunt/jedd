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
  | {
      state: 'failed';
      code: string;
      reason: string;
      detail: string;
      /**
       * 🔴 HOW CONFIDENT THE ATTRIBUTION IS — because "a refusal happened" and
       * "YOUR book was refused" are different claims.
       *
       * `document`   the notice names this file. Certain.
       * `sole`       exactly one refusal in the window. Certain enough to report.
       * `ambiguous`  several refusals in the window and none names this file, so
       *              SOMETHING was refused and it may not be this send.
       *
       * The version without this field picked `candidates[0]` when the filename
       * hint missed — array order, which is FOLDER order, not time — and told
       * the wrong person their book had been thrown away. Two sends twelve
       * minutes apart is the ordinary case, not a corner.
       *
       * ⚠️ The hint cannot simply be made mandatory: `E009 - No Attachment` and
       * `E014 - Unapproved sender email address` carry NO filename at all, and
       * E014 is the failure that matters most. Requiring a name match would miss
       * every one of them.
       */
      attribution: 'document' | 'sole' | 'ambiguous';
    }
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
  const named = documentHint
    ? candidates.filter((e) => e.body.toLowerCase().includes(documentHint.toLowerCase()))
    : [];
  const matched = named[0] ?? candidates[0];
  const attribution: 'document' | 'sole' | 'ambiguous' =
    named.length === 1 ? 'document' : candidates.length === 1 ? 'sole' : 'ambiguous';

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
    attribution,
    /**
     * 🔴 `detail` REACHES A USER, SO IT CARRIES THE CODE AND OUR OWN WORDS —
     * NEVER `reason`, WHICH IS CAPTURED OUT OF THE MESSAGE BODY.
     *
     * On today's E014 the capture stops before the offending sender address
     * because it sits on its own line. It is one Amazon rewording away from
     * mailing the owner's private sending address to a guest. `reason` stays on
     * the verdict for the log; the sentence a person reads does not include it.
     */
    detail:
      (attribution === 'ambiguous'
        ? `Amazon refused a document sent around the same time (${code}) and the notice does not ` +
          'say which one, so I cannot be sure it was this book. '
        : `Amazon refused it (${code}). `) +
      (ADVICE[code] ?? 'Amazon reported a problem, and retrying may not help until it is resolved.'),
  };
}
