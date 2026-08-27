import { findDeliveryFailure, type BounceEmail, type KindleDeliveryVerdict } from './kindle-delivery.js';
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
  /** Amazon refused THIS send, and said why. */
  | { state: 'failed'; code: string; reason: string; detail: string; folders: string[] }
  /**
   * A refusal is present in the window and cannot be tied to this send — several
   * were refused and none names this file. **Something failed; possibly not
   * this.** Kept apart from `failed` because telling someone their book was
   * thrown away when it was someone else's is its own harm.
   */
  | { state: 'failed-unattributed'; code: string; reason: string; detail: string; folders: string[] }
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
 * `owner@example.com` on 2026-08-26.
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

export interface VerifyInput {
  /** When the SMTP hand-off happened. Nothing before this can be about it. */
  sentAt: Date;
  /** The attached filename, so the right bounce is picked out of a busy window. */
  filename?: string;
}

/**
 * 🔴 HOW WIDE THE QUESTION IS ALLOWED TO GET.
 *
 * The upper bound is `min(now, sentAt + this)`, not `now`. A runner that was
 * down for three hours would otherwise ask "has ANYTHING been refused since
 * 21:44" — and the harness proved what that does: run unbounded against the
 * Mistborn sends it reported `failed / E009` from a bounce twenty hours later
 * belonging to somebody else's probe. **An unbounded window turns "did THIS send
 * fail" into "has anything failed since", and the second question eventually
 * always answers yes.**
 */
export const VERIFY_WINDOW_MS = 60 * 60 * 1000;

function describeVerdict(v: KindleDeliveryVerdict | { state: 'unreadable'; detail: string }): string {
  if (v.state === 'failed') return `failed/${v.code}`;
  if (v.state === 'unreadable') return `unreadable: ${v.detail}`;
  return v.state;
}

/**
 * Ask whether Amazon refused a specific send — and refuse to answer unless the
 * controls just demonstrated the question is answerable.
 *
 * 🔴 ALL THREE QUESTIONS GO DOWN ONE MAILBOX SESSION. Not an optimisation: it
 * means a control cannot pass against a folder sweep the real question never
 * got, and it removes the loop where hitting Gmail's login limit produced
 * `blind`, which scheduled a retry, which opened three more connections.
 */
export async function verifyKindleDelivery(
  read: MailboxReader,
  input: VerifyInput,
  now: Date = new Date(),
): Promise<VerificationResult> {
  const until = new Date(Math.min(now.getTime(), input.sentAt.getTime() + VERIFY_WINDOW_MS));
  const got = await read([
    { since: CONTROL_BOUNCE.since, until: CONTROL_BOUNCE.until },
    { since: CONTROL_QUIET.since, until: CONTROL_QUIET.until },
    { since: input.sentAt, until },
  ]);

  if (!got.ok) {
    return {
      state: 'blind',
      detail:
        `No verdict: the mailbox could not be read, so nothing was searched and the controls could ` +
        `not run (${got.reason}). This is a connectivity or credentials problem, NOT a report that ` +
        'the mailbox is clean.',
    };
  }

  const [bounceWindow, quietWindow, sendWindow] = got.windows as [
    BounceEmail[],
    BounceEmail[],
    BounceEmail[],
  ];
  const bounceVerdict = findDeliveryFailure(bounceWindow, CONTROL_BOUNCE.since);
  const quietVerdict = findDeliveryFailure(quietWindow, CONTROL_QUIET.since);
  const controls: ControlReport = {
    bounce: {
      passed: bounceVerdict.state === 'failed' && bounceVerdict.code === CONTROL_BOUNCE.expectCode,
      got: describeVerdict(bounceVerdict),
    },
    quiet: { passed: quietVerdict.state === 'no-failure-seen', got: describeVerdict(quietVerdict) },
  };
  if (!controls.bounce.passed || !controls.quiet.passed) {
    return { state: 'blind', detail: describeBlindness(controls) };
  }

  /**
   * 🔴 A FOLDER THAT COULD NOT BE SEARCHED IS NOT A FOLDER WITH NO BOUNCES IN IT.
   *
   * Amazon's notices land in Spam, and Gmail's All Mail excludes Spam and Trash
   * — so an unsearched Spam folder turns a real refusal into a clean result, in
   * the one direction that matters. Partial coverage is blindness, not a smaller
   * answer.
   *
   * Checked AFTER the controls so the message names the more specific fault when
   * both are wrong.
   */
  if (got.skipped.length > 0) {
    return {
      state: 'blind',
      detail:
        `The controls passed but ${got.skipped.length} folder(s)/message(s) could not be searched ` +
        `(${got.skipped.join('; ')}). No verdict — Amazon's notices land in Spam, and Gmail's ` +
        'All Mail excludes Spam and Trash, so an unsearched folder can hide the whole answer.',
    };
  }

  const verdict = findDeliveryFailure(sendWindow, input.sentAt, input.filename);
  if (verdict.state === 'failed') {
    /**
     * Several refusals in the window and none names this file: something was
     * refused and it may belong to another send. Reported as its own state so
     * the message can hedge and the log can say which it was — rather than the
     * old behaviour of picking the first array element and asserting it.
     */
    if (verdict.attribution === 'ambiguous') {
      return {
        state: 'failed-unattributed',
        code: verdict.code,
        reason: verdict.reason,
        detail: verdict.detail,
        folders: got.folders,
      };
    }
    return {
      state: 'failed',
      code: verdict.code,
      reason: verdict.reason,
      detail: verdict.detail,
      folders: got.folders,
    };
  }
  return {
    state: 'no-failure-seen',
    folders: got.folders,
    detail:
      `${verdict.detail} Searched ${got.folders.join(', ')} from the send until ` +
      `${until.toISOString()}; the controls confirmed in this same session that a real refusal in ` +
      `this mailbox IS detected (${controls.bounce.got}) and that an out-of-window one is NOT ` +
      `(${controls.quiet.got}).`,
  };
}

/** Run just the controls. Exported so the live harness can report them alone. */
export async function runControls(read: MailboxReader): Promise<ControlReport> {
  const got = await read([
    { since: CONTROL_BOUNCE.since, until: CONTROL_BOUNCE.until },
    { since: CONTROL_QUIET.since, until: CONTROL_QUIET.until },
  ]);
  if (!got.ok) {
    const unreadable = { state: 'unreadable' as const, detail: got.reason };
    return {
      bounce: { passed: false, got: describeVerdict(unreadable) },
      quiet: { passed: false, got: describeVerdict(unreadable) },
    };
  }
  const bounceVerdict = findDeliveryFailure(got.windows[0] ?? [], CONTROL_BOUNCE.since);
  const quietVerdict = findDeliveryFailure(got.windows[1] ?? [], CONTROL_QUIET.since);
  return {
    bounce: {
      passed: bounceVerdict.state === 'failed' && bounceVerdict.code === CONTROL_BOUNCE.expectCode,
      got: describeVerdict(bounceVerdict),
    },
    quiet: { passed: quietVerdict.state === 'no-failure-seen', got: describeVerdict(quietVerdict) },
  };
}

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
