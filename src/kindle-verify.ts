import { findDeliveryFailure, type KindleDeliveryVerdict } from './kindle-delivery.js';
import type { MailboxReader } from './kindle-mailbox.js';

/**
 * The instrument: did Amazon refuse this book?
 *
 * ── 🔴 THE ONE REQUIREMENT ───────────────────────────────────────────────────
 *
 * **It must be able to report FAILURE, and every single run must prove it still
 * can.** The thing this replaces could not: a guaranteed-bad send and three
 * hoped-for-good ones produced the identical silence, so its clean output and
 * its broken output were the same output.
 *
 * ── HOW THAT IS ENFORCED, AND WHY IT IS NOT A CONVENTION ────────────────────
 *
 * Two controls run against the real mailbox on EVERY verification, through the
 * same reader, the same folders and the same classifier as the real question:
 *
 *   A. a window that **contains a known real Amazon refusal** — must come back
 *      `failed`, with the exact code that notice carries.
 *   B. a window immediately after it that **contains none** — must come back
 *      `no-failure-seen`.
 *
 * **A verdict about the real send is emitted only if A and B disagree.** If A
 * does not fire, the instrument cannot see failures and any "no failure" it
 * reports is worthless. If B fires, it is attributing old bounces to new sends
 * and any failure it reports is worthless. Either way the answer is `blind`,
 * which is a refusal to answer rather than an answer.
 *
 * This is the difference between "the check is fine because it was fine when I
 * wrote it" and "the check demonstrated, thirty seconds ago, that it can tell
 * the two apart".
 *
 * ── 🔴 THERE IS STILL NO `delivered` STATE ───────────────────────────────────
 *
 * `no-failure-seen` is not success and never becomes success. Amazon sends no
 * acceptance notice (one in nine years of that mailbox), and it discards mail to
 * a nonexistent Kindle address in silence. Only the person holding the device
 * can say it arrived.
 */

export type VerificationResult =
  /** Amazon refused it, and said why. */
  | { state: 'failed'; code: string; reason: string; detail: string; folders: string[] }
  /**
   * The controls passed and no refusal was found for this send. **NOT delivery.**
   */
  | { state: 'no-failure-seen'; detail: string; folders: string[] }
  /**
   * The instrument could not demonstrate it can tell failure from silence, so it
   * has NO opinion about this send. Never to be reported as good news.
   */
  | { state: 'blind'; detail: string };

/**
 * ── 🔴 THE CONTROL, PINNED TO REAL MAIL THAT IS REALLY ON THE SERVER ────────
 *
 * Thread `19ce8cfb60e359dd`, received 2026-03-13T20:07:32Z: *"could not be
 * processed due to E014 - Unapproved sender email address."* Verified present in
 * `jeffreylunt@gmail.com` on 2026-08-26.
 *
 * **E014 is deliberately the control**, because E014 is the failure a new
 * third-party recipient actually hits — someone who was never told to add the
 * sender in Amazon, or who did not. Controlling on the code that matters beats
 * controlling on whichever one was handiest.
 *
 * ⚠️ If this message is ever deleted, every run reports `blind`. That is the
 * correct direction — the instrument goes quiet rather than green — but the fix
 * is to re-point these constants at another real refusal in the mailbox and
 * re-run `scripts/kindle-verify-live.mjs`. **Do not replace them with a
 * fixture**: a control that does not traverse the network proves nothing about
 * the network.
 */
export const CONTROL_BOUNCE = {
  since: new Date('2026-03-13T00:00:00Z'),
  until: new Date('2026-03-14T00:00:00Z'),
  expectCode: 'E014',
} as const;

/**
 * The same folders, the same query, the same day — bounded to start AFTER the
 * control notice arrived. It must come back empty.
 *
 * This is the half that catches the opposite defect from A. A reader that
 * returns everything it can find regardless of the time bound would sail through
 * control A and then attribute an April bounce to tonight's book.
 */
export const CONTROL_QUIET = {
  since: new Date('2026-03-13T21:00:00Z'),
  until: new Date('2026-03-14T00:00:00Z'),
} as const;

export interface ControlReport {
  bounce: { passed: boolean; got: string };
  quiet: { passed: boolean; got: string };
}

/** Run both controls. Exported so the live harness can report them on their own. */
export async function runControls(read: MailboxReader): Promise<ControlReport> {
  const a = await read(CONTROL_BOUNCE.since, CONTROL_BOUNCE.until);
  const bounceVerdict: KindleDeliveryVerdict | { state: 'unreadable'; detail: string } = a.ok
    ? findDeliveryFailure(a.emails, CONTROL_BOUNCE.since)
    : { state: 'unreadable', detail: a.reason };
  const bouncePassed =
    bounceVerdict.state === 'failed' && bounceVerdict.code === CONTROL_BOUNCE.expectCode;

  const b = await read(CONTROL_QUIET.since, CONTROL_QUIET.until);
  const quietVerdict: KindleDeliveryVerdict | { state: 'unreadable'; detail: string } = b.ok
    ? findDeliveryFailure(b.emails, CONTROL_QUIET.since)
    : { state: 'unreadable', detail: b.reason };
  const quietPassed = quietVerdict.state === 'no-failure-seen';

  return {
    bounce: {
      passed: bouncePassed,
      got:
        bounceVerdict.state === 'failed'
          ? `failed/${bounceVerdict.code}`
          : bounceVerdict.state === 'unreadable'
            ? `unreadable: ${bounceVerdict.detail}`
            : bounceVerdict.state,
    },
    quiet: {
      passed: quietPassed,
      got:
        quietVerdict.state === 'failed'
          ? `failed/${quietVerdict.code}`
          : quietVerdict.state === 'unreadable'
            ? `unreadable: ${quietVerdict.detail}`
            : quietVerdict.state,
    },
  };
}

export interface VerifyInput {
  /** When the SMTP hand-off happened. Nothing before this can be about it. */
  sentAt: Date;
  /** The attached filename, so the right bounce is picked out of a busy window. */
  filename?: string;
}

/**
 * Ask whether Amazon refused a specific send — and refuse to answer unless the
 * controls just demonstrated the question is answerable.
 */
export async function verifyKindleDelivery(
  read: MailboxReader,
  input: VerifyInput,
  now: Date = new Date(),
): Promise<VerificationResult> {
  const controls = await runControls(read);
  if (!controls.bounce.passed || !controls.quiet.passed) {
    return {
      state: 'blind',
      detail: describeBlindness(controls),
    };
  }

  const read2 = await read(input.sentAt, now);
  if (!read2.ok) {
    return {
      state: 'blind',
      detail:
        `The controls passed but the read for this send failed: ${read2.reason}. No verdict — ` +
        'a mailbox that could not be searched is not a mailbox with no bounces in it.',
    };
  }

  /**
   * 🔴 A FOLDER THAT COULD NOT BE OPENED IS NOT A FOLDER WITH NO BOUNCES IN IT.
   *
   * Amazon's notices land in Spam, and Gmail's All Mail excludes Spam and Trash
   * — so a Spam folder that failed to open turns a real refusal into a clean
   * result, in the one direction that matters. Partial coverage is blindness,
   * not a smaller answer.
   */
  if (read2.skipped.length > 0) {
    return {
      state: 'blind',
      detail:
        `The controls passed but ${read2.skipped.length} folder(s) could not be searched ` +
        `(${read2.skipped.join('; ')}). No verdict — Amazon's notices land in Spam, and Gmail's ` +
        'All Mail excludes Spam and Trash, so an unsearched folder can hide the whole answer.',
    };
  }

  const verdict = findDeliveryFailure(read2.emails, input.sentAt, input.filename);
  if (verdict.state === 'failed') {
    return { ...verdict, folders: read2.folders };
  }
  return {
    state: 'no-failure-seen',
    folders: read2.folders,
    detail:
      `${verdict.detail} Searched ${read2.folders.join(', ')} since the send; the controls ` +
      `confirmed in this same run that a real refusal in this mailbox IS detected ` +
      `(${controls.bounce.got}) and that an out-of-window one is NOT (${controls.quiet.got}).`,
  };
}

/**
 * 🔴 SAY WHICH WAY THE INSTRUMENT IS BROKEN, BECAUSE THEY NEED DIFFERENT FIXES.
 *
 * The first version of this reported an unreadable mailbox as *"the known-quiet
 * control DID report a failure … so this check is attributing bounces outside
 * its window"* — a confident diagnosis of over-attribution when the truth was
 * that nothing had been read at all. **A wrong reason recorded next to a right
 * verdict is worse than no reason**: it sends the next reader to the wrong file.
 * `unreadable` is now its own branch.
 */
function describeBlindness(controls: ControlReport): string {
  const unreadable = controls.bounce.got.startsWith('unreadable') || controls.quiet.got.startsWith('unreadable');
  if (unreadable) {
    const reason = controls.bounce.got.startsWith('unreadable') ? controls.bounce.got : controls.quiet.got;
    return (
      `No verdict: the mailbox could not be read, so the controls could not run (${reason}). ` +
      'Nothing was searched — this is a connectivity or credentials problem, NOT a report that ' +
      'the mailbox is clean.'
    );
  }
  const bits: string[] = [];
  if (!controls.bounce.passed) {
    bits.push(
      `the known-refusal control did NOT report a failure (got ${controls.bounce.got}, expected ` +
        `failed/${CONTROL_BOUNCE.expectCode}) — so this check cannot currently detect a refusal, ` +
        'and any "nothing went wrong" from it would be meaningless',
    );
  }
  if (!controls.quiet.passed) {
    bits.push(
      `the known-quiet control DID report a failure (got ${controls.quiet.got}) — so this check is ` +
        'attributing bounces outside the window it was asked about, and any failure it reported ' +
        'could belong to a different send',
    );
  }
  return `No verdict: ${bits.join('; and ')}.`;
}
