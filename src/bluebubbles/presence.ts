import { MAX_STEPS } from '../agent.js';
import { TURN_TIMEOUT_MS } from '../llm.js';
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
/**
 * ── 🔴 THE CEILING IS DERIVED FROM THE TURN BUDGET. DO NOT RETYPE A NUMBER. ──
 *
 * RAISED 2026-08-26 at Jeff's explicit instruction: *"Let's keep the typing
 * indicator going until we fully time out."*
 *
 * It was a flat `360_000` sitting beside a `900_000` turn budget it had no
 * relationship to, and the two drifted exactly as you would expect: on
 * 2026-08-26 the indicator died at **6 minutes** on a turn that ran **787
 * seconds and completed successfully**. Jeff watched the "…" vanish and then
 * got an answer seven minutes later, which is the precise experience the
 * indicator exists to prevent.
 *
 * ⚠️ `TURN_TIMEOUT_MS` IS PER MODEL CALL, NOT PER TURN. A turn makes up to
 * `MAX_STEPS` of them — today's 787s turn used all 8 — so a turn's worst-case
 * wall clock is the PRODUCT. Ceiling-as-900_000 would have been another number
 * that merely *looked* related and would have cut a slow multi-step turn off
 * early, reproducing this same complaint. Multiplying is what makes "until we
 * fully time out" literally true.
 *
 * This ceiling is a backstop for a `finally` that never runs, so widening it
 * widens how long a LEAKED indicator could sit — bounded, and only reachable
 * while the process is alive but buggy. A dead process cannot send a stop at
 * any ceiling, so nothing is lost there. Jeff's instruction is explicit and the
 * failure it prevents is one he actually hit.
 *
 * 🔴 The derivation is the point. Two magic numbers that happen to be
 * compatible is how they separate again.
 *
 * ── ⚠️ RAISED KNOWING THIS, NOT IN IGNORANCE OF IT ─────────────────────────
 *
 * There is a pre-existing hazard here and widening the ceiling interacts with
 * it, so this is recorded at the change rather than only on a task.
 *
 * `finish()` sets `stopped`, clears the timer and never re-arms — it is
 * idempotent and permanently disarming. If the stop packet it enqueues is
 * DROPPED on a cold path, our local flag says stopped while the recipient never
 * received "stopped typing", and **nothing is left running that would ever
 * retry**. A stale "…" on a real person's phone, claiming a reply is coming.
 *
 * 🔴 HOW LONG THAT STALE INDICATOR LASTS IS AN OPEN QUESTION, DELIBERATELY NOT
 * ANSWERED WITH A NUMBER HERE.
 *
 * The intuitive answer is "as long as the ceiling", which would make this change
 * much worse — 120 minutes rather than 6. But after `finish()` we also stop
 * sending REFRESHES, and a measured keepalive re-assert at **59.8s** implies
 * IMCore clears the local typing flag on roughly a one-minute timer; if the
 * recipient's client behaves the same way, a dropped stop should expire on its
 * own in about a minute REGARDLESS of the ceiling. On that reading the ceiling
 * governs how long the indicator is *deliberately* kept alive, not how long a
 * stale one lingers, and this change does not lengthen the hazard at all.
 *
 * ⚠️ That 59.8s figure is **n=1 and warm-path only** — the cold-window run
 * emitted nothing at +60s or +90s, so the auto-clear may not rescue a cold path,
 * which is precisely the path a dropped packet is on. **Do not treat either
 * duration as established.** The discriminator is a measurement nobody has
 * taken: after a dropped stop, is the recipient's indicator bounded by their own
 * client-side expiry, or does something keep it alive?
 *
 * The hazard is pre-existing and is NOT fixed here — the restart carrying this
 * was deliberately kept small. It is tracked on the concurrency/typing task.
 */
export const CEILING_MS = TURN_TIMEOUT_MS * MAX_STEPS;

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
   *
   * ⚠️ THE GUARANTEE IS PER-SESSION, AND THE TWO HALVES ARE NO LONGER THE SAME
   * SIZE. `finish()` forgets the session before enqueuing its stop, so the next
   * message from the same handle opens a fresh session on a fresh chain — and a
   * stop (three socket round trips) now races that turn's start (one HTTP call)
   * across two transports. That order can lose. It loses SAFELY: the new turn's
   * indicator gets switched off early, so Jedd looks quiet rather than looking
   * like it is about to speak forever, which is the direction this whole file
   * chooses. Worth knowing before the paragraph above is read as covering
   * back-to-back turns. It does not.
   */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly owner: Presence,
    readonly handle: string,
    private readonly startedAt: number,
  ) {}

  /** Queue an operation. Never throws, never delays the caller. */
  /**
   * 🔴 DID A START EVER SUCCEED FOR THIS SESSION?
   *
   * This is the difference between "a stop failed" and "an indicator is
   * STRANDED ON SOMEBODY'S PHONE". If no start ever landed there is nothing
   * showing, so a failed stop is a harmless consequence of the same cause. If a
   * start DID land, a failed stop is the one presence failure with a visible,
   * persistent cost to a real person — and it gets said every single time, with
   * no deduplication. See `Presence.report`.
   */
  private startedOk = false;

  private enqueue(what: string, op: () => Promise<PrivateApiResult>, loud = false): void {
    this.chain = this.chain.then(async () => {
      try {
        const r = await op();
        this.owner.report(what, this.handle, r, loud && this.startedOk);
        if (what !== 'stop typing') this.startedOk = r.ok;
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
    // 🔴 `loud`: a stop that does not land leaves a "…" on a real person's
    // phone claiming a reply is coming. THE ENTIRE REASON THIS BUG SURVIVED IS
    // THAT A FAILING STOP REPORTED SUCCESS — so this one failure is exempt from
    // every quieting rule in `report`, and is said on every occurrence.
    this.enqueue('stop typing', () => this.owner.client.stopTyping(chatGuidFor(this.handle)), true);
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

  /**
   * The last failure reported for each operation, so a STANDING fault is stated
   * once while a DIFFERENT one is still stated. Keyed by operation and bounded
   * by it: there are four.
   */
  private readonly saidAlready = new Map<string, string>();

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

  /**
   * @internal — called by a session when an operation returns.
   *
   * 🔴 EACH DISTINCT FAILURE IS SAID ONCE, AND ANY SUCCESS RE-ARMS EVERYTHING.
   *
   * `stopTyping` goes over BlueBubbles' socket API (see `client.stopTyping` for
   * why it cannot go over HTTP), and BlueBubbles' socket handler catches the
   * helper error and answers a fixed `"Failed to stop typing!"`. The helper's
   * own wording never reaches us, so a stop CANNOT identify itself as
   * helper-absent the way the HTTP start can. Reported plainly, a disconnected
   * helper would print that same red line every turn, forever, about a condition
   * already stated once — which is how a log gets ignored.
   *
   * 🔴 A FAILED **STOP** IS EXEMPT FROM ALL OF IT. Pass `loud` and it is said on
   * every occurrence, with no deduplication and no helper-absent suppression —
   * because a stop that does not land leaves a "…" on a real person's phone,
   * and **the entire reason the inverted-DELETE bug survived is that a failing
   * stop reported success.** Never route the stop back through the quiet path
   * to tidy the log up.
   *
   * ⚠️ THE RULE IS PER OPERATION AND PER MESSAGE, NOT A BLANKET MUTE. An earlier version muted
   * every failure once the helper was known absent, and the helper being absent
   * is a STANDING condition here — so no call would ever return `ok`, the mute
   * would never lift, and a brand-new fault in the brand-new socket transport
   * would have been invisible for the life of the process behind a notice about
   * something else. Deduplicating on the detail says each thing once and still
   * says every NEW thing.
   */
  report(what: string, handle: string, r: PrivateApiResult, loud = false): void {
    if (r.ok) {
      // Whatever was wrong with THIS operation is over, so the next occurrence
      // is news again. ⚠️ Per operation, not global: `startTyping` succeeding
      // every turn must not re-arm a `stopTyping` failure that is still
      // standing, or the standing failure prints once per turn regardless.
      this.saidHelperAbsent = false;
      this.saidAlready.delete(what);
      return;
    }
    if (r.helperAbsent) {
      if (this.saidHelperAbsent) return;
      this.saidHelperAbsent = true;
      this.logLine(
        `[presence] typing indicators and read receipts are OFF: ${r.detail} Everything else works ` +
          'normally; this notice is printed once per process and will not repeat.',
      );
      return;
    }
    if (loud) {
      // 🔴 NO DEDUPLICATION, NO HELPER-ABSENT SUPPRESSION, EVERY OCCURRENCE.
      // Each one is a different turn and a different moment at which somebody
      // is looking at a "…" that will never resolve. Quieting a repeat here
      // would be quieting a second stranded indicator, not a second mention of
      // the first.
      this.logLine(
        `[presence] 🔴 STOP FAILED for ${handle} — ${r.detail} A typing indicator may be STRANDED on ` +
          'their phone, claiming a reply is coming. The reply itself is unaffected.',
      );
      return;
    }
    if (this.saidAlready.get(what) === r.detail) return;
    this.saidAlready.set(what, r.detail);
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
   *
   * 🔴 THE BOUND IS SIZED AGAINST THE STOP'S NEW COST, NOT PICKED. A stop is no
   * longer one HTTP round trip: `client.stopTyping` handshakes, joins and emits,
   * and the emit that actually stops typing is the THIRD trip. At 2s the old
   * bound would race a slow-but-alive BlueBubbles and exit with that emit still
   * in flight — a stranded "…" on a real person's phone, which this file calls
   * the one unrecoverable outcome. 4s covers three trips with room to spare, and
   * it fits inside the budget: pm2's `kill_timeout` for this app is 10s (see
   * `ecosystem.config.cjs`), and all that follows is the webhook
   * deregistration, which needs a couple of seconds at most.
   */
  async stopAll(boundMs = 4_000): Promise<void> {
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
