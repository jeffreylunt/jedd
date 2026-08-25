import { chatGuidFor, type PrivateApiResult } from './client.js';

/**
 * Typing indicators and read receipts — the two things Jedd can say WITHOUT
 * saying anything.
 *
 * ── 🔴 THE ONE RULE THIS FILE EXISTS TO ENFORCE ────────────────────────────────
 *
 * **None of it may ever break or delay a reply.** A typing indicator is a
 * nicety; the answer is the product. So every call here is fire-and-forget with
 * its own catch, nothing on the reply path awaits a presence call, and no error
 * from any of it propagates to a caller. `Presence` is the ONE place that
 * swallows — deliberately not `BlueBubblesClient`, because a subject that cannot
 * throw cannot prove that its caller survives a throw.
 *
 * ── 🔴 AND THE ONE PROPERTY THAT MAKES A STUCK INDICATOR IMPOSSIBLE ───────────
 *
 * A typing indicator that never stops is WORSE than no indicator at all: it
 * says a reply is coming, forever, for a reply that will never arrive. Silence
 * is recoverable; a permanent lie is not. Four independent things stop it:
 *
 *  1. `withTyping`'s `finally` — covers the happy path, every throw, every early
 *     return, and the model timing out.
 *  2. The **ceiling** below — a backstop for a `finally` that never runs because
 *     somebody dropped an `await`.
 *  3. `Presence.stopAll()` on shutdown — a pm2 restart mid-turn is the single
 *     most likely way to strand one, and pm2 restarts happen on every deploy.
 *  4. BlueBubbles itself clears its `typingCache` and calls `stopTyping` when a
 *     message is sent to that chat (confirmed in the shipped server source).
 *
 * Only (1) is load-bearing in normal operation. (2)–(4) exist because the cost
 * of the failure is measured in days of a wrong "…" on somebody's phone, and
 * because nothing here can observe whether it happened.
 */

/** The slice of `BlueBubblesClient` this needs. Narrow so tests can stand it up. */
export interface PresenceCapableClient {
  startTyping(chatGuid: string): Promise<PrivateApiResult>;
  stopTyping(chatGuid: string): Promise<PrivateApiResult>;
  markChatRead(chatGuid: string): Promise<PrivateApiResult>;
}

/** Test seam. Real timers are unref'd so a pending refresh cannot hold the process open. */
export interface TimerSeam {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const nodeTimers: TimerSeam = {
  set(fn, ms) {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clear(handle) {
    if (handle) clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * ── 🔴 THE REFRESH DECISION, AND WHAT IS AND IS NOT KNOWN ─────────────────────
 *
 * A model turn here runs LONG. `llm.ts` aborts at 240s, and the live bot's own
 * log on 2026-08-25 shows two consecutive real turns at **156565ms and
 * 159988ms** — both `sports_fixture`, both to Jeff. So the question is whether
 * one `startTyping` call covers a whole turn, or goes dark partway through, and
 * a two-and-a-half-minute turn puts that well beyond any plausible answer.
 *
 * **What is measured:** nothing in BlueBubbles or its helper expires it. The
 * helper calls Apple's `-[IMChat setLocalUserIsTyping:]` (verified in the
 * shipped `BlueBubblesHelper.dylib` symbol table); the server holds only a
 * `typingCache: string[]` so it can stop on send. There is no timer and no TTL
 * constant anywhere in either.
 *
 * **What is NOT measured, and could not be:** how long the RECIPIENT'S Messages
 * app keeps the "…" on screen without a refresh. That behaviour is Apple's, it
 * lives on the other device, and with the helper disconnected the indicator
 * cannot be made to appear at all — so it cannot be timed. ⚠️ The commonly
 * repeated "about 60 seconds" is folklore this codebase has NOT verified. It is
 * not relied on below; it only explains why 30s is a defensible guess.
 *
 * **The choice: refresh, at 30s.** The asymmetry decides it, not the number.
 *   - If the indicator does not expire, a refresh is a redundant re-assertion of
 *     a flag that is already set. Cost: one 3ms call per 30s. Harmless.
 *   - If it does expire at anything under two minutes, a single call goes dark
 *     partway through a MEASURED 156s turn, and the feature does nothing for the
 *     majority of exactly the long turns it was asked for.
 * A wrong guess in one direction is free; in the other it is the whole feature.
 *
 * 🔴 The refresh loop is itself the main new way to strand an indicator, which
 * is why it is cancelled in `finally` AND capped by `CEILING_MS`.
 */
export const REFRESH_MS = 30_000;

/**
 * Hard stop for a single typing session, regardless of what the caller does.
 *
 * Sized to clear a worst-case turn (240s model abort plus tool time) so it never
 * fires on legitimate work. It is a backstop for a lost `finally`, not a policy:
 * if it ever fires, the indicator goes quiet while the turn may still be
 * running, which is the safe direction — Jedd looks slow rather than looking
 * like it is about to speak forever.
 */
export const CEILING_MS = 360_000;

export interface PresenceOptions {
  client: PresenceCapableClient;
  refreshMs?: number;
  ceilingMs?: number;
  log?: (line: string) => void;
  timers?: TimerSeam;
  now?: () => number;
}

/** One in-flight "Jedd is typing" for one handle. */
class TypingSession {
  /**
   * 🔴 REFERENCE-COUNTED, because two messages from the same sender ARE
   * concurrent here. The receiver kicks off `void this.ingest(...)` per webhook
   * POST, so a person who sends two lines in a row has two turns running at
   * once. Without the count, the first to finish stops the indicator while the
   * second is still thinking — and the second turn's `finally` then stops an
   * indicator that is already off, so nothing looks wrong.
   */
  refs = 1;

  private stopped = false;

  private timer: unknown = null;

  /**
   * 🔴 EVERY OPERATION IS SERIALISED ONTO THIS CHAIN, AND NOBODY AWAITS IT.
   *
   * Both halves matter. Nobody awaiting it is what keeps the reply path free of
   * presence latency. Serialising is what stops a fast turn from issuing `stop`
   * while `start` is still in flight — two un-ordered fire-and-forget calls can
   * land in either order at the server, and the losing order leaves the
   * indicator ON with nothing left to turn it off.
   */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly owner: Presence,
    readonly handle: string,
    private readonly startedAt: number,
  ) {}

  /** Queue an operation. Never throws, never delays the caller. */
  private enqueue(what: string, op: () => Promise<PrivateApiResult>): void {
    this.chain = this.chain.then(async () => {
      try {
        this.owner.report(what, this.handle, await op());
      } catch (e) {
        this.owner.reportThrow(what, this.handle, e);
      }
    });
  }

  begin(): void {
    this.enqueue('start typing', () => this.owner.client.startTyping(chatGuidFor(this.handle)));
    this.arm();
  }

  private arm(): void {
    this.timer = this.owner.timers.set(() => {
      if (this.stopped) return;
      if (this.owner.now() - this.startedAt >= this.owner.ceilingMs) {
        this.owner.log(
          `[presence] 🔴 typing ceiling reached for ${this.handle} after ${this.owner.ceilingMs}ms — ` +
            'stopping the indicator even though the turn has not finished. A stuck "…" claims a ' +
            'reply is coming; going quiet only claims Jedd is slow.',
        );
        this.finish();
        return;
      }
      this.enqueue('refresh typing', () => this.owner.client.startTyping(chatGuidFor(this.handle)));
      this.arm();
    }, this.owner.refreshMs);
  }

  /** One caller is done. The indicator stops when the LAST one is. */
  release(): void {
    this.refs -= 1;
    if (this.refs > 0) return;
    this.finish();
  }

  /** Cancel the refresh loop and stop typing. Idempotent. */
  finish(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.owner.timers.clear(this.timer);
    this.timer = null;
    this.owner.forget(this);
    this.enqueue('stop typing', () => this.owner.client.stopTyping(chatGuidFor(this.handle)));
  }

  /** Everything queued so far. Only shutdown waits on this. */
  settled(): Promise<void> {
    return this.chain;
  }
}

export class Presence {
  readonly client: PresenceCapableClient;

  readonly timers: TimerSeam;

  readonly refreshMs: number;

  readonly ceilingMs: number;

  readonly now: () => number;

  private readonly logLine: (line: string) => void;

  private readonly active = new Map<string, TypingSession>();

  /**
   * 🔴 THE HELPER-ABSENT NOTICE IS SAID ONCE PER PROCESS, AND IS NOT AN ERROR.
   *
   * Until SIP is disabled this is the outcome of every presence call — roughly
   * twelve times a day, forever. Logged per-call it would be a daily wall of
   * red about a known, expected, harmless condition, and the only thing that
   * teaches is to stop reading the log. Logged once, with the remedy, it is
   * information.
   */
  private saidHelperAbsent = false;

  constructor(opts: PresenceOptions) {
    this.client = opts.client;
    this.timers = opts.timers ?? nodeTimers;
    this.refreshMs = opts.refreshMs ?? REFRESH_MS;
    this.ceilingMs = opts.ceilingMs ?? CEILING_MS;
    this.now = opts.now ?? (() => Date.now());
    this.logLine = opts.log ?? ((l) => console.error(l));
  }

  log(line: string): void {
    this.logLine(line);
  }

  /** @internal — called by a session when an operation returns. */
  report(what: string, handle: string, r: PrivateApiResult): void {
    if (r.ok) return;
    if (r.helperAbsent) {
      if (this.saidHelperAbsent) return;
      this.saidHelperAbsent = true;
      this.logLine(
        `[presence] typing indicators and read receipts are OFF: ${r.detail} Everything else works ` +
          'normally; this notice is printed once per process and will not repeat.',
      );
      return;
    }
    this.logLine(`[presence] ${what} for ${handle} failed — ${r.detail} (ignored; a reply is unaffected)`);
  }

  /** @internal — called by a session when an operation throws. */
  reportThrow(what: string, handle: string, e: unknown): void {
    this.logLine(
      `[presence] ${what} for ${handle} threw: ${(e as Error)?.message ?? String(e)} ` +
        '(ignored; a reply is unaffected)',
    );
  }

  /** @internal */
  forget(session: TypingSession): void {
    if (this.active.get(session.handle) === session) this.active.delete(session.handle);
  }

  /**
   * Mark the conversation read. Fire-and-forget by construction — it returns
   * `void`, so there is no promise for a caller to accidentally await on the
   * reply path.
   */
  markRead(handle: string): void {
    void (async () => {
      try {
        this.report('mark read', handle, await this.client.markChatRead(chatGuidFor(handle)));
      } catch (e) {
        this.reportThrow('mark read', handle, e);
      }
    })();
  }

  /**
   * Show "…" for exactly as long as `fn` runs, then stop — whatever `fn` does.
   *
   * 🔴 THE SHAPE IS THE GUARANTEE. There is no public `startTyping`, so a caller
   * cannot begin one without having named the region it covers; the `finally`
   * below is the only stop anybody has to remember, and it is written once here
   * rather than at every call site. Exposing start/stop as a pair and trusting
   * callers is how the indicator gets stranded on the error path that nobody
   * thought about.
   *
   * ⚠️ `fn`'s result and rejection both pass through untouched. This wrapper is
   * transparent: if it were to swallow `fn`'s error it would turn a failed turn
   * into a silent one.
   */
  async withTyping<T>(handle: string, fn: () => Promise<T>): Promise<T> {
    let session = this.active.get(handle);
    if (session) {
      session.refs += 1;
    } else {
      session = new TypingSession(this, handle, this.now());
      this.active.set(handle, session);
      // Not awaited: the model turn starts NOW, not after BlueBubbles answers.
      session.begin();
    }
    try {
      return await fn();
    } finally {
      session.release();
    }
  }

  /**
   * Stop every live indicator and wait — briefly — for the stops to land.
   *
   * 🔴 THE ONLY PLACE ANYTHING AWAITS A PRESENCE CALL, and it is not on the
   * reply path. A SIGTERM mid-turn (i.e. every pm2 deploy) would otherwise exit
   * with `stopTyping` queued and never sent, leaving a "…" on a real person's
   * phone until Apple decides otherwise — and this codebase does not know when
   * that is.
   *
   * ⚠️ BOUNDED. Shutdown must not hang because BlueBubbles is unreachable; a
   * missed stop is bad, a process that will not die is worse.
   */
  async stopAll(boundMs = 2_000): Promise<void> {
    const sessions = [...this.active.values()];
    for (const s of sessions) s.finish();
    if (sessions.length === 0) return;
    await Promise.race([
      Promise.allSettled(sessions.map((s) => s.settled())).then(() => undefined),
      new Promise<void>((resolve) => {
        this.timers.set(resolve, boundMs);
      }),
    ]);
  }
}
