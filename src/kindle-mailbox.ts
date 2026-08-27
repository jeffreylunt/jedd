import type { BounceEmail } from './kindle-delivery.js';
import type { Config } from './config.js';

/**
 * The leg that was missing: actually reading the mailbox Amazon replies to.
 *
 * ── 🔴 WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 *
 * `kindle-delivery.ts` shipped a classifier that could name every failure code
 * Amazon sends, was mutation-tested, and **had no production caller.** Nothing
 * ever handed it a real mailbox, so it was a parser that had never been pointed
 * at anything. A detector that has never seen live input is a claim.
 *
 * Amazon's asymmetry is the whole reason this is needed: **success is silent and
 * failure is out-of-band.** A refusal arrives as email to the SENDING account
 * minutes later and Jedd never sees it. So the only way the loop closes is to go
 * and read that mailbox.
 *
 * ── 🔴 A READ THAT FAILED MUST NOT LOOK LIKE A MAILBOX WITH NO BOUNCES ───────
 *
 * This returns a discriminated result, never a bare array. An empty array and a
 * refused login are the same value if you let them be, and the empty array reads
 * as "nothing went wrong" — the exact false-clean this whole task exists to
 * prevent. `unavailable` is a separate state and the caller cannot ignore it.
 */

/** One question: what arrived between these two instants. */
export interface MailboxWindow {
  since: Date;
  until?: Date;
}

export type MailboxRead =
  | {
      ok: true;
      /**
       * One entry per requested window, in the order they were asked for.
       *
       * 🔴 ONE CONNECTION ANSWERS ALL OF THEM, AND THAT IS LOAD-BEARING.
       *
       * Every verification asks three questions — two controls and the real one.
       * Three separate logins meant Gmail's connection and login limits could
       * refuse the third, which reads as `blind`, which schedules a retry, which
       * opens three more. **A rate limit and the reaction to it formed a loop.**
       *
       * It also makes the controls honest in a way separate reads could not: all
       * three questions are answered from the SAME folder set on the SAME
       * session, so a control cannot pass against a sweep the real question
       * never got.
       */
      windows: BounceEmail[][];
      /** Folders actually opened and searched. */
      folders: string[];
      /**
       * 🔴 FOLDERS THAT WERE ADVERTISED AND COULD NOT BE OPENED.
       *
       * Found by a mutation that dropped Spam and Trash from the sweep and was
       * caught by NOTHING. Chasing it turned up the worse version of the same
       * hole in this very file: a folder whose lock failed was `continue`d past,
       * and the read still came back `ok` with a shorter list nobody compared
       * against anything. **A folder that could not be opened is not a folder
       * with no bounces in it** — and Amazon's notices demonstrably land in Spam.
       *
       * Reported rather than swallowed so the verifier can go blind on it.
       */
      skipped: string[];
    }
  /** Could not look. **NOT** "looked and found nothing." */
  | { ok: false; reason: string };

/**
 * Answer several window questions from one mailbox session.
 *
 * Injectable so the verifier can be driven from fixtures, from a deliberately
 * broken reader, and from the real IMAP server without changing a line.
 */
export type MailboxReader = (windows: MailboxWindow[]) => Promise<MailboxRead>;

/** Only Amazon's notification address is ever fetched. Nothing else is read. */
export const AMAZON_NOTIFY = 'do-not-reply@amazon.com';

/**
 * 🔴 ALL FOUR FOLDERS, AND THE REASON IS MEASURED.
 *
 * Gmail's All Mail **excludes Spam and Trash**, and Amazon's notices
 * demonstrably land in Spam. Searching All Mail alone therefore returns a clean
 * result for a bounce that exists — a false negative in the direction that
 * matters.
 *
 * Resolved by IMAP special-use flag rather than by name: the literal
 * `[Gmail]/All Mail` is localised per account, so a hardcoded English name is a
 * silent zero on a non-English mailbox.
 */
export const WANTED_SPECIAL_USE = ['\\All', '\\Junk', '\\Trash'] as const;

export interface ImapSettings {
  host: string;
  port: number;
  user: string;
  pass: string;
}

/** Where the credentials come from, and what is missing when they are not there. */
export function imapSettingsFrom(config: Config): ImapSettings | { missing: string } {
  const user = config.kindle.fromEmail;
  /**
   * The Gmail app password already present for SMTP works for IMAP on the same
   * account, so the common deployment needs no new secret. A separate
   * `KINDLE_IMAP_PASSWORD` still wins if one is set, because an account that
   * sends and reads through different credentials must remain expressible.
   */
  const pass = process.env['KINDLE_IMAP_PASSWORD'] ?? config.kindle.smtpPassword;
  if (!user) return { missing: 'KINDLE_FROM_EMAIL' };
  if (!pass) return { missing: 'KINDLE_IMAP_PASSWORD or KINDLE_SMTP_PASSWORD' };
  return {
    host: process.env['KINDLE_IMAP_HOST'] ?? 'imap.gmail.com',
    port: Number(process.env['KINDLE_IMAP_PORT'] ?? 993),
    user,
    pass,
  };
}

/**
 * The real reader. Kept behind the `MailboxReader` seam so nothing in the
 * verifier needs a network, and so a broken reader can be substituted to prove
 * the blindness path.
 */
export function imapMailboxReader(settings: ImapSettings, timeoutMs = 45_000): MailboxReader {
  return async (windows) => {
    if (windows.length === 0) return { ok: false, reason: 'no window was asked about' };
    const { ImapFlow } = await import('imapflow');
    const client = new ImapFlow({
      host: settings.host,
      port: settings.port,
      secure: true,
      auth: { user: settings.user, pass: settings.pass },
      // The default logger prints every IMAP command, and those lines carry
      // mailbox contents. This reads someone's private mail; it does not narrate
      // it to stdout.
      logger: false,
      socketTimeout: timeoutMs,
    });

    /**
     * 🔴 WITHOUT THIS LISTENER A DROPPED TLS SESSION KILLS THE WHOLE PROCESS.
     *
     * Once imapflow has connected it reports later socket errors by EMITTING
     * `error` (`imap-flow.js` `emitError`), and Node throws on an unhandled
     * `error` event — from inside a socket handler, where the `try/catch` around
     * the awaits below cannot see it. jedd has no `uncaughtException` handler, so
     * a mid-fetch disconnect would take the daemon down. The `try/catch` still
     * handles the rejected await; this listener only has to EXIST.
     */
    client.on('error', () => {});

    const collected: BounceEmail[] = [];
    const folders: string[] = [];
    const skipped: string[] = [];
    let connected = false;
    try {
      await withTimeout(client.connect(), timeoutMs, 'IMAP connect');
      connected = true;
      const boxes = await withTimeout(client.list(), timeoutMs, 'IMAP LIST');

      /**
       * 🔴 A FLAG THAT NEVER TURNED UP IS RECORDED AS UNSEARCHED.
       *
       * The first version only recorded folders whose LOCK threw. A folder the
       * server never advertised was recorded nowhere at all — so a session where
       * SPECIAL-USE was missing or matched by locale-dependent name silently
       * narrowed the sweep to INBOX, returned `ok`, and the controls could not
       * catch it: the pinned control notice lives in All Mail, so it passes on a
       * narrow sweep, and a real refusal sitting in SPAM comes back clean.
       *
       * That is the same defect the header of this file is about — a read that
       * did not happen looking like a mailbox with nothing in it — one branch
       * along from where it was already fixed.
       */
      const plan = planFolders(boxes as { path: string; specialUse?: string }[]);
      const paths = plan.paths;
      skipped.push(...plan.unadvertised);

      /**
       * 🔴 IMAP `SINCE` HAS DAY GRANULARITY, SO IT IS WIDENED BY A DAY AND THE
       * REAL BOUND IS APPLIED IN CODE.
       *
       * A same-day send compared against a date-only server-side filter is
       * exactly the off-by-one that turns a real bounce into "no results" —
       * the shape of the himalaya `after <D>` defect. Over-fetch, then filter
       * precisely on the timestamp we actually have.
       */
      const earliest = windows.reduce((a, w) => Math.min(a, w.since.getTime()), Infinity);
      const searchSince = new Date(earliest - 24 * 60 * 60 * 1000);

      for (const path of paths) {
        let lock;
        try {
          // 🔴 EXAMINE, not SELECT. This reads someone's mailbox and must not be
          // able to change it — by construction, not by trusting that the
          // library happens to use BODY.PEEK.
          lock = await withTimeout(client.getMailboxLock(path, { readOnly: true }), timeoutMs, `open ${path}`);
        } catch (e) {
          // Recorded, never swallowed — see `skipped` on MailboxRead.
          skipped.push(`${path} (${(e as Error).message ?? 'could not open'})`);
          continue;
        }
        try {
          folders.push(path);
          for await (const msg of client.fetch(
            { from: AMAZON_NOTIFY, since: searchSince },
            /**
             * 🔴 `internalDate` IS THE SERVER'S ARRIVAL STAMP; `envelope.date` IS
             * WHATEVER THE SENDER WROTE.
             *
             * Using the sender's header meant Amazon's clock running seconds
             * ahead of ours pushed a real refusal past the upper bound and it
             * came back clean — and a notice with NO parsable Date became epoch,
             * failed the lower bound, and vanished with no trace anywhere. Both
             * are a real bounce dropped for a timekeeping reason.
             */
            { envelope: true, internalDate: true, source: true },
          )) {
            const converted = toBounceEmail(msg);
            if ('unplaceable' in converted) {
              skipped.push(`a message in ${path} with no usable timestamp`);
              continue;
            }
            collected.push(converted);
          }
        } finally {
          lock.release();
        }
      }
    } catch (e) {
      return { ok: false, reason: `${(e as Error).message ?? String(e)}`.slice(0, 200) };
    } finally {
      /**
       * `logout()` is a protocol round trip and needs a live connection; on the
       * timeout path there is none, and awaiting it leaked the socket. `close()`
       * is the synchronous teardown that always applies.
       */
      try {
        if (connected) await withTimeout(client.logout(), 5_000, 'IMAP logout');
        else client.close();
      } catch {
        try {
          client.close();
        } catch {
          /* the read already happened; a failed teardown must not void it */
        }
      }
    }

    if (folders.length === 0) {
      return { ok: false, reason: 'no mail folders could be opened, so nothing was searched' };
    }
    return {
      ok: true,
      folders,
      skipped,
      windows: windows.map((w) => {
        const upper = w.until?.getTime() ?? Number.POSITIVE_INFINITY;
        return collected.filter((e) => {
          const at = Date.parse(e.receivedAt);
          return Number.isFinite(at) && at >= w.since.getTime() && at <= upper;
        });
      }),
    };
  };
}

/**
 * Which folders to search, and which wanted ones are NOT going to be searched.
 *
 * 🔴 SPLIT OUT SO IT CAN BE TESTED WITHOUT A SERVER, because the defect it
 * guards is invisible from the outside: a session where SPECIAL-USE is missing
 * (or matched by locale-dependent NAME, which is imapflow's fallback) narrows
 * the sweep to INBOX, returns `ok`, and the controls cannot catch it — the pinned
 * control notice lives in All Mail, so it passes on a narrow sweep, and a real
 * refusal sitting in SPAM comes back clean.
 */
export function planFolders(
  boxes: { path: string; specialUse?: string }[],
): { paths: string[]; unadvertised: string[] } {
  const paths = ['INBOX'];
  const found = new Set<string>();
  for (const box of boxes) {
    const use = box.specialUse;
    if (use && (WANTED_SPECIAL_USE as readonly string[]).includes(use)) {
      paths.push(box.path);
      found.add(use);
    }
  }
  return {
    paths,
    unadvertised: WANTED_SPECIAL_USE.filter((u) => !found.has(u)).map(
      (u) => `${u} (not advertised by the server)`,
    ),
  };
}

/**
 * When the server says the message ARRIVED — not when its sender says it was written.
 *
 * 🔴 `envelope.date` IS THE SENDER'S HEADER AND USING IT LOSES REAL BOUNCES.
 * Amazon's clock running seconds ahead of ours pushed a refusal past the upper
 * bound and it came back clean; a notice with no parsable Date became epoch,
 * failed the lower bound, and vanished with no trace anywhere. `NaN` here means
 * "cannot be placed in time", and the caller records it as unsearched rather
 * than dropping it.
 */
export function arrivalTime(msg: {
  /** imapflow types this as `string | Date`, and both really occur. */
  internalDate?: string | Date;
  envelope?: { date?: string | Date };
}): number {
  for (const stamp of [msg.internalDate, msg.envelope?.date]) {
    if (stamp instanceof Date) {
      const at = stamp.getTime();
      if (Number.isFinite(at)) return at;
    } else if (typeof stamp === 'string') {
      const at = Date.parse(stamp);
      if (Number.isFinite(at)) return at;
    }
  }
  return Number.NaN;
}

/**
 * Turn one fetched message into something the classifier can read — or say it
 * cannot be placed in time.
 *
 * 🔴 `unplaceable` IS NOT "NOT THERE". A message we cannot timestamp used to
 * become epoch, fail the lower bound, and disappear with no trace in `skipped`
 * or anywhere else: a real bounce lost for a timekeeping reason, reported as a
 * clean mailbox. Split out from the fetch loop so it can be tested — the loop
 * itself needs a server.
 */
export function toBounceEmail(msg: {
  internalDate?: string | Date;
  envelope?: { date?: string | Date; subject?: string; from?: unknown };
  source?: Buffer;
}): BounceEmail | { unplaceable: true } {
  const at = arrivalTime(msg);
  if (!Number.isFinite(at)) return { unplaceable: true };
  return {
    from: addressOf(msg.envelope?.from) || AMAZON_NOTIFY,
    subject: msg.envelope?.subject ?? '',
    body: extractText(msg.source ? msg.source.toString('binary') : ''),
    receivedAt: new Date(at).toISOString(),
  };
}

function addressOf(from: unknown): string {
  const first = Array.isArray(from) ? (from[0] as { address?: string } | undefined) : undefined;
  return first?.address ?? '';
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Pull readable text out of a raw MIME message.
 *
 * ── 🔴 WHY THE RAW SOURCE IS NOT PASSED STRAIGHT TO THE CLASSIFIER ───────────
 *
 * It nearly was, on the reasoning that a regex for `E\d{3} - ...` will find its
 * match anywhere in the bytes. **Quoted-printable breaks that and does it
 * silently:** a soft line break can land mid-token as `E014 =\r\n- Unapproved`,
 * the code regex misses, and the verdict degrades from `E014` to `UNKNOWN` — a
 * failure still reported, but with the one piece of information the person needs
 * in order to act stripped out of it.
 *
 * Exported for its own tests. The proof that it handles the REAL artefact is not
 * a fixture: it is the live control in `kindle-verify.ts`, which pins the code it
 * must extract from an actual Amazon notice on the server.
 */
export function extractText(raw: string): string {
  if (!raw) return '';
  const parts = splitParts(raw);
  const plain = parts.find((p) => /text\/plain/i.test(p.headers));
  /**
   * ⚠️ NOT `parts[0]` — for any multipart message that is the PREAMBLE ("This is
   * a multipart message in MIME format."), which is the one part guaranteed to
   * contain nothing. Fall back to the last part carrying a content type at all,
   * then to the raw source.
   */
  const chosen =
    plain ??
    parts.find((p) => /text\/html/i.test(p.headers)) ??
    [...parts].reverse().find((p) => /content-type:/i.test(p.headers)) ??
    parts[parts.length - 1];
  if (!chosen) return raw;
  let text = decodeBody(chosen.headers, chosen.body);
  if (!plain) text = text.replace(/<[^>]+>/g, ' ');
  return text.replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ');
}

interface MimePart {
  headers: string;
  body: string;
}

function splitParts(raw: string): MimePart[] {
  const headerEnd = raw.search(/\r?\n\r?\n/);
  if (headerEnd < 0) return [{ headers: '', body: raw }];
  const headers = raw.slice(0, headerEnd);
  const body = raw.slice(headerEnd).replace(/^\r?\n\r?\n/, '');
  // Anchored on whitespace as well as `;` — `unfold()` joins folded headers with
  // a space, so `[^";\r\n]+` would swallow the NEXT parameter into the boundary
  // and then split on nothing, returning the whole undecoded body.
  const m = /boundary=(?:"([^"]+)"|([^\s";]+))/i.exec(unfold(headers));
  const boundary = m?.[1] ?? m?.[2];
  if (!boundary) return [{ headers, body }];

  const out: MimePart[] = [];
  for (const chunk of body.split(`--${boundary}`)) {
    const trimmed = chunk.replace(/^\r?\n/, '');
    if (!trimmed || /^--/.test(trimmed)) continue;
    // A part may itself be multipart (Amazon's notices are
    // multipart/alternative inside multipart/mixed), so recurse.
    const nested = splitParts(trimmed);
    out.push(...nested);
  }
  return out.length > 0 ? out : [{ headers, body }];
}

/** RFC 5322 folded headers: a continuation line starts with whitespace. */
function unfold(headers: string): string {
  return headers.replace(/\r?\n[ \t]+/g, ' ');
}

function decodeBody(headers: string, body: string): string {
  const enc = /content-transfer-encoding:\s*([\w-]+)/i.exec(unfold(headers))?.[1]?.toLowerCase();
  if (enc === 'base64') {
    try {
      return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
    } catch {
      return body;
    }
  }
  if (enc === 'quoted-printable') return decodeQuotedPrintable(body);
  return body;
}

function decodeQuotedPrintable(input: string): string {
  // 🔴 `=\r\n` is not the only soft break. RFC 2045 explicitly permits transport
  // padding — `=  \r\n` — and a relay that adds a space defeats a bare `=\r?\n`,
  // leaving `E014 = \n- Unapproved` and degrading the code to UNKNOWN. That is
  // the exact defect this decoder exists to prevent, one space to the left.
  const joined = input.replace(/=[ \t]*\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i += 1) {
    const ch = joined[i]!;
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(ch.charCodeAt(0) & 0xff);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}
