import type { Config } from '../config.js';

/**
 * Send a book to someone's Kindle.
 *
 * ── 🔴 THE ADDRESS IS NOT A PARAMETER ────────────────────────────────────────
 *
 * It is resolved from the sender's handle against the verified store. V1's model
 * **fabricated an address and a stranger received someone's book**, and no
 * validator could have caught it — the string was a syntactically perfect
 * `@kindle.com` address. The model cannot supply what the signature does not
 * accept.
 *
 * ── 🔴 REPORT THE MECHANISM, NEVER THE OUTCOME ───────────────────────────────
 *
 * V1 said *"It should show up on your Kindle in a few minutes"* — an outcome it
 * had no way to observe. This reports **"I've sent it to your Kindle address"**:
 * true, verifiable at the SMTP boundary, and promising nothing the user cannot
 * check for themselves.
 *
 * So there is no `delivered` state here either. `accepted` means the SMTP server
 * took it. Whether Amazon then accepted it is a **separate, later** question,
 * answered only by a bounce — see `kindle-delivery.ts`, which detects failure
 * and never confirms success.
 */

export type SendOutcome =
  /** The SMTP server took it. NOT a delivery claim. */
  | { state: 'accepted'; detail: string; messageId: string }
  | { state: 'rejected'; detail: string }
  /** The attempt did not complete. It MAY have been sent. Never a "no". */
  | { state: 'unknown'; detail: string };

/** Injectable so the whole path is testable without sending mail. */
export type MailSender = (message: {
  from: string;
  to: string;
  subject: string;
  text: string;
  attachments: { filename: string; content: Buffer }[];
}) => Promise<{ messageId?: string }>;

/**
 * Amazon matches the sender against the recipient's approved list, so the
 * from-address is load-bearing rather than cosmetic.
 *
 * 🔴 CUTOVER INVARIANT: V2 must send from the SAME address V1 sends from. A new
 * one means `E014 - Unapproved sender email address` for **every existing user**
 * until each of them adds it in Amazon, which looks like nothing from our side.
 */
export async function sendToKindle(
  input: {
    config: Config;
    toAddress: string;
    filename: string;
    bytes: Buffer;
  },
  send: MailSender,
): Promise<SendOutcome> {
  const { kindle } = input.config;
  if (!kindle.smtpPassword) {
    return {
      state: 'rejected',
      detail:
        'No SMTP password is configured, so nothing was sent. This is a deployment gap, not a ' +
        'problem with the book — KINDLE_SMTP_PASSWORD must be present in the environment.',
    };
  }
  if (!input.toAddress) {
    return { state: 'rejected', detail: 'No stored Kindle address for this person. Nothing was sent.' };
  }
  if (input.bytes.length === 0) {
    return { state: 'rejected', detail: 'The file is empty, so there was nothing to attach.' };
  }

  try {
    /**
     * 🔴 SUBJECT AND BODY MUST BE NON-EMPTY. MEASURED, AFTER GETTING IT WRONG.
     *
     * My first version sent an empty subject and empty body on the reasoning
     * that Amazon reads only the attachment and that "convert" in the subject
     * triggers conversion an epub does not need. **The second half is true and
     * the conclusion did not follow — EMPTY is not the same as NOT SAYING
     * "convert".**
     *
     * The live result: Amazon answered
     * `E009 - No Attachment` for a message that definitely had one. V1's sends,
     * which bounce zero times, carry `subject = <filename>` and the body
     * `"Sent from Jedd."` — so this now matches the structure known to work
     * rather than the one I reasoned my way into.
     */
    const result = await send({
      from: kindle.fromEmail,
      to: input.toAddress,
      subject: input.filename,
      // Resolves to the byte-identical 'Sent from Jedd.' on this deploy, which
      // is the point: the comment above records that this body matches the
      // structure known to bounce zero times, so the DEFAULT must not move.
      text: `Sent from ${input.config.displayName}.`,
      attachments: [{ filename: input.filename, content: input.bytes }],
    });
    return {
      state: 'accepted',
      messageId: String(result.messageId ?? ''),
      detail:
        `Sent "${input.filename}" to ${input.toAddress}. That means the mail server accepted it — ` +
        'it is NOT confirmation that it reached the device. Amazon reports a refusal by email if ' +
        'there is one.',
    };
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    // A 5xx is a definite refusal. Anything else may or may not have gone.
    if (/\b5\d\d\b/.test(message) || /invalid|rejected|denied/i.test(message)) {
      return { state: 'rejected', detail: `The mail server refused it: ${message.slice(0, 160)}` };
    }
    return {
      state: 'unknown',
      detail:
        `The send did not complete (${message.slice(0, 140)}). It MAY have gone — do not simply ` +
        'retry without checking, or the person may receive it twice.',
    };
  }
}

/** The real sender. Kept apart so nothing in the logic above needs a network. */
export async function realMailSender(config: Config): Promise<MailSender> {
  const nodemailer = await import('nodemailer');
  const transport = nodemailer.createTransport({
    host: config.kindle.smtpHost,
    port: config.kindle.smtpPort,
    secure: false,
    requireTLS: true,
    auth: { user: config.kindle.fromEmail, pass: config.kindle.smtpPassword },
  });
  return async (message) => transport.sendMail(message);
}
