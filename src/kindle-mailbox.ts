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

export type MailboxRead =
  | { ok: true; emails: BounceEmail[]; folders: string[] }
  /** Could not look. **NOT** "looked and found nothing." */
  | { ok: false; reason: string };

/**
 * Read Amazon's Kindle notices received in `[since, until]`.
 *
 * Injectable so the verifier can be driven from fixtures, from a deliberately
 * broken reader, and from the real IMAP server without changing a line.
 */
export type MailboxReader = (since: Date, until?: Date) => Promise<MailboxRead>;

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
const WANTED_SPECIAL_USE = ['\\All', '\\Junk', '\\Trash'] as const;

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
  return async (since, until) => {
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

    const emails: BounceEmail[] = [];
    const folders: string[] = [];
    try {
      await withTimeout(client.connect(), timeoutMs, 'IMAP connect');
      const boxes = await client.list();
      const paths = ['INBOX'];
      for (const box of boxes) {
        const use = (box as { specialUse?: string }).specialUse;
        if (use && (WANTED_SPECIAL_USE as readonly string[]).includes(use)) paths.push(box.path);
      }

      /**
       * 🔴 IMAP `SINCE` HAS DAY GRANULARITY, SO IT IS WIDENED BY A DAY AND THE
       * REAL BOUND IS APPLIED IN CODE.
       *
       * A same-day send compared against a date-only server-side filter is
       * exactly the off-by-one that turns a real bounce into "no results" —
       * the shape of the himalaya `after <D>` defect. Over-fetch, then filter
       * precisely on the timestamp we actually have.
       */
      const searchSince = new Date(since.getTime() - 24 * 60 * 60 * 1000);

      for (const path of paths) {
        let lock;
        try {
          lock = await client.getMailboxLock(path);
        } catch {
          // A folder that cannot be opened is not an empty folder. Recording it
          // as unsearched is what stops `folders` being read as full coverage.
          continue;
        }
        try {
          folders.push(path);
          for await (const msg of client.fetch(
            { from: AMAZON_NOTIFY, since: searchSince },
            { envelope: true, source: true },
          )) {
            const receivedAt = (msg.envelope?.date ?? new Date(0)).toISOString();
            emails.push({
              from: addressOf(msg.envelope?.from) || AMAZON_NOTIFY,
              subject: msg.envelope?.subject ?? '',
              body: extractText(msg.source ? msg.source.toString('binary') : ''),
              receivedAt,
            });
          }
        } finally {
          lock.release();
        }
      }
    } catch (e) {
      return { ok: false, reason: `${(e as Error).message ?? String(e)}`.slice(0, 200) };
    } finally {
      try {
        await client.logout();
      } catch {
        /* the read already happened; a failed logout must not void it */
      }
    }

    if (folders.length === 0) {
      return { ok: false, reason: 'no mail folders could be opened, so nothing was searched' };
    }
    const upper = until?.getTime() ?? Number.POSITIVE_INFINITY;
    return {
      ok: true,
      folders,
      emails: emails.filter((e) => {
        const at = Date.parse(e.receivedAt);
        return Number.isFinite(at) && at >= since.getTime() && at <= upper;
      }),
    };
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
  const chosen = plain ?? parts.find((p) => /text\/html/i.test(p.headers)) ?? parts[0];
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
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(unfold(headers))?.[1];
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
  const joined = input.replace(/=\r?\n/g, '');
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
