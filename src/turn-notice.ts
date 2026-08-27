/**
 * ══════════════════════════════════════════════════════════════════════════
 * A TURN THAT IS SLOW OR DEAD HAS TO SAY SO. SILENCE IS NOT AN ANSWER.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── THE DEFECT, MEASURED TWICE LIVE 2026-08-26 ──────────────────────────────
 *
 * Jeff asked *"Give me the other 14"* and got NOTHING. No reply, no error, no
 * apology. Twenty minutes later he asked the same thing and got nothing again.
 * `llm.ts` aborts the model call on a timer; `fetch` throws; the turn dies. From
 * the phone, **a killed turn, a message that never arrived, and a bot that has
 * been switched off are the same event** — Jeff tried all three readings before
 * asking a human what had happened.
 *
 * Raising the ceiling 240s -> 900s (commit `5106f2d`, at his request) made that
 * rarer. It did not make it visible, and the comment at the edit site says so.
 *
 * ── TWO GAPS, AND THEY NEED DIFFERENT ANSWERS ───────────────────────────────
 *
 *   THE DEATH   the turn ends and nothing is said. Closed by `failureReply`
 *               below plus the catch in `main.ts` — every terminal outcome now
 *               produces a text, and a TIMEOUT says it timed out rather than
 *               hiding inside a generic apology.
 *
 *   THE WAIT    the turn is alive but will not answer for minutes. Closed by
 *               `StillWorkingNotice`. Nothing else covers this: the typing
 *               indicator is the only signal today, and BlueBubbles returns
 *               `200 Successfully started typing!` while nothing leaves the
 *               machine — so an absent "…" is not evidence of a dead turn and a
 *               present one is not evidence of a live one.
 *
 * 🔴 THE TWO ARE NOT INTERCHANGEABLE. A notice while it runs does not close the
 * death (a turn that dies after the notice is silent again from there on), and a
 * message on death does not close the wait (15 minutes of nothing, then a text).
 * Both, or neither is worth much.
 *
 * ── 🔴 WHY THE TIMEOUT IS CLASSIFIED FROM THE SIGNAL, NOT THE ERROR NAME ─────
 *
 * The obvious test is `e.name === 'AbortError'`. It is wrong here. Tools in this
 * codebase use `AbortSignal.timeout` of their own — `indexer-admin`, the arr
 * fetches, `probeLlm` — and any of them can surface an `AbortError` that has
 * nothing to do with the turn budget. Naming the model timeout from a string
 * that four other components also produce would tell the user "that took too
 * long, ask for a shorter list" about a five-second indexer probe.
 *
 * `llm.ts` therefore asks its OWN controller: `controller.signal.aborted` is
 * true for exactly one reason, because that controller is aborted from exactly
 * one place. The class below is what it throws instead.
 */

/** The turn budget expired and the model call was killed. */
export class ModelTimeoutError extends Error {
  /**
   * ⚠️ Set in the constructor rather than as a class field. A field initialiser
   * runs AFTER `super()`, which is fine here, but `name` also has to survive the
   * `describeError` path in `errors.ts`, which reads properties BY NAME off the
   * object — see the non-enumerability note in that file.
   */
  constructor(
    readonly elapsedMs: number,
    readonly limitMs: number,
  ) {
    super(`the model call was aborted after ${Math.round(elapsedMs / 1000)}s (limit ${Math.round(limitMs / 1000)}s)`);
    this.name = 'ModelTimeoutError';
  }
}

/** True for a turn killed by its own budget, and for nothing else. */
export function isModelTimeout(e: unknown): e is ModelTimeoutError {
  return e instanceof ModelTimeoutError;
}

/**
 * The budget, in the unit a person would use for it.
 *
 * 🔴 SECONDS BELOW TWO MINUTES, AND NOT AS A NICETY. Rounding to whole minutes
 * with a floor of 1 makes a THREE-SECOND budget announce itself as a
 * "1-minute limit" — a false sentence sent to a real person, and precisely the
 * configuration a live control of this path runs under. A message that only
 * tells the truth at the shipped default is not one you can rehearse.
 */
function describeLimit(limitMs: number): string {
  if (limitMs < 120_000) return `${Math.max(1, Math.round(limitMs / 1000))}-second`;
  return `${Math.round(limitMs / 60_000)}-minute`;
}

/**
 * What the person is told when the turn ends without an answer.
 *
 * 🔴 PURE, EXPORTED, AND TESTED HERE RATHER THAN INLINE IN `main.ts`. The catch
 * block that used to hold this sentence lives inside `main()`, which stands up
 * BlueBubbles, Ollama, IRC, IMAP and two SSH identities before it is reachable —
 * so nothing tested it, and the one thing the user actually receives on the
 * failure path had never been asserted on. Pulling the wording out is what makes
 * the mutation check in `test/turn-notice.test.ts` possible at all.
 *
 * ⚠️ It carries NO exception text. A cause chain here names internal hosts and
 * API paths and means nothing to the reader; `describeError` puts that in the
 * log, where the person who can act on it will see it.
 */
export function failureReply(e: unknown): string {
  if (isModelTimeout(e)) {
    return (
      `That one ran past my ${describeLimit(e.limitMs)} limit, so I stopped it rather than leave you hanging. ` +
      'A long list is usually what does it — ask me for a shorter one and it should come straight back.'
    );
  }
  return 'Something went wrong on my end and I could not answer that. It has been logged — worth trying again in a moment.';
}

/**
 * ── 🔴 240 SECONDS, AND THE NUMBER IS MEASURED, NOT PICKED ───────────────────
 *
 * From the durable log (`data/jedd.log`, 110 completed turns):
 *
 *     > 60s   27 / 110   24.5%
 *     > 120s  16 / 110   14.5%
 *     > 180s   8 / 110    7.3%
 *     > 240s   3 / 110    2.7%     ← here
 *     > 300s   2 / 110    1.8%
 *
 * So this fires on roughly one turn in thirty-seven. Lower it to 180s and one
 * turn in fourteen gets an extra text; lower it again and the notice becomes the
 * ordinary case, which is how a reassurance turns into noise a person learns to
 * ignore.
 *
 * It is also the OLD timeout. The moment at which Jedd used to die silently is
 * now the moment it says it is still alive, which is a fair place to draw the
 * line: everything past it was already outside the budget somebody chose once.
 */
export const STILL_WORKING_AFTER_MS = 240_000;

/**
 * How many notices one turn may send.
 *
 * A turn's worst case is `TURN_TIMEOUT_MS * MAX_STEPS` = two hours, so a single
 * notice at four minutes still leaves an unbounded silence behind it. Two
 * bounds the reassurance instead of the wait: after eight minutes the person has
 * been told twice and a third text adds nothing they do not already know.
 */
export const MAX_NOTICES = 2;

/**
 * ⚠️ THE SECOND NOTICE IS NOT THE FIRST ONE REPEATED. An identical line arriving
 * twice reads as a stuck loop — which is the exact impression this is trying to
 * dispel — so the second one says what to do if it goes quiet after that.
 */
export function stillWorkingText(index: number): string {
  return index === 0
    ? "Still working on this one — it's taking a while, but I'm on it."
    : "Still going. If you don't hear back from me in a few minutes, ask again and I'll start fresh.";
}

/** Test seam. Real timers are unref'd so a pending notice cannot hold the process open. */
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

export interface StillWorkingOptions {
  /** Sends one notice. Fire-and-forget: anything it throws is logged, never rethrown. */
  notify: (text: string) => Promise<void>;
  afterMs?: number;
  maxNotices?: number;
  timers?: TimerSeam;
  log?: (line: string) => void;
}

/**
 * Tells the sender the turn is still alive, and stops the instant it is not.
 *
 * ── 🔴 ARMED AROUND THE MODEL TURN, DISARMED BEFORE THE REPLY IS SENT ────────
 *
 * The ordering in `main.ts` is deliberate and is the only thing standing between
 * this and the failure it would be embarrassing to ship: a *"still working on
 * it"* landing AFTER the answer. Disarming in a `finally` around `agent.handle`
 * — before `connector.send` is even called — means the last moment a notice can
 * be scheduled is strictly before the reply exists.
 *
 * ⚠️ It does not make ARRIVAL order a guarantee, and nothing here can. A notice
 * fired a millisecond before the model returned is two independent HTTP sends to
 * BlueBubbles, and their delivery order is Apple's business. The window is the
 * width of one send against a four-minute threshold, and the cost of losing that
 * race is a redundant sentence rather than a wrong one.
 *
 * ── 🔴 THE NOTICE SENDS PLAIN, AND NOT BECAUSE PLAIN IS SIMPLER ──────────────
 *
 * `BlueBubblesConnector.sendReporting` calls `threading.answered(handle, guid)`
 * on every accepted send. Handing this the trigger's `sourceGuid` would
 * therefore mark the message ANSWERED by the reassurance — and the real reply,
 * arriving minutes later, would find its anchor already consumed and go out
 * plain. A progress note would have silently disabled reply threading for
 * exactly the long turns threading is most useful on.
 */
export class StillWorkingNotice {
  private handle: unknown = null;

  private sent = 0;

  private stopped = false;

  private readonly afterMs: number;

  private readonly maxNotices: number;

  private readonly timers: TimerSeam;

  private readonly log: (line: string) => void;

  constructor(private readonly opts: StillWorkingOptions) {
    this.afterMs = opts.afterMs ?? STILL_WORKING_AFTER_MS;
    this.maxNotices = opts.maxNotices ?? MAX_NOTICES;
    this.timers = opts.timers ?? nodeTimers;
    this.log = opts.log ?? ((l) => console.error(l));
  }

  /** Start the clock. Idempotent — a second call while armed does nothing. */
  arm(): void {
    if (this.stopped || this.handle !== null) return;
    this.schedule();
  }

  /**
   * The turn is over. No further notice will be scheduled or sent.
   *
   * 🔴 `stopped` IS SET BEFORE THE TIMER IS CLEARED, not after. `clear` on a
   * handle whose callback has already been queued does not un-queue it, so the
   * flag is what actually prevents the send; clearing the timer is the
   * optimisation, not the guard.
   */
  disarm(): void {
    this.stopped = true;
    this.timers.clear(this.handle);
    this.handle = null;
  }

  /** How many notices actually went out. For the turn log and for tests. */
  get noticesSent(): number {
    return this.sent;
  }

  private schedule(): void {
    this.handle = this.timers.set(() => {
      this.handle = null;
      if (this.stopped) return;
      const index = this.sent;
      this.sent += 1;
      /**
       * ⚠️ SCHEDULED BEFORE THE SEND IS AWAITED, so a slow or hanging
       * BlueBubbles cannot stop the clock for the next one. The notice is a
       * side effect of the passage of time, not of the previous notice
       * succeeding.
       */
      if (this.sent < this.maxNotices) this.schedule();
      void this.opts
        .notify(stillWorkingText(index))
        .catch((e) => this.log(`[notice] a "still working" note could not be sent: ${(e as Error).message}`));
    }, this.afterMs);
  }
}
