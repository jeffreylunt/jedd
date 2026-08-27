import { connect as netConnect } from 'node:net';
import { bareNick, parseDccSend, parseSearchResults, type IrcResult } from './irc-protocol.js';
import { unzipSingleTextEntry } from './irc-unzip.js';

/**
 * A long-lived IRC client for `#ebooks`, and the DCC transfers it produces.
 *
 * ── 🔴 WHY THIS LIVES IN-PROCESS, WHICH IS THE RISKY CHOICE ─────────────────
 *
 * `irc.irchighway.net` refuses `JOIN #ebooks` for roughly **65 seconds** after
 * connect. Measured twice: 67.2s and 66.7s to a completed join. That cost is
 * **per connection, not per request** — a warm connection answers a search in
 * 13-18s, a cold one in ~85s. Spawning a process per fetch would pay the 65s
 * every single time and put every first search outside any sane turn budget.
 *
 * So the connection is kept, and the price of keeping it is that this module
 * runs inside the same process as the agent loop — which under pm2 means **a
 * throw from here could restart Jedd, and a restart deploys the working tree.**
 *
 * ── 🔴 THEREFORE: NOTHING ESCAPES THIS MODULE ───────────────────────────────
 *
 * Every public method returns a state. None of them throws, none of them
 * rejects. Socket errors, malformed lines, mid-transfer disconnects, unparseable
 * archives and timeouts are all converted at the boundary by `guard()`.
 *
 * **This is asserted, not asserted-to.** `test/irc-sandbox.test.ts` removes the
 * boundary catch and proves the tests redden; a sandbox that has never been hit
 * is a claim, not a property.
 *
 * ── BEING A GUEST ───────────────────────────────────────────────────────────
 *
 * We are a guest in someone else's channel. Stable nick, identifiably a client,
 * no NickServ registration, and no nick cycling — **if ops throttle or ban us
 * that is a stop-and-report, never something to route around.**
 *
 * A dropped connection reconnects on its own with exponential backoff (30s
 * doubling to a 15-minute cap, reset on a successful join), so recovery does not
 * happen inside some user's turn — a cold join costs ~70s and the first person
 * to ask after a drop would otherwise pay all of it.
 *
 * 🔴 **A refusal by channel ops is NOT reconnected against.** A ban or throttle
 * is a decision a person made; retrying it politely is still evading it. See
 * `refusedByOps`.
 *
 * ── 🔴 ONE CONNECTION, ONE OPERATION AT A TIME ──────────────────────────────
 *
 * This object is SHARED by every user. There is one channel, one nick, and one
 * stream of incoming DCC offers, and an offer does not identify which request it
 * answers beyond who sent it. An earlier version kept a single `pending` slot
 * and installed into it unconditionally: two users searching at once meant the
 * second overwrote the first, and **the arriving book was handed to whoever held
 * the slot** — one person receiving another person's book, which is the same
 * class of failure as the fabricated-address incident, reached through the
 * payload instead of the address.
 *
 * So operations are SERIALISED and CORRELATED: one at a time, and an offer is
 * only accepted from the bot the live request actually asked.
 */

export interface IrcSocketLike {
  write(data: string | Buffer): void;
  destroy(): void;
  on(event: string, cb: (...args: never[]) => void): void;
}

/** Injected so tests can drive the protocol without a network. */
export type Dialer = (host: string, port: number, onConnect: () => void) => IrcSocketLike;

export interface IrcOptions {
  host?: string;
  port?: number;
  channel?: string;
  nick?: string;
  /** How long the server makes us wait before it will accept the JOIN. */
  joinDelayMs?: number;
  /**
   * How long to wait for a search SearchBot has told us NOTHING about.
   *
   * 🔴 MEASURED, AND THE FIRST VALUE WAS TOO TIGHT. Live latencies for a
   * `@search` reply: 17.6s, 25.4s, ~34s, **47.0s, 60.9s**. The original 45s cap
   * timed out BOTH queries in the run that found this, reporting "the search bot
   * did not answer" when the bot was simply slower than the cap — a
   * self-inflicted false negative that would have made IRC look useless.
   *
   * ⚠️ This is now the SILENT ceiling only. Once the bot has said anything at
   * all about this query it is superseded by `searchSpokenTimeoutMs` — see
   * `onSearchNotice`. It is deliberately left at the value the old blind cap
   * used, because every search that succeeds today succeeds inside it: lowering
   * it would be a regression bought with no evidence, and the fast paths that
   * matter now end on a NOTICE rather than on this timer.
   */
  searchTimeoutMs?: number;
  /**
   * How long to wait once SearchBot has CONFIRMED it is working on this query.
   *
   * 🔴 THIS IS PATIENCE GRANTED ON EVIDENCE, NOT A BIGGER GUESS. It only ever
   * applies after an `accepted` or `returned N matches` notice — i.e. after the
   * bot has said, in its own words, that a file is coming. A search that is
   * merely slow is a different thing from a search nobody is running, and only
   * the first one deserves more of somebody's turn.
   *
   * ⚠️ Unlike the number it replaces, this one is NOT a measured latency — the
   * slowest reply ever observed here is 60.9s. It is a bound on how long we are
   * willing to hold a turn open for work we know is in progress. It stays finite
   * on purpose: an unbounded wait would hang the turn, and a hung turn and a
   * message that never arrived are indistinguishable to the person waiting.
   */
  searchSpokenTimeoutMs?: number;
  /** How long to wait for a book bot to answer at all. */
  offerTimeoutMs?: number;
  /** Hard cap on a DCC transfer, enforced while reading, not from the offer. */
  maxBytes?: number;
  /**
   * How long to wait for the JOIN to be confirmed before declaring the
   * connection unusable. Must exceed `joinDelayMs`, since the wait is the
   * server's, not ours.
   */
  connectTimeoutMs?: number;
  /** Deadline on a single DCC transfer once it has started. */
  transferTimeoutMs?: number;
  /** First reconnect delay; doubles per attempt up to a 15-minute cap. */
  reconnectBaseMs?: number;
  dial?: Dialer;
  now?: () => number;
  log?: (msg: string) => void;
}

const DEFAULTS = {
  host: 'irc.irchighway.net',
  port: 6667,
  channel: '#ebooks',
  nick: 'jeddbot',
  joinDelayMs: 70_000,
  searchTimeoutMs: 90_000,
  searchSpokenTimeoutMs: 180_000,
  offerTimeoutMs: 8 * 60_000,
  maxBytes: 25 * 1024 * 1024,
  connectTimeoutMs: 110_000,
  transferTimeoutMs: 5 * 60_000,
  reconnectBaseMs: 30_000,
};

export type IrcSearchOutcome =
  | { state: 'ok'; results: IrcResult[]; detail: string }
  | { state: 'none'; detail: string }
  | { state: 'unknown'; detail: string };

export type IrcFetchOutcome =
  | { state: 'ok'; filename: string; bytes: Buffer; detail: string }
  | { state: 'failed'; detail: string }
  | { state: 'unknown'; detail: string };

/**
 * How a wait ended, when the ending was something other than "a file arrived"
 * or "our timer ran out".
 *
 * 🔴 `no-matches` IS THE ONE THAT CHANGES AN ANSWER. It is SearchBot stating a
 * finding — it looked, and there is nothing — which is `none`. Every other way
 * a search can end without a file is a failure to LOOK, which is `unknown`.
 * Collapsing the two is the two-zeros error this module guards everywhere else.
 */
type SearchVerdict = 'no-matches' | 'denied';

interface PendingTransfer {
  /** Distinguishes one caller's slot from another's, so a timer clears only its own. */
  id: number;
  /** 'search' accepts the results zip from whichever nick SearchBot runs under. */
  kind: 'search' | 'fetch';
  /** For 'fetch': the ONLY nick whose offer may be accepted, lowercased. */
  bot: string | null;
  /**
   * For 'search': the query AS SENT, so a notice quoting it back can be checked
   * against it. Not the caller's raw string — `sanitise` may have changed it,
   * and the bot echoes what it received.
   */
  query: string | null;
  /** Set once the bot has spoken about this query, so patience is only extended once. */
  spoken: boolean;
  /** When the wait began, so a re-armed deadline stays absolute rather than compounding. */
  startedAt: number;
  resolve: (b: { filename: string; bytes: Buffer } | null, detail: string, verdict?: SearchVerdict) => void;
  /**
   * Move this slot's deadline to `totalMs` after it STARTED.
   *
   * 🔴 ABSOLUTE, NOT ADDITIVE. A bot that sends three notices must not buy three
   * extensions — that is how a bounded wait quietly becomes an unbounded one at
   * the mercy of a stranger's message rate.
   */
  rearm: (totalMs: number) => void;
}

export class IrcEbooks {
  private readonly o: Required<Omit<IrcOptions, 'dial' | 'now' | 'log'>> & {
    dial: Dialer;
    now: () => number;
    log: (m: string) => void;
  };
  private sock: IrcSocketLike | null = null;
  private buf = '';
  private roster = new Set<string>();
  private joined = false;
  private registered = false;
  private connecting: Promise<boolean> | null = null;
  private lastError = '';
  private pending: PendingTransfer | null = null;
  private nextPendingId = 1;
  private nickSuffix = 0;
  /** Live DCC sockets, so `stop()` can actually close a stalled transfer. */
  private transfers = new Set<IrcSocketLike>();
  private stopped = false;
  /**
   * 🔴 SET WHEN CHANNEL OPS REFUSE US. SUPPRESSES RECONNECT PERMANENTLY.
   *
   * A ban, a throttle or a +i/+k refusal is an ACCESS DECISION BY A PERSON.
   * Reconnecting against it — even politely, even slowly — is evading a limit
   * somebody set deliberately, which is exactly what "no nick-cycling to evade a
   * throttle" rules out. It stops and it gets reported.
   */
  private refusedByOps = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: IrcOptions = {}) {
    this.o = {
      host: opts.host ?? DEFAULTS.host,
      port: opts.port ?? DEFAULTS.port,
      channel: opts.channel ?? DEFAULTS.channel,
      nick: opts.nick ?? DEFAULTS.nick,
      joinDelayMs: opts.joinDelayMs ?? DEFAULTS.joinDelayMs,
      searchTimeoutMs: opts.searchTimeoutMs ?? DEFAULTS.searchTimeoutMs,
      searchSpokenTimeoutMs: opts.searchSpokenTimeoutMs ?? DEFAULTS.searchSpokenTimeoutMs,
      offerTimeoutMs: opts.offerTimeoutMs ?? DEFAULTS.offerTimeoutMs,
      maxBytes: opts.maxBytes ?? DEFAULTS.maxBytes,
      connectTimeoutMs: opts.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs,
      transferTimeoutMs: opts.transferTimeoutMs ?? DEFAULTS.transferTimeoutMs,
      reconnectBaseMs: opts.reconnectBaseMs ?? DEFAULTS.reconnectBaseMs,
      dial: opts.dial ?? defaultDial,
      now: opts.now ?? Date.now,
      log: opts.log ?? (() => {}),
    };
  }

  /**
   * 🔴 THE BOUNDARY. Everything public goes through here.
   *
   * Removing this catch is the mutation `test/irc-sandbox.test.ts` performs: if
   * the suite still passes without it, the sandbox was never doing anything.
   */
  private async guard<T>(what: string, fn: () => Promise<T>, onFail: (detail: string) => T): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const detail = `${what} failed: ${(e as Error)?.message ?? String(e)}`;
      this.lastError = detail;
      this.o.log(`[irc] ${detail}`);
      return onFail(detail);
    }
  }

  status(): { connected: boolean; joined: boolean; detail: string } {
    return {
      connected: this.sock !== null && this.registered,
      joined: this.joined,
      detail: this.joined
        ? `connected to ${this.o.host} and in ${this.o.channel} (${this.roster.size} nicks)`
        : this.lastError || 'not connected',
    };
  }

  /** Is this bot actually in the channel right now? */
  rosterHas(bot: string): boolean {
    return this.roster.has(bot.toLowerCase());
  }

  /** Snapshot for callers that want to filter a result list. */
  rosterSize(): number {
    return this.roster.size;
  }

  async connect(): Promise<boolean> {
    if (this.stopped) return false;
    if (this.joined) return true;
    if (this.connecting) return this.connecting;
    this.connecting = this.guard(
      'connect',
      () => this.doConnect(),
      () => false,
    ).finally(() => {
      this.connecting = null;
    }) as Promise<boolean>;
    return this.connecting;
  }

  private doConnect(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (v: boolean, why: string) => {
        if (settled) return;
        settled = true;
        /**
         * 🔴 AN OPS REFUSAL MUST SURVIVE THE DISCONNECT THAT FOLLOWS IT.
         *
         * A ban arrives as `474`, and the server then closes the socket — whose
         * handler used to overwrite `lastError` with "the IRC connection closed
         * before we joined." The refusal was suppressed correctly and the REASON
         * was lost, so `status()` reported a generic network problem and nobody
         * would ever learn we had been banned. Half of "stop and report" is the
         * report.
         */
        if (!v && !this.refusedByOps) this.lastError = why;
        resolve(v);
      };

      const sock = this.o.dial(this.o.host, this.o.port, () => {
        this.send(`NICK ${this.o.nick}`);
        // The trailing field is IRC's "realname"/gecos — cosmetic. Derived from
        // the configured nick rather than hardcoding a bot name, so a second
        // deployment does not announce itself as this one.
        this.send(`USER ${this.o.nick} 0 * :${this.o.nick} ebook fetcher`);
      });
      this.sock = sock;

      sock.on('data', ((chunk: Buffer) => {
        // A parse failure on one line must never kill the connection.
        try {
          this.onData(chunk, () => done(true, ''));
        } catch (e) {
          this.o.log(`[irc] line handling failed: ${(e as Error).message}`);
        }
      }) as never);

      /**
       * ⚠️ BOTH HANDLERS CHECK THAT THEY STILL OWN THE CONNECTION.
       *
       * Node emits `error` and then `close` as separate events. Without this
       * guard the sequence was: drop -> `error` -> teardown -> a user searches
       * -> `connect()` builds a NEW socket -> the OLD socket's `close` finally
       * lands -> and it tore down the new connection and failed its in-flight
       * transfer with "the IRC connection closed mid-transfer."
       */
      const stillOurs = () => this.sock === sock;

      sock.on('error', ((e: Error) => {
        this.o.log(`[irc] socket error: ${e?.message}`);
        if (!stillOurs()) return;
        this.failPending(`the IRC connection dropped: ${e?.message}`);
        this.teardown();
        this.scheduleReconnect();
        done(false, `socket error: ${e?.message}`);
      }) as never);

      sock.on('close', (() => {
        if (!stillOurs()) return;
        this.failPending('the IRC connection closed mid-transfer.');
        this.teardown();
        this.scheduleReconnect();
        done(false, 'the IRC connection closed before we joined.');
      }) as never);

      setTimeout(
        () => done(false, `no JOIN confirmation within ${Math.round(this.o.connectTimeoutMs / 1000)}s.`),
        this.o.connectTimeoutMs,
      ).unref?.();
    });
  }

  private onData(chunk: Buffer, onJoined: () => void): void {
    this.buf += chunk.toString('binary');
    // IRC lines are 512 bytes. A peer that never sends a newline would otherwise
    // grow this until the process dies.
    if (this.buf.length > 64 * 1024) {
      this.o.log('[irc] dropping an oversized unterminated line');
      this.buf = '';
      return;
    }
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      this.onLine(line, onJoined);
    }
  }

  private onLine(line: string, onJoined: () => void): void {
    if (line.startsWith('PING')) {
      this.send(`PONG${line.slice(4)}`);
      return;
    }
    const code = line.match(/^:\S+ (\d{3}) /)?.[1];
    if (code === '001') {
      this.registered = true;
      // The server will not accept the JOIN yet. This wait is the reason the
      // connection is kept rather than re-established per request.
      setTimeout(() => this.send(`JOIN ${this.o.channel}`), this.o.joinDelayMs).unref?.();
      return;
    }
    if (code === '353') {
      const names = line.split(' :')[1] ?? '';
      for (const n of names.trim().split(/\s+/)) {
        if (n) this.roster.add(bareNick(n).toLowerCase());
      }
      return;
    }
    if (code === '366') {
      this.joined = true;
      this.reconnectAttempt = 0; // a good connection clears the backoff
      onJoined();
      return;
    }
    /**
     * ⚠️ NICK ALREADY IN USE. Take a variant rather than sit unregistered.
     *
     * A stable nick is polite, but it is not ours to reserve — we do not register
     * with NickServ. Without this the registration never completes and every
     * search reports "IRC is not available" for a reason nothing explains.
     */
    if (code === '433') {
      this.nickSuffix += 1;
      const alt = `${this.o.nick}${this.nickSuffix}`;
      this.o.log(`[irc] nick in use, trying ${alt}`);
      this.send(`NICK ${alt}`);
      return;
    }
    if (code === '474' || code === '473' || code === '475' || code === '471' || code === '465') {
      // Banned / throttled / limited. STOP AND REPORT — never cycle nicks.
      this.refusedByOps = true;
      this.lastError =
        `the server refused the channel (${code}). This is an access decision by channel ops ` +
        'and must be reported, not worked around. No reconnect will be attempted.';
      this.o.log(`[irc] ${this.lastError}`);
      return;
    }
    // JOIN/PART/QUIT keep the roster honest while we stay connected.
    const ev = line.match(/^:(\S+?)!\S+ (JOIN|PART|QUIT)/);
    if (ev) {
      const nick = bareNick(ev[1]!).toLowerCase();
      if (ev[2] === 'JOIN') this.roster.add(nick);
      else this.roster.delete(nick);
      return;
    }
    // A KICKed bot is gone too. Missing this left it "present", which defeats
    // the very refusal the roster exists to produce.
    const kicked = line.match(/^:\S+ KICK \S+ (\S+)/);
    if (kicked) {
      this.roster.delete(bareNick(kicked[1]!).toLowerCase());
      return;
    }

    /**
     * 🔴 SEARCHBOT ANSWERS ON A CHANNEL THIS MODULE USED TO BE DEAF TO.
     *
     * Everything below this point reads PRIVMSG and looks for `DCC SEND`. That
     * was the ONLY thing a search could hear — and it is the LAST of four
     * signals the bot actually emits. Measured live, 2026-08-27, two searches on
     * one connection:
     *
     *   "The Hobbit Tolkien"   +3.5s accepted -> +12.5s "returned 178 matches,
     *                          sending results" -> +15.6s DCC SEND
     *   "Vengeance Is Mine …"  +5.5s accepted -> +8.5s "returned NO MATCHES"
     *                          -> no DCC, ever
     *
     * The second is the shape Jeff hit. The bot answered him in 8.5 seconds, in
     * plain words, and Jedd — able to hear only a file that was never coming —
     * sat out its full 90s cap and reported **"the search bot did not answer"**
     * about a bot that had answered promptly and definitively. It then offered a
     * retry, because the report said UNKNOWN when the truth was NONE.
     *
     * ⚠️ THIS IS WHY THE TIMEOUT WAS THE WRONG SUSPECT. The wait was not shorter
     * than the phenomenon — the phenomenon had finished, on a channel nothing
     * was listening to. Raising the cap, which is the obvious reading of "let it
     * wait longer", would have made Jeff wait THREE MINUTES for the same wrong
     * answer. A detector that cannot observe the outcome always reports absence.
     */
    const nt = line.match(/^:(\S+?)!\S+ NOTICE (\S+) :(.*)$/);
    if (nt) {
      this.onSearchNotice(bareNick(nt[1] ?? ''), stripFormatting(nt[3] ?? ''));
      return;
    }

    const pm = line.match(/^:(\S+?)!\S+ PRIVMSG (\S+) :(.*)$/);
    if (!pm) return;
    const from = bareNick(pm[1] ?? '').toLowerCase();
    const body = pm[3] ?? '';
    if (!body.includes('DCC SEND')) return;

    /**
     * 🔴 AN OFFER IS ONLY ACCEPTED IF IT ANSWERS A LIVE REQUEST.
     *
     * `#ebooks` had 603 members when measured. Without this, ANY of them could
     * PRIVMSG us a DCC SEND and we would dial the address in it — an arbitrary
     * outbound connection driven by a stranger, from inside the agent process —
     * and hand the bytes to whatever transfer happened to be waiting. That is
     * content substitution: the validator would confirm the result is *a* book
     * while saying nothing about it being *the* book that was asked for.
     */
    const waiting = this.pending;
    if (!waiting) {
      this.o.log(`[irc] ignoring an unsolicited DCC offer from ${from}`);
      return;
    }
    if (waiting.kind === 'fetch' && waiting.bot && from !== waiting.bot) {
      this.o.log(`[irc] ignoring a DCC offer from ${from}; we asked ${waiting.bot}`);
      return;
    }

    const offer = parseDccSend(body);
    if (offer.state === 'unparsed') {
      this.o.log(`[irc] unreadable DCC offer: ${offer.detail}`);
      return;
    }
    if (offer.state === 'passive') {
      this.failPending(`${offer.filename}: ${offer.detail}`);
      return;
    }
    void this.receiveDcc(offer.filename, offer.ip, offer.port, offer.size);
  }

  /**
   * Pull a DCC offer down.
   *
   * 🔴 The byte cap is enforced **while reading**, not from the size the offer
   * advertised. A stranger's socket can keep sending after it has delivered what
   * it promised, and the advertised size is the one number we cannot trust.
   */
  private async receiveDcc(filename: string, ip: string, port: number, size: number): Promise<void> {
    if (size > this.o.maxBytes) {
      this.failPending(`"${filename}" is ${size} bytes, over the ${this.o.maxBytes}-byte limit. Refused.`);
      return;
    }
    await this.guard(
      'DCC transfer',
      () =>
        new Promise<void>((resolve) => {
          const chunks: Buffer[] = [];
          let got = 0;
          let settled = false;
          const finish = (ok: boolean, detail: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            this.transfers.delete(d);
            try {
              d.destroy();
            } catch {
              /* already gone */
            }
            if (ok) this.completePending(filename, Buffer.concat(chunks), detail);
            else this.failPending(detail);
            resolve();
          };

          const d = this.o.dial(ip, port, () => {});
          this.transfers.add(d);

          /**
           * ⚠️ A TRANSFER NEEDS ITS OWN DEADLINE.
           *
           * `awaitTransfer`'s timer resolves the CALLER; it does not touch this
           * socket. A peer that connects, sends a few bytes and then goes quiet
           * would otherwise leave the socket and its buffered chunks alive
           * forever — and if it ever completed, it would hand its bytes to
           * whichever request held the slot by then.
           */
          const timer = setTimeout(
            () => finish(false, `"${filename}" stalled and was abandoned.`),
            this.o.transferTimeoutMs,
          );
          timer.unref?.();

          /**
           * 🔴 THESE HANDLERS ARE OUTSIDE `guard()` BY CONSTRUCTION.
           *
           * `guard()` wraps an awaited call; by the time an event fires, the
           * promise executor has returned and there is no caller on the stack.
           * An escape here is an UNCAUGHT EXCEPTION, and under pm2 that restarts
           * Jedd and deploys the working tree. So each one carries its own
           * catch, the same way the IRC data handler does.
           */
          const safely = (fn: () => void) => {
            try {
              fn();
            } catch (e) {
              this.o.log(`[irc] DCC handler failed: ${(e as Error)?.message}`);
              finish(false, `the transfer of "${filename}" failed unexpectedly.`);
            }
          };

          d.on('data', ((c: Buffer) =>
            safely(() => {
              chunks.push(c);
              got += c.length;
              if (got > this.o.maxBytes) {
                finish(false, `"${filename}" exceeded the ${this.o.maxBytes}-byte limit mid-transfer. Aborted.`);
                return;
              }
              const ack = Buffer.alloc(4);
              ack.writeUInt32BE(got >>> 0, 0);
              try {
                d.write(ack);
              } catch {
                /* the far end may already be gone; the bytes still count */
              }
            })) as never);
          d.on('error', ((e: Error) =>
            safely(() => finish(false, `the transfer of "${filename}" failed: ${e?.message}`))) as never);
          d.on('close', (() =>
            safely(() => {
              if (got === 0) finish(false, `"${filename}" closed with no data.`);
              else if (got < size) {
                finish(false, `"${filename}" stopped at ${got} of ${size} bytes — incomplete, so it was discarded.`);
              } else finish(true, `received ${got} bytes`);
            })) as never);
        }),
      () => undefined,
    );
  }

  /**
   * Act on what SearchBot said about the search we are currently waiting on.
   *
   * ── WHY EVERY BRANCH CHECKS THE QUOTED QUERY ────────────────────────────────
   *
   * The same reason the results header is checked in `search()`: this module has
   * already been burned once by acting on somebody else's search. SearchBot
   * quotes the query verbatim in all four notices, so the check is free, and a
   * notice about a different query tells us nothing about ours — it is IGNORED
   * rather than treated as an outcome, and our own deadline still governs.
   *
   * ── ⚠️ AN UNRECOGNISED NOTICE CHANGES NOTHING, ON PURPOSE ───────────────────
   *
   * Only wordings MEASURED against the live bot are matched here. A notice this
   * does not recognise is logged and otherwise ignored, so the old timeout
   * remains the backstop for anything the bot says that we have not seen. The
   * log line is there so the next person has a real sample to add rather than a
   * regex somebody guessed.
   */
  private onSearchNotice(from: string, body: string): void {
    const p = this.pending;
    if (!p || p.kind !== 'search' || !p.query) return;

    const quoted = body.match(/your search for\s+"([^"]*)"/i)?.[1];
    const said = (what: RegExp) => what.test(body);

    /**
     * 🔴 "SEARCH DENIED" IS THE ONE THAT NAMES A WOUND WE INFLICT ON OURSELVES.
     *
     * Measured live: after a results file was offered and never collected, EVERY
     * later search from that nick came back *"Search results already waiting to
     * be recieved. Search denied."* (the bot's own spelling), within 4s, forever.
     *
     * ⚠️ Jedd CREATES that state. When a search times out, the slot is cleared;
     * the DCC offer then arrives, finds no live request, and is refused as
     * unsolicited — correctly, but the file stays uncollected on the bot's side.
     * So one timed-out search can wedge every subsequent one, and before this
     * branch existed the wedge was SILENT: the denial is a NOTICE, so each
     * later search waited out its full cap and reported "did not answer".
     *
     * It is deliberately not quoted-query-checked: the denial is about the nick's
     * whole state, not about this query, and it names no query at all.
     */
    if (said(/search (?:denied|refused)/i) || said(/already waiting to be reci?eved/i)) {
      this.o.log(`[irc] search denied by ${from}: ${body}`);
      this.settlePending(
        'denied',
        `the #ebooks search bot refused the search: "${body}". This is a REFUSAL, not a finding ` +
          'about the book. It usually means an earlier results file was never collected and is ' +
          'still queued for us on the bot.',
      );
      return;
    }

    if (quoted === undefined || !sameQuery(quoted, p.query)) {
      if (quoted !== undefined) {
        this.o.log(`[irc] ignoring a notice about "${quoted}"; we asked "${p.query}"`);
      }
      return;
    }

    /**
     * 🔴 A FINDING, NOT A FAILURE. The bot looked and there is nothing — which
     * is `none`, and settles the wait NOW rather than at the cap. This is the
     * branch that turns Jeff's 90-second wrong answer into a ~9-second right one.
     */
    if (said(/returned no matches/i)) {
      this.o.log(`[irc] ${from}: no matches for "${p.query}"`);
      this.settlePending(
        'no-matches',
        `the #ebooks search bot searched and found no matches for "${p.query}".`,
      );
      return;
    }

    /**
     * Both remaining wordings mean WORK IS IN PROGRESS, so both buy the same
     * extension — `accepted` (queued) and `returned N matches` (file on its way).
     * Extending once is enough; see `rearm`'s absolute-deadline note.
     */
    if (said(/has been accepted/i) || said(/returned\s+[\d,]+\s+match/i)) {
      if (p.spoken) return;
      p.spoken = true;
      p.rearm(this.o.searchSpokenTimeoutMs);
      this.o.log(
        `[irc] ${from} is working on "${p.query}" — waiting up to ` +
          `${Math.round(this.o.searchSpokenTimeoutMs / 1000)}s for the results file`,
      );
      return;
    }

    this.o.log(`[irc] unrecognised search notice from ${from}: ${body}`);
  }

  /** End the live wait with a verdict the bot stated, rather than with our timer. */
  private settlePending(verdict: SearchVerdict, detail: string): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    p.resolve(null, detail, verdict);
  }

  private completePending(filename: string, bytes: Buffer, detail: string): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    p.resolve({ filename, bytes }, detail);
  }

  private failPending(detail: string): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    p.resolve(null, detail);
  }

  /**
   * Wait for the DCC file that answers THIS request.
   *
   * ⚠️ The timeout clears the slot **only if it is still ours**. An earlier
   * version wrote `if (this.pending) this.pending = null`, so a 45s search
   * expiring would wipe an 8-minute fetch's slot that had been installed after
   * it — the fetch's bytes then arrived, found no slot, and were DROPPED, while
   * the caller waited out its own timeout and reported "nothing arrived" about a
   * file that had in fact arrived.
   */
  private awaitTransfer(
    timeoutMs: number,
    kind: 'search' | 'fetch',
    bot: string | null,
    query: string | null = null,
  ): Promise<{
    file: { filename: string; bytes: Buffer } | null;
    detail: string;
    verdict?: SearchVerdict;
  }> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const startedAt = this.o.now();

      const finish = (
        file: { filename: string; bytes: Buffer } | null,
        detail: string,
        verdict?: SearchVerdict,
      ) => {
        if (settled) return;
        settled = true;
        // 🔴 The deadline must die with the wait. Left running, a re-armed timer
        // outlives its own slot and clears a LATER caller's — the exact stale
        // -timer bug the id check below exists to prevent, reintroduced from the
        // other side.
        if (timer) clearTimeout(timer);
        resolve({ file, detail, ...(verdict ? { verdict } : {}) });
      };

      const arm = (totalMs: number) => {
        if (settled) return;
        if (timer) clearTimeout(timer);
        const left = Math.max(0, totalMs - (this.o.now() - startedAt));
        timer = setTimeout(() => {
          if (this.pending?.id === slot.id) this.pending = null;
          finish(null, `nothing arrived within ${Math.round(totalMs / 1000)}s.`);
        }, left);
        timer.unref?.();
      };

      const slot: PendingTransfer = {
        id: this.nextPendingId++,
        kind,
        bot: bot ? bot.toLowerCase() : null,
        query,
        spoken: false,
        startedAt,
        resolve: finish,
        rearm: arm,
      };
      this.pending = slot;
      arm(timeoutMs);
    });
  }

  /**
   * 🔴 ONE OPERATION AT A TIME, and a second caller is TOLD rather than queued.
   *
   * Queueing behind an 8-minute fetch would leave the second person waiting with
   * no explanation. Refusing is honest, and the follow-up runner already retries
   * on its own schedule — so a busy IRC costs a delay, never a wrong delivery.
   */
  private busy(): boolean {
    return this.pending !== null;
  }

  async search(query: string): Promise<IrcSearchOutcome> {
    return this.guard(
      'search',
      async (): Promise<IrcSearchOutcome> => {
        const up = await this.connect();
        if (!up) return { state: 'unknown', detail: `IRC is not available — ${this.status().detail}` };
        if (this.busy()) {
          return { state: 'unknown', detail: 'the IRC connection is already handling another request.' };
        }

        const sent = sanitise(query);
        const wait = this.awaitTransfer(this.o.searchTimeoutMs, 'search', null, sent);
        this.send(`PRIVMSG ${this.o.channel} :@search ${sent}`);
        const { file, detail, verdict } = await wait;

        /**
         * 🔴 THE BOT'S OWN WORDS OUTRANK OUR TIMER, AND THEY SPLIT THREE WAYS.
         *
         * `no-matches` is the only one that is a FINDING. It is reported as
         * `none` — the caller's contract for "this source was read and has
         * nothing" — which is what stops the model offering a retry for a book
         * the catalogue genuinely does not carry.
         *
         * A denial is a REFUSAL and stays `unknown`: we learned nothing about
         * the book, and saying "no copies" on the strength of it would be a
         * false absence built out of our own uncollected file.
         */
        if (verdict === 'no-matches') return { state: 'none', detail: `IRC found nothing — ${detail}` };
        if (verdict === 'denied') return { state: 'unknown', detail };
        if (!file) return { state: 'unknown', detail: `the #ebooks search bot did not answer — ${detail}` };

        const un = unzipSingleTextEntry(file.bytes);
        if (un.state !== 'ok') return { state: 'unknown', detail: un.detail };

        /**
         * 🔴 THE LISTING MUST ANSWER THE QUERY WE ASKED. MEASURED, LIVE.
         *
         * 2026-08-26: a search for "project hail mary" returned nine EPUBs of
         * **"The Loch" by Steve Alten** — a real, well-formed results file for a
         * completely different query. SearchBot queues searches and DCCs them to
         * the requesting NICK, and we had taken a stable nick that something had
         * a pending search against. Everything downstream was working perfectly;
         * the results simply were not ours.
         *
         * This is the search-direction twin of the bot-nick check on a fetch:
         * "a DCC arrived while we were waiting" is NOT "this DCC answers us".
         * The header states the query verbatim, so it is checkable, and a
         * mismatch is UNKNOWN — we learned nothing about this book — never
         * "none", which would be a false absence built from someone else's
         * search.
         */
        const answered = un.text.match(/for\s+"([^"]*)"/i)?.[1];
        if (answered !== undefined && !sameQuery(answered, query)) {
          return {
            state: 'unknown',
            detail:
              `the #ebooks search bot sent results for "${answered}", not "${query}" — that is ` +
              'somebody else\'s search, so it says nothing about this book. Nothing was used from it.',
          };
        }

        const parsed = parseSearchResults(un.text);
        // Only offer books whose bot is actually here. A request to an absent
        // bot returns no reply and no error — the exact silent failure that
        // reads as "still downloading" forever.
        const present = parsed.results.filter((r) => this.rosterHas(r.bot));
        const absent = parsed.results.length - present.length;

        if (present.length === 0) {
          const why =
            parsed.results.length === 0
              ? 'no usable ebook offers were in the results.'
              : `all ${parsed.results.length} offer(s) came from bots that are not currently in the channel.`;
          return { state: 'none', detail: `IRC found nothing fetchable for "${query}" — ${why}` };
        }

        const notes: string[] = [];
        if (absent) notes.push(`${absent} from bots not currently online`);
        if (parsed.filtered) notes.push(`${parsed.filtered} archives or dead formats`);
        if (parsed.unparsed) notes.push(`${parsed.unparsed} in a listing format we do not parse`);
        return {
          state: 'ok',
          results: present,
          detail: notes.length ? `left out ${notes.join(', ')}` : '',
        };
      },
      (detail) => ({ state: 'unknown', detail }),
    );
  }

  /**
   * Ask a bot for a book and wait for the bytes.
   *
   * The roster check happens FIRST and refuses, because promising a book from a
   * bot that has left is the failure mode with no natural end.
   */
  async fetch(command: string, bot: string): Promise<IrcFetchOutcome> {
    return this.guard(
      'fetch',
      async (): Promise<IrcFetchOutcome> => {
        const up = await this.connect();
        if (!up) return { state: 'unknown', detail: `IRC is not available — ${this.status().detail}` };
        if (!this.rosterHas(bot)) {
          return {
            state: 'failed',
            detail:
              `${bot} is not in #ebooks right now, so the request would go nowhere and no error ` +
              'would ever come back. Nothing was requested.',
          };
        }

        if (this.busy()) {
          return {
            state: 'unknown',
            detail: 'the IRC connection is already handling another request; nothing was requested yet.',
          };
        }
        const wait = this.awaitTransfer(this.o.offerTimeoutMs, 'fetch', bot);
        // 🔴 TO THE CHANNEL, NOT TO THE BOT, and the command VERBATIM.
        this.send(`PRIVMSG ${this.o.channel} :${sanitise(command)}`);
        const { file, detail } = await wait;
        if (!file) {
          return {
            state: 'failed',
            detail: `${bot} never sent the book — ${detail} Nothing arrived, so nothing was sent on.`,
          };
        }
        return { state: 'ok', filename: file.filename, bytes: file.bytes, detail };
      },
      (detail) => ({ state: 'unknown', detail }),
    );
  }

  private send(line: string): void {
    try {
      this.sock?.write(`${line}\r\n`);
    } catch (e) {
      this.o.log(`[irc] write failed: ${(e as Error).message}`);
    }
  }

  /**
   * Re-establish the connection after an unexpected drop, backing off.
   *
   * ⚠️ WITHOUT THIS, RECOVERY HAPPENS INSIDE A USER'S TURN. `connect()` is
   * called lazily by the next `search`/`fetch`, and a cold join costs ~70s — so
   * the first person to ask for a book after any drop pays the whole reconnect
   * out of their own wait. Warming back up in the background is the difference
   * between a slow search and a search that looks broken.
   *
   * 30s, 60s, 120s, 240s, capped at 15 minutes. We are a guest on someone else's
   * server; a tight retry loop is how a client becomes a problem.
   */
  private scheduleReconnect(): void {
    if (this.stopped || this.refusedByOps || this.reconnectTimer) return;
    const delay = Math.min(this.o.reconnectBaseMs * 2 ** this.reconnectAttempt, 15 * 60_000);
    this.reconnectAttempt += 1;
    this.o.log(`[irc] reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped || this.refusedByOps) return;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private teardown(): void {
    this.joined = false;
    this.registered = false;
    this.roster.clear();
    this.sock = null;
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failPending('shutting down.');
    // A stalled DCC socket is not reachable from the IRC socket; close it here
    // or it survives shutdown.
    for (const t of this.transfers) {
      try {
        t.destroy();
      } catch {
        /* already gone */
      }
    }
    this.transfers.clear();
    try {
      this.sock?.write('QUIT :bye\r\n');
      this.sock?.destroy();
    } catch {
      /* nothing to do on the way out */
    }
    this.teardown();
  }
}

/**
 * 🔴 A newline in a query or command would let the caller inject an arbitrary
 * IRC command. Strip CR/LF and cap the length; IRC lines are 512 bytes total.
 */
function sanitise(s: string): string {
  return s.replace(/[\r\n\0]/g, ' ').trim().slice(0, 400);
}

function defaultDial(host: string, port: number, onConnect: () => void): IrcSocketLike {
  const s = netConnect({ host, port }, onConnect);
  s.setTimeout?.(0);
  return s as unknown as IrcSocketLike;
}

/**
 * 🔴 STRIP mIRC FORMATTING BEFORE READING A NOTICE — THE CODES ARE *INSIDE* THE
 * QUOTED QUERY, NOT AROUND IT.
 *
 * The raw notice is, byte for byte:
 *
 *     \x0301,09<<SearchBot>> Your search for "\x0312,09Vengeance Is
 *     Mine\x0301,09" has been accepted. Searching...
 *
 * so a `for "([^"]*)"` capture on the raw line yields `12,09Vengeance Is Mine`
 * — colour digits welded onto the front of the title. `sameQuery` would then
 * reject the bot's answer to OUR OWN QUERY as somebody else's search, and the
 * notice handling would appear to work while silently never firing. Nothing
 * would fail; the search would just go back to timing out, exactly as before.
 */
function stripFormatting(s: string): string {
  return s
    .replace(/\x03\d{0,2}(?:,\d{1,2})?/g, '') // colour, with optional background
    .replace(/\x04[0-9a-fA-F]{6}/g, '') // hex colour
    .replace(/[\x02\x0f\x11\x16\x1d\x1e\x1f]/g, ''); // bold/reset/monospace/reverse/italic/strike/underline
}

/**
 * Loose comparison for the results header, which normalises spacing and case but
 * is otherwise exact. Deliberately not fuzzy: the failure being caught is a
 * COMPLETELY different query, and a fuzzy match would let it through.
 */
function sameQuery(a: string, b: string): boolean {
  const norm = (x: string) => x.trim().toLowerCase().replace(/\s+/g, ' ');
  return norm(a) === norm(b);
}
