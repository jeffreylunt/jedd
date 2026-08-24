import { createServer, type Server } from 'node:http';
import type { Connector, IncomingMessage } from '../connector.js';
import { BlueBubblesClient } from './client.js';
import { classifyPayload, type InboundVerdict } from './payload.js';
import type { SeenStore } from './seen.js';

export interface ReceiverOptions {
  client: BlueBubblesClient;
  seen: SeenStore;
  host: string;
  /** 0 asks the OS for an ephemeral port; `start()` returns the real one. */
  port: number;
  path: string;
  /**
   * Every payload the loop does NOT get, with the reason.
   *
   * This is how the shadow recorder is nearly free: V1's own replies arrive on
   * this same webhook as outbound echoes, so the rows the loop must never see
   * are exactly the rows the parity corpus is built from. Classification returns
   * a verdict rather than a boolean for this reason.
   */
  onSkipped?: (verdict: InboundVerdict) => void;
  log?: (line: string) => void;
}

export interface ReplayOutcome {
  delivered: number;
  saturated: boolean;
  detail: string;
}

type Handler = (message: IncomingMessage) => Promise<void>;

/**
 * Receives from BlueBubbles. Knows nothing about sending — that capability
 * lives on the connector wrapper, so a shadow deployment can hold a receiver
 * without holding anything able to speak.
 */
export class BlueBubblesReceiver {
  private server?: Server;

  private handler?: Handler;

  private readonly log: (line: string) => void;

  constructor(private readonly opts: ReceiverOptions) {
    this.log = opts.log ?? ((l) => console.error(l));
  }

  /** Start listening. Resolves with the bound port. */
  async start(handler: Handler): Promise<number> {
    this.handler = handler;
    this.server = createServer((req, res) => {
      if (req.method !== 'POST' || !req.url?.startsWith(this.opts.path)) {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        /**
         * 🔴 ANSWER FIRST, WORK SECOND.
         *
         * BlueBubbles dispatches to its webhooks fire-and-forget (its own source
         * says `// We don't need to await this`), so a slow subscriber cannot
         * delay another one. That is a reason not to worry, NOT a licence to be
         * slow: nothing here should ever hold a connection open while a model
         * turn runs.
         */
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');

        let payload: unknown = null;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          payload = null;
        }
        void this.ingest(payload, 'live');
      });
    });

    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.opts.port, this.opts.host, () => {
        const addr = this.server!.address();
        const port = typeof addr === 'object' && addr ? addr.port : this.opts.port;
        this.log(`[bb] listening on http://${this.opts.host}:${port}${this.opts.path}`);
        resolve(port);
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /**
   * One payload, from either the live webhook or replay.
   *
   * Both paths go through here on purpose: dedup that only covers one of them
   * re-delivers on every restart, and the watermark advances from both so a
   * quiet period of our own sends does not leave it stale.
   */
  private async ingest(payload: unknown, source: 'live' | 'replay', handler?: Handler): Promise<void> {
    const verdict = classifyPayload(payload);

    // The watermark tracks what we have SEEN, not what we delivered — an
    // outbound echo or a tapback still means that rowid is accounted for.
    if (verdict.rowid !== null) {
      try {
        this.opts.seen.advanceWatermark(verdict.rowid);
      } catch (e) {
        // A rowid we refuse to store is loud. V1's silently-inert watermark is
        // exactly what this must never become.
        this.log(`[bb] 🔴 REFUSED to advance watermark: ${(e as Error).message}`);
      }
    }

    if (verdict.action === 'skip') {
      this.opts.onSkipped?.(verdict);
      return;
    }

    if (!this.opts.seen.firstSight(verdict.dedupKey)) {
      this.log(`[bb] duplicate ${verdict.dedupKey} (${source}) — BlueBubbles double-fires; ignored`);
      return;
    }

    const run = handler ?? this.handler;
    if (!run) return;
    try {
      await run(verdict.message);
    } catch (e) {
      // A failing turn must not take the listener down or stop the next message.
      this.log(`[bb] handler threw on ${verdict.dedupKey}: ${(e as Error).message}`);
    }
  }

  /**
   * Deliver everything missed while we were down.
   *
   * 🔴 V1's equivalent is INERT: its watermark holds a microsecond timestamp
   * (`1783501783569848`) against rowids of ~2601, so `rowid > watermark` is
   * always false and it recovers nothing — while printing
   * `"Replay: no messages after rowid …"`, **the same line a healthy quiet
   * restart prints**. The failure state and the all-clear are one string.
   *
   * So this returns an outcome the caller must look at, and an incomplete
   * replay says so.
   */
  async replayMissed(handler?: Handler): Promise<ReplayOutcome> {
    const since = this.opts.seen.watermark();
    const res = await this.opts.client.replaySince(since);
    for (const row of res.messages) {
      await this.ingest({ type: 'new-message', data: row }, 'replay', handler);
    }
    const delivered = res.messages.length;
    const detail = res.saturated
      ? `🔴 REPLAY INCOMPLETE: walked ${res.pages} pages from rowid ${since} without reaching the ` +
        `watermark, so messages older than the ${delivered} recovered are LOST. This is reported ` +
        'rather than hidden — do not read it as "nothing was missed".'
      : delivered === 0
        ? `replay complete from rowid ${since}: nothing was missed`
        : `replay complete from rowid ${since}: ${delivered} message(s) recovered`;
    this.log(`[bb] ${detail}`);
    return { delivered, saturated: res.saturated, detail };
  }
}

/**
 * The full connector: receives and sends.
 */
export class BlueBubblesConnector implements Connector {
  readonly name = 'bluebubbles';

  constructor(
    private readonly receiver: BlueBubblesReceiver,
    private readonly client: BlueBubblesClient,
  ) {}

  async send(toHandle: string, text: string): Promise<void> {
    const r = await this.client.sendText(toHandle, text);
    if (!r.accepted) throw new Error(`send failed: ${r.detail}`);
  }

  async listen(handler: (message: IncomingMessage) => Promise<void>): Promise<void> {
    await this.receiver.start(handler);
    await this.receiver.replayMissed();
  }
}

/**
 * 🔴 SHADOW MODE: THE SEND PATH IS ABSENT BY CONSTRUCTION.
 *
 * Not a flag, not a config value, not a readOnly check — **this object holds no
 * client and therefore has nothing to send with.** A flag is a thing someone can
 * flip, or forget to set, or set in the wrong environment. There is nothing here
 * to flip.
 */
export class ShadowConnector implements Connector {
  readonly name = 'bluebubbles-shadow';

  constructor(private readonly receiver: BlueBubblesReceiver) {}

  async send(toHandle: string, text: string): Promise<void> {
    throw new Error(
      `shadow mode: this connector cannot send (refused ${text.length} chars to ${toHandle}). It ` +
        'holds no BlueBubbles client, so this is not a disabled feature — there is no send path ' +
        'to enable.',
    );
  }

  async listen(handler: (message: IncomingMessage) => Promise<void>): Promise<void> {
    await this.receiver.start(handler);
    await this.receiver.replayMissed();
  }
}
