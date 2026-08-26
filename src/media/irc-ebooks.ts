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
 * no NickServ registration, exponential backoff on reconnect, and no nick
 * cycling — **if ops throttle or ban us that is a stop-and-report, never
 * something to route around.**
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
  /** How long to wait for SearchBot's results before giving up on this search. */
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
  searchTimeoutMs: 45_000,
  offerTimeoutMs: 8 * 60_000,
  maxBytes: 25 * 1024 * 1024,
  connectTimeoutMs: 110_000,
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
  wantResults: boolean;
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
  private stopped = false;

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
        if (!v) this.lastError = why;
        resolve(v);
      };

      const sock = this.o.dial(this.o.host, this.o.port, () => {
        this.send(`NICK ${this.o.nick}`);
        this.send(`USER ${this.o.nick} 0 * :Jedd ebook fetcher`);
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

      sock.on('error', ((e: Error) => {
        this.o.log(`[irc] socket error: ${e?.message}`);
        this.failPending(`the IRC connection dropped: ${e?.message}`);
        this.teardown();
        done(false, `socket error: ${e?.message}`);
      }) as never);

      sock.on('close', (() => {
        this.failPending('the IRC connection closed mid-transfer.');
        this.teardown();
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
      onJoined();
      return;
    }
    if (code === '474' || code === '473' || code === '475' || code === '471' || code === '465') {
      // Banned / throttled / limited. STOP AND REPORT — never cycle nicks.
      this.lastError =
        `the server refused the channel (${code}). This is an access decision by channel ops ` +
        'and must be reported, not worked around.';
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

    const pm = line.match(/^:(\S+?)!\S+ PRIVMSG (\S+) :(.*)$/);
    if (!pm) return;
    const body = pm[3] ?? '';
    if (!body.includes('DCC SEND')) return;

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
          d.on('data', ((c: Buffer) => {
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
          }) as never);
          d.on('error', ((e: Error) => finish(false, `the transfer of "${filename}" failed: ${e?.message}`)) as never);
          d.on('close', (() => {
            if (got === 0) finish(false, `"${filename}" closed with no data.`);
            else if (got < size) {
              finish(false, `"${filename}" stopped at ${got} of ${size} bytes — incomplete, so it was discarded.`);
            } else finish(true, `received ${got} bytes`);
          }) as never);
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

  /** Wait for the next DCC file, whatever it turns out to be. */
  private awaitTransfer(timeoutMs: number, wantResults: boolean): Promise<{ file: { filename: string; bytes: Buffer } | null; detail: string }> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (file: { filename: string; bytes: Buffer } | null, detail: string) => {
        if (settled) return;
        settled = true;
        resolve({ file, detail });
      };
      this.pending = { wantResults, resolve: finish };
      setTimeout(() => {
        if (this.pending) this.pending = null;
        finish(null, `nothing arrived within ${Math.round(timeoutMs / 1000)}s.`);
      }, timeoutMs).unref?.();
    });
  }

  async search(query: string): Promise<IrcSearchOutcome> {
    return this.guard(
      'search',
      async (): Promise<IrcSearchOutcome> => {
        const up = await this.connect();
        if (!up) return { state: 'unknown', detail: `IRC is not available — ${this.status().detail}` };

        const wait = this.awaitTransfer(this.o.searchTimeoutMs, true);
        this.send(`PRIVMSG ${this.o.channel} :@search ${sanitise(query)}`);
        const { file, detail } = await wait;
        if (!file) return { state: 'unknown', detail: `the #ebooks search bot did not answer — ${detail}` };

        const un = unzipSingleTextEntry(file.bytes);
        if (un.state !== 'ok') return { state: 'unknown', detail: un.detail };

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

        const wait = this.awaitTransfer(this.o.offerTimeoutMs, false);
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

  private teardown(): void {
    this.joined = false;
    this.registered = false;
    this.roster.clear();
    this.sock = null;
  }

  stop(): void {
    this.stopped = true;
    this.failPending('shutting down.');
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
