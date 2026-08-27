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
   * How long to wait for SearchBot's results before giving up on this search.
   *
   * 🔴 MEASURED, AND THE FIRST VALUE WAS TOO TIGHT. Live latencies for a
   * `@search` reply: 17.6s, 25.4s, ~34s, **47.0s, 60.9s**. The original 45s cap
   * timed out BOTH queries in the run that found this, reporting "the search bot
   * did not answer" when the bot was simply slower than the cap — a
   * self-inflicted false negative that would have made IRC look useless.
   *
   * ⚠️ This is a genuine trade-off, not a free win: `search_ebook` waits on this
   * before returning, so a slow IRC costs the turn real seconds. It is bounded
   * by running the two sources CONCURRENTLY (Prowlarr is unaffected) and by the
   * fact that turns on this deployment already run 130-790s.
   */
  searchTimeoutMs?: number;
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

interface PendingTransfer {
  /** Distinguishes one caller's slot from another's, so a timer clears only its own. */
  id: number;
  /** 'search' accepts the results zip from whichever nick SearchBot runs under. */
  kind: 'search' | 'fetch';
  /** For 'fetch': the ONLY nick whose offer may be accepted, lowercased. */
  bot: string | null;
  resolve: (b: { filename: string; bytes: Buffer } | null, detail: string) => void;
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
  ): Promise<{ file: { filename: string; bytes: Buffer } | null; detail: string }> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (file: { filename: string; bytes: Buffer } | null, detail: string) => {
        if (settled) return;
        settled = true;
        resolve({ file, detail });
      };
      const slot: PendingTransfer = {
        id: this.nextPendingId++,
        kind,
        bot: bot ? bot.toLowerCase() : null,
        resolve: finish,
      };
      this.pending = slot;
      setTimeout(() => {
        if (this.pending?.id === slot.id) this.pending = null;
        finish(null, `nothing arrived within ${Math.round(timeoutMs / 1000)}s.`);
      }, timeoutMs).unref?.();
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

        const wait = this.awaitTransfer(this.o.searchTimeoutMs, 'search', null);
        this.send(`PRIVMSG ${this.o.channel} :@search ${sanitise(query)}`);
        const { file, detail } = await wait;
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
 * Loose comparison for the results header, which normalises spacing and case but
 * is otherwise exact. Deliberately not fuzzy: the failure being caught is a
 * COMPLETELY different query, and a fuzzy match would let it through.
 */
function sameQuery(a: string, b: string): boolean {
  const norm = (x: string) => x.trim().toLowerCase().replace(/\s+/g, ' ');
  return norm(a) === norm(b);
}
