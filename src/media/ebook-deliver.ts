import type { Config } from '../config.js';
import type { EbookDeliverSubject } from '../followups.js';
import type { ExecImpl } from '../hp.js';
import type { KindleRegistry } from '../kindle.js';
import { validateEbookBytes } from './ebook-validate.js';
import { fetchFileFromHp, resolveBookPath } from './fetch-file.js';
import { grabStatus, toHostPath, type MountMap } from './grab.js';
import type { IrcEbooks } from './irc-ebooks.js';
import { sendToKindle, type MailSender } from './kindle-send.js';

/**
 * The last leg of an ebook, shared by BOTH sources and by both callers.
 *
 * `send_ebook` calls it once inside the turn (fast path: the torrent may already
 * be on disk). The follow-up runner calls it again later, when the turn is long
 * over. One function, so the validation and the delivery cannot drift apart
 * between the two paths — and so the Kindle address is read from exactly one
 * place either way.
 *
 * 🔴 THE VALIDATOR SITS HERE, IN FRONT OF `sendToKindle`, FOR BOTH SOURCES.
 * An indexer is no more trustworthy than an IRC bot. Nothing reaches the mail
 * step without its bytes being identified first.
 */

export type DeliverOutcome =
  /** Handed to the mail server. Terminal, and the user should be told. */
  | { state: 'delivered'; detail: string }
  /** Not here yet, no error. Come back later; do NOT tell the user it arrived. */
  | { state: 'waiting'; detail: string }
  /** Terminal and bad. The user must be told plainly. */
  | { state: 'failed'; detail: string }
  /** Could not establish anything. Defer rather than guess. */
  | { state: 'unknown'; detail: string };

export interface DeliverDeps {
  config: Config;
  kindle: KindleRegistry;
  mail: MailSender;
  exec?: ExecImpl;
  irc?: IrcEbooks;
  mounts?: MountMap[];
  /**
   * 🔴 THE LIVE-TEST RESTRICTION LIVES HERE, NOT ONLY IN THE TOOL.
   *
   * `send_ebook` argues its `onlySendTo` is safe because the restricted build is
   * "a DIFFERENT OBJECT, not the same object in a different mood". The follow-up
   * runner bypassed that object entirely — it calls `deliverEbook` directly with
   * the raw mail sender. Not reachable today, because the tool refuses before
   * scheduling; but a follow-up OUTLIVES the turn that wrote it and can outlive
   * an `OWNER_HANDLE` change, which is the same reason the runner already
   * re-derives `role` instead of trusting the record. Putting the gate on the
   * shared leg means both callers inherit it and neither has to remember.
   */
  onlySendTo?: string;
}

export async function deliverEbook(
  subject: EbookDeliverSubject,
  senderHandle: string,
  deps: DeliverDeps,
  opts: { mayBlock: boolean },
): Promise<DeliverOutcome> {
  /**
   * 🔴 THE ADDRESS IS READ NOW, NOT TAKEN FROM THE FOLLOW-UP RECORD.
   *
   * V1 once persisted a model-invented address and a stranger received someone's
   * book. The gate against that is that an address only ever comes from the
   * registry, keyed by the person asking — never from a parameter, and never
   * from a record written minutes or hours ago that may since have changed.
   */
  if (deps.onlySendTo && senderHandle !== deps.onlySendTo) {
    return {
      state: 'failed',
      detail: `this build only sends books to ${deps.onlySendTo}. Nothing was sent.`,
    };
  }

  const record = deps.kindle.get(senderHandle);
  if (!record) {
    return {
      state: 'failed',
      detail:
        'I do not have a Send-to-Kindle address saved for you, so I could not send it. ' +
        'Tell me your @kindle.com address and I will finish this.',
    };
  }

  const got =
    subject.source === 'irc'
      ? await fetchViaIrc(subject, deps, opts.mayBlock)
      : await fetchViaTorrent(subject, deps);
  if (got.state !== 'ok') return got;

  // ── identify the bytes before anything else touches them ──────────────────
  const verdict = validateEbookBytes(got.filename, got.bytes);
  if (verdict.state !== 'ok') {
    return {
      state: 'failed',
      detail: `I did not send it: ${verdict.detail} Nothing was forwarded to your Kindle.`,
    };
  }

  const sent = await sendToKindle(
    { config: deps.config, toAddress: record.address, filename: got.filename, bytes: got.bytes },
    deps.mail,
  );
  if (sent.state === 'accepted') {
    return { state: 'delivered', detail: `"${got.filename}" is on its way to your Kindle.` };
  }
  if (sent.state === 'rejected') return { state: 'failed', detail: sent.detail };
  /**
   * 🔴 UNKNOWN *AFTER* THE MAIL HAND-OFF IS TERMINAL, NOT A RETRY.
   *
   * `sendToKindle` documents this state as "It MAY have gone — do not simply
   * retry without checking, or the person may receive it twice." Returning
   * `unknown` here would do exactly that: the runner treats `unknown` as "no
   * verdict yet", defers, and the next attempt re-fetches and re-mails a book
   * that may already be on its way.
   *
   * `unknown` BEFORE the hand-off (could not read qBittorrent, could not reach
   * the bot) is safe to retry. `unknown` AFTER it is not, and the two must not
   * share a state. An uncertain single delivery beats a certain double one.
   */
  return {
    state: 'failed',
    detail:
      `${sent.detail} I have NOT tried again, because it may already have gone and you would ` +
      'get it twice. Check your Kindle, and ask me if it never turns up.',
  };
}

type Got =
  | { state: 'ok'; filename: string; bytes: Buffer }
  | { state: 'waiting'; detail: string }
  | { state: 'failed'; detail: string }
  | { state: 'unknown'; detail: string };

/**
 * IRC: ask the bot, wait for the DCC.
 *
 * ⚠️ Never attempted inside a turn. A bot may queue a request for **ten minutes
 * or more**, and a turn that blocks on that is a turn that never ends. When the
 * caller cannot block, this reports `waiting` WITHOUT sending the request, so
 * the request happens exactly once, in the follow-up, where there is time.
 */
async function fetchViaIrc(subject: EbookDeliverSubject, deps: DeliverDeps, mayBlock: boolean): Promise<Got> {
  if (!deps.irc) {
    return { state: 'failed', detail: 'the IRC source is not available on this deployment.' };
  }
  if (!subject.command || !subject.bot) {
    return { state: 'failed', detail: 'that pick did not carry an IRC command, so it cannot be fetched.' };
  }
  if (!mayBlock) {
    return {
      state: 'waiting',
      detail: `queued a request to ${subject.bot} on IRC. Transfers there take minutes.`,
    };
  }
  const r = await deps.irc.fetch(subject.command, subject.bot);
  if (r.state === 'ok') return { state: 'ok', filename: r.filename, bytes: r.bytes };
  // `failed` from the client is terminal (bot absent, never answered, truncated,
  // passive DCC). `unknown` means we could not even establish that much.
  return r.state === 'failed' ? { state: 'failed', detail: r.detail } : { state: 'unknown', detail: r.detail };
}

/** Prowlarr/qBittorrent: is it on disk yet, and if so read it off hp. */
async function fetchViaTorrent(subject: EbookDeliverSubject, deps: DeliverDeps): Promise<Got> {
  if (!subject.infoHash) {
    return { state: 'failed', detail: 'that pick did not carry a torrent hash, so it cannot be fetched.' };
  }
  const status = await grabStatus({
    adminSshHost: deps.config.adminSshHost,
    qbitBaseUrl: deps.config.qbittorrent.baseUrl,
    infoHash: subject.infoHash,
    exec: deps.exec,
  });
  if (status.state === 'unknown') return { state: 'unknown', detail: status.detail };
  if (status.state === 'missing') return { state: 'failed', detail: status.detail };
  if (status.state === 'downloading') return { state: 'waiting', detail: status.detail };

  const hostPath = toHostPath(status.contentPath, deps.mounts ?? []);
  if (!hostPath) {
    return {
      state: 'failed',
      detail:
        `qBittorrent reports "${status.contentPath}", which maps to no known mount. ` +
        'That is a configuration problem, not a missing book.',
    };
  }
  const book = await resolveBookPath({ adminSshHost: deps.config.adminSshHost, hostPath, exec: deps.exec });
  if (book.state === 'none') return { state: 'failed', detail: book.detail };
  if (book.state !== 'ok') return { state: 'unknown', detail: book.detail };

  const file = await fetchFileFromHp({ adminSshHost: deps.config.adminSshHost, hostPath: book.path, exec: deps.exec });
  if (file.state === 'ok') return { state: 'ok', filename: file.name, bytes: file.bytes };
  return file.state === 'corrupt'
    ? { state: 'failed', detail: file.detail }
    : { state: 'unknown', detail: file.detail };
}
