/**
 * Pure parsing for IRC #ebooks. No sockets, no state, no I/O.
 *
 * Split out from the client so the grammar — which is where the surprises live —
 * can be tested against real captured lines without opening a connection.
 *
 * Every string here was taken from a live session on 2026-08-26. See
 * `spaces/jedd-v2/knowledge/irc-ebooks-dcc-measured.md`.
 */

/** Formats worth offering. Deliberately narrow — see `EXCLUDED_NOTE`. */
export const SENDABLE_EXTENSIONS = ['.epub', '.azw3', '.pdf'] as const;

/**
 * 🔴 `.rar` AND `.zip` ARE DECLINED ON PURPOSE, NOT UNIMPLEMENTED.
 *
 * Many bots ship books inside archives. Supporting them needs `unrar` — a **new
 * system binary, executing archives supplied by strangers**, which is precisely
 * the surface this whole feature is supposed to be careful about.
 *
 * The measured cost of declining is near zero: one search for one novel returned
 * **ten plain `.epub` offers** alongside the archives. The cheapest security fix
 * is the capability you decline to build.
 *
 * ⚠️ It also removes a foot-gun: the same search returned audiobook `.zip` files
 * of **794 MB and 826 MB** — correctly labelled, genuinely what they say they
 * are, and catastrophically wrong for someone who asked to *read* a book.
 */
const ARCHIVE_EXTENSIONS = ['.rar', '.zip', '.7z', '.tar', '.gz'];

/** `.mobi` is parsed and kept so it can be REFUSED with a reason, not ignored. */
const DEAD_EXTENSIONS = ['.mobi'];

export interface IrcResult {
  /** The bot that must be in the channel for this to be fetchable. */
  bot: string;
  /**
   * The EXACT line to send to the channel. Never reconstructed from parts —
   * whatever preceded `::` is what the bot expects to see back.
   */
  command: string;
  /** Human label: the filename portion, best effort. */
  title: string;
  /** Lowercased extension including the dot, e.g. `.epub`. */
  ext: string;
  /** Bytes, or undefined when the line carried no size at all. */
  sizeBytes?: number;
}

export interface ParsedResults {
  results: IrcResult[];
  /** Lines that looked like offers but used a grammar we do not trust. */
  unparsed: number;
  /** Offers dropped for being an archive or a dead format. */
  filtered: number;
}

/**
 * Parse the `.txt` inside SearchBot's results zip.
 *
 * ── 🔴 THE OLD PROTOCOL NOTE IS WRONG AND WOULD CORRUPT REQUESTS ────────────
 *
 * `spaces/general/knowledge/research.md` said every line is
 * `!BotName hash | Filename.epub ::INFO:: size` and to split on `::INFO::`. Both
 * studied reference implementations do `line.split("::")[0]`. **Measured: that
 * is one of at least three grammars.** From a single search:
 *
 *   !Bsk Project Hail Mary - Andy Weir.epub ::INFO:: 2.5MB        <- documented
 *   !Dumbledore Andy Weir - Project Hail Mary (Retail).epub       <- NO ::INFO::
 *   !Ook ... (epub).rar  ::INFO:: 9MB ::HASH:: 3e5ffb77a1195ac4   <- third field
 *   !Ashurbanipal ihdfQ...MQ - Andy Weir - ... (EPUB) 2.5 MB - [Science Fiction, ...]
 *
 * The last one has no `::` markers at all, so `split("::")[0]` returns the whole
 * line **including the trailing `[genre]` tags** and sends that as the request.
 *
 * 🔴 **So an unrecognised grammar is SKIPPED AND COUNTED, never guessed at.** A
 * malformed request to a bot produces no reply and no error — indistinguishable
 * from a bot that is simply slow. Guessing here would manufacture exactly the
 * silent failure this feature is trying to eliminate.
 */
export function parseSearchResults(text: string): ParsedResults {
  const results: IrcResult[] = [];
  let unparsed = 0;
  let filtered = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('!')) continue; // header/blurb lines

    // The request is everything before the first `::` marker, whatever the
    // marker turns out to be (`::INFO::`, `::HASH::`, or one we have not seen).
    const markerAt = line.indexOf('::');
    const command = (markerAt >= 0 ? line.slice(0, markerAt) : line).trim();

    const bot = command.slice(1).split(/\s+/)[0] ?? '';
    if (!bot) {
      unparsed += 1;
      continue;
    }

    const ext = extensionOf(command);
    if (!ext) {
      // A command that does not end in a file extension is a grammar we do not
      // understand (the Ashurbanipal shape). Skip it rather than send it.
      unparsed += 1;
      continue;
    }

    if (ARCHIVE_EXTENSIONS.includes(ext) || DEAD_EXTENSIONS.includes(ext)) {
      filtered += 1;
      continue;
    }
    if (!(SENDABLE_EXTENSIONS as readonly string[]).includes(ext)) {
      filtered += 1;
      continue;
    }

    const sizeBytes = markerAt >= 0 ? parseSize(line.slice(markerAt)) : undefined;
    results.push({
      bot,
      command,
      title: titleOf(command),
      ext,
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
    });
  }

  return { results, unparsed, filtered };
}

/**
 * The trailing extension of a request command, or null.
 *
 * Matched at the END of the command only. A title like `Project Hail Mary
 * (epub).rar` contains `.epub`-ish text in the middle and IS a rar; taking the
 * last match would have offered an archive as a book.
 */
function extensionOf(command: string): string | null {
  const m = command.toLowerCase().match(/(\.[a-z0-9]{2,4})$/);
  return m ? m[1]! : null;
}

/** Everything after the bot token, with a leading `hash |` or `%HEX%` dropped. */
function titleOf(command: string): string {
  const afterBot = command.replace(/^!\S+\s*/, '');
  return afterBot
    .replace(/^[0-9a-f]{8,}\s*\|\s*/i, '')
    .replace(/^%[0-9A-F]+%\s*/i, '')
    .trim();
}

/**
 * Sizes come in every spelling the bots' authors felt like: `2.5MB`,
 * `9.80 MB`, `4.82 MiB`, `654.35KB`, `826.00MB`.
 *
 * ⚠️ Returns undefined rather than 0 when there is no size. **A missing size is
 * not a small file** — reporting 0 would let an 800 MB audiobook through a
 * size cap as though it were empty.
 */
export function parseSize(s: string): number | undefined {
  const m = s.match(/([\d.]+)\s*(K|M|G)i?B/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const mult = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2]!.toLowerCase()] ?? 1;
  return Math.round(n * mult);
}

export type DccOffer =
  | { state: 'ok'; filename: string; ip: string; port: number; size: number }
  | { state: 'passive'; filename: string; detail: string }
  | { state: 'unparsed'; detail: string };

/**
 * Parse a `DCC SEND` out of a PRIVMSG body.
 *
 * Both forms occur **in a single session**, so both are handled:
 *   \x01DCC SEND SearchOok_results_for__x.txt.zip 1544780096 2050 1152\x01
 *   \x01DCC SEND "Project Hail Mary - Andy Weir.epub" 2985527812 10056 2622079\x01
 *
 * 🔴 `port === 0` means **reverse/passive DCC**, where the sender expects US to
 * listen and it dials in. Never observed from SearchOok or Bsk, but it is
 * reported as its own state rather than attempted: connecting to port 0 hangs,
 * and a hang here reads to the user as "still downloading" forever.
 */
export function parseDccSend(msg: string): DccOffer {
  const clean = msg.replace(/\x01/g, '').trim();
  if (!clean.includes('DCC SEND')) return { state: 'unparsed', detail: 'not a DCC SEND' };

  const quoted = clean.match(/DCC SEND\s+"(.+?)"\s+(\d+)\s+(\d+)\s+(\d+)/);
  const bare = clean.match(/DCC SEND\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)/);
  const m = quoted ?? bare;
  if (!m) return { state: 'unparsed', detail: `could not read "${clean.slice(0, 120)}"` };

  const filename = m[1]!;
  const port = Number(m[3]);
  const size = Number(m[4]);
  if (port === 0) {
    return {
      state: 'passive',
      filename,
      detail:
        'the bot offered a reverse (passive) DCC, which needs us to accept an incoming ' +
        'connection. That is not supported here.',
    };
  }
  return { state: 'ok', filename, ip: intToIp(Number(m[2])), port, size };
}

/** DCC carries the IP as a 32-bit integer, most significant byte first. */
export function intToIp(n: number): string {
  return [24, 16, 8, 0].map((shift) => (n >>> shift) & 255).join('.');
}

/**
 * Strip the IRC nick prefixes (`@`, `+`, `~`, `&`, `%`) an ops list carries, so
 * a roster entry can be compared with a bot name from a search result.
 */
export function bareNick(nick: string): string {
  return nick.replace(/^[@+~&%]+/, '');
}
