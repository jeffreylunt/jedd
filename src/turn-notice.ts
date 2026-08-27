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
    /**
     * 🔴 THE ERROR THIS REPLACED, KEPT. `errors.ts` exists because "Node puts
     * the diagnosis in `e.cause`, and NOTHING in this codebase read it" cost
     * hours — and throwing this away would commit the same sin one level up. If
     * the socket died with ECONNRESET in the same tick the timer fired, the
     * abort flag is set and the REAL cause is this field. `describeError` walks
     * it.
     */
    cause?: unknown,
  ) {
    super(`the model call was aborted after ${Math.round(elapsedMs / 1000)}s (limit ${Math.round(limitMs / 1000)}s)`, {
      cause,
    });
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
  // Minutes only when it IS a whole number of minutes. `Math.round` on 150_000
  // renders "3-minute" for a two-and-a-half-minute budget — a smaller lie than
  // the one this function was written to fix, but the same lie.
  if (limitMs >= 120_000 && limitMs % 60_000 === 0) return `${limitMs / 60_000}-minute`;
  return `${Math.max(1, Math.round(limitMs / 1000))}-second`;
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
 * `JEDD_STILL_WORKING_MS` -> ms, or `undefined` for the measured default.
 *
 * 🔴 IT IS OVERRIDABLE FOR ONE REASON: OTHERWISE IT CANNOT BE EXERCISED. At
 * four minutes, the notice fires on roughly one turn in thirty-seven, so a
 * deploy could carry it for weeks without a single live firing — and "never ran"
 * and "ran fine" are the same log. The same argument that made
 * `LLM_TURN_TIMEOUT_MS` exist applies here and for the same reason.
 *
 * ⚠️ Empty, garbage, zero and negative all FALL BACK. The nonsense reading is a
 * threshold of 0, which texts every sender a "still working" note on every
 * message, on a build that looks configured.
 */
export function parseStillWorkingMs(raw: string | undefined): number | undefined {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  // Floored, not clamped at the top: a very LARGE value simply means "never",
  // which is a coherent thing to ask for. A very small one is never coherent.
  return Math.max(1_000, Math.round(n));
}

/**
 * How many notices one turn may send.
 *
 * ── 🔴 WHY FOUR ON A DOUBLING GAP AND NOT TWO ON A FIXED ONE ────────────────
 *
 * This was two fixed notices — 4 and 8 minutes — and that was wrong for the
 * reason `presence.ts` already knew: a turn's worst case is
 * `TURN_TIMEOUT_MS * MAX_STEPS`, which is why the typing ceiling is sized at TWO
 * HOURS, and a real turn has been measured at **787 seconds**. On that exact
 * turn the sender would be reassured twice and then get five unexplained
 * minutes, so "distinguishable from dead WHILE it runs" held for the first
 * eighth of the window the codebase itself sizes for.
 *
 * Doubling the gap keeps the count low and the signal alive: at the default the
 * notices land at 4, 12, 28 and 60 minutes. Bounding the number of TEXTS is the
 * right goal; bounding the covered WINDOW was not.
 */
export const MAX_NOTICES = 4;

/**
 * ⚠️ THE SECOND NOTICE IS NOT THE FIRST ONE REPEATED. An identical line arriving
 * twice reads as a stuck loop — which is the exact impression this is trying to
 * dispel — so the second one says what to do if it goes quiet after that.
 */
export function stillWorkingText(index: number): string {
  if (index === 0) return "Still working on this one — it's taking a while, but I'm on it.";
  if (index === 1) return "Still going. If you don't hear back from me in a few minutes, ask again and I'll start fresh.";
  return 'This one is taking much longer than usual. I have not given up, but feel free to ask again for something smaller.';
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
 *
 * ⚠️ SENDING A NOTICE MOMENTARILY TURNS THE TYPING INDICATOR OFF. `presence.ts`
 * records as measured fact that BlueBubbles clears its own `typingCache` and
 * calls `stopTyping` when a message is sent to a chat — so at the moment of
 * reassurance the "…" disappears. It returns on the next refresh (30s), so the
 * exposure is bounded and self-healing, but it is the one interaction where this
 * signal briefly REMOVES the other one. Noted rather than fixed: awaiting a
 * presence call on this path is the single rule `presence.ts` exists to forbid.
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

  /**
   * Start the clock.
   *
   * 🔴 `alreadyWaitedMs` IS NOT AN OPTIMISATION. The queue serialises per
   * sender, so a message texted while a turn is in flight waits for that turn
   * (up to 790s, measured), then a settle, then its own turn. Arming from turn
   * START would measure the wrong interval and understate the person's wait by
   * a whole turn — which is exactly the shape of the incident this file closes:
   * *he asked the same thing twice*. `main.ts` passes the queue's `queuedForMs`.
   *
   * Idempotent — a second call while armed does nothing.
   */
  arm(alreadyWaitedMs = 0): void {
    // 🔴 `sent >= maxNotices` TOO, not just `handle !== null`. Re-arming after
    // the last notice has fired would otherwise schedule one past the cap — the
    // cap is a property of the turn, not of the current timer.
    if (this.stopped || this.handle !== null || this.sent >= this.maxNotices) return;
    this.schedule(Math.max(0, this.afterMs - alreadyWaitedMs));
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

  /**
   * @param gapMs how long to wait before the NEXT notice. Doubles each time —
   *   see `MAX_NOTICES`.
   */
  private schedule(gapMs: number): void {
    // 🔴 CHECKED HERE, BEFORE ANY TIMER IS SET, and not only at the reschedule
    // below. Guarding the reschedule alone means `maxNotices: 0` still sends
    // ONE — a cap that cannot express "none" is not a cap.
    if (this.sent >= this.maxNotices) return;
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
      this.schedule(gapMs * 2);
      void this.opts
        .notify(stillWorkingText(index))
        .catch((e) => this.log(`[notice] a "still working" note could not be sent: ${(e as Error).message}`));
    }, gapMs);
  }
}
