/**
 * ══════════════════════════════════════════════════════════════════════════
 * ONE TURN PER BURST — per-sender serialisation with coalescing.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── THE DEFECT, MEASURED LIVE 2026-08-27 ────────────────────────────────────
 *
 * `BlueBubblesReceiver` starts every webhook with a bare `void this.ingest(…)`,
 * so two messages sent seconds apart become two turns running at once, each
 * knowing nothing about the other. Turns here run 25s–790s, so this is not a
 * narrow race — it is the normal outcome of texting twice.
 *
 * Three distinct symptoms, all one mechanism:
 *
 *   DUPLICATION   02:22:32 "Option #1."                     -> resolve_choice, add_movie(1504358)
 *                 02:22:38 "Don't say good luck the film!"  ->                 add_movie(1504358)
 *                 Two replies five seconds apart, and **every tool ran twice**
 *                 for one thing the person asked for once.
 *
 *   ORDERING      turn 11 completed at 03:37:12, turn 10 at 03:37:22. Jeff got
 *                 the answer to his SECOND message before the answer to his
 *                 first — and turn 11's reply cited a release search that turn
 *                 10 had kicked off, because it could see it.
 *
 *   CROSSING      11:43 each turn answered the OTHER message. This is the one
 *                 that made an anchored reply a lie, and it is why
 *                 `REPLY_THREADING_ENABLED` is currently false.
 *
 * It could see it because `Agent.histories` holds ONE mutable array per sender:
 * both turns push their user text into the same array and both read it back.
 * The turns were never independent — they were interleaved.
 *
 * ── WHY A THIRD STATE AND NOT A REORDERING ──────────────────────────────────
 *
 * The tempting repair is to reorder something — mark the sender busy before the
 * turn, or after it. Two states cannot express three conditions, and the
 * failure modes sit on either side of the same line: mark busy too late and a
 * second message starts a concurrent turn (the bug); release too early and a
 * message arriving in the gap is dropped and never answered, which is worse,
 * because a lost message is silent.
 *
 * So a sender is in one of three conditions, and the LANE is the third one:
 *
 *   no lane                     idle — the next message starts a turn
 *   lane, pending empty         a turn is in flight and nothing is owed behind it
 *   lane, pending non-empty     a turn is in flight and more has arrived since
 *
 * 🔴 THE LANE IS DELETED IN THE SAME SYNCHRONOUS TICK THAT FINDS `pending`
 * EMPTY. There is no `await` between the loop test and the delete, and JavaScript
 * is single-threaded, so `submit` physically cannot run in between. That is the
 * whole atomicity argument, and it is the same one `SeenStore.firstSight` makes.
 * **Putting any await between them opens a window in which a message is accepted
 * into a lane nobody will ever drain.**
 *
 * ── QUEUE BEHIND, SUPERSEDE, OR JOIN — AND WHY THIS JOINS ───────────────────
 *
 * SUPERSEDE (cancel the in-flight turn) was rejected outright: a killed turn is
 * SILENT to the person who texted — indistinguishable from Jedd being switched
 * off — and it throws away minutes of model work that was often about to answer
 * the first question correctly.
 *
 * QUEUE BEHIND alone fixes ordering and stops the shared history interleaving,
 * but it does not stop the duplication. "Option #1." and "the film!" are ONE
 * request; answering them in two serial turns still texts the person twice, and
 * whether the second turn re-runs `add_movie` then depends on the model noticing
 * its own previous reply — a judgement, not a guarantee.
 *
 * JOIN is what a human does, and it is the only option that makes "every tool
 * ran twice" structurally impossible: one turn, one tool loop, one reply. It is
 * also exactly what `threading.ts` names as the precondition for switching
 * anchored replies back on — *"one turn per burst, or a turn that cannot answer
 * outside its own message"*.
 *
 * The cost of joining is `settle`: the first message of a burst waits before its
 * turn starts, so a follow-on has a chance to land in the same batch. That is a
 * real cost paid on every message, and it is small against turns that run
 * 25–790 seconds.
 *
 * ⚠️ There is no second coalescing window anywhere else in V2 — `EDIT_WINDOW_MS`
 * does not exist in this tree (it was V1's) — so this is the only merge point and
 * there is nothing for it to overlap with. Do not add another.
 *
 * ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
 *
 * It does not make `Agent` safe to call concurrently. It makes it so nothing
 * DOES. `Agent.handle` still shares one history array per sender and would still
 * interleave if some future path called it directly — which is why `Agent` now
 * carries a re-entrancy tripwire that says so loudly rather than a second guard
 * that would quietly cover for this one.
 *
 * ⚠️ `src/index.ts` (the terminal) is a THIRD caller of `agent.handle` and does
 * NOT go through this queue. It is safe because `StdoutConnector` reads one
 * typed line at a time, and the tripwire covers it if that ever stops being
 * true. Stated here so the next reader does not have to establish it again.
 *
 * 🔴 REPLAY DOES NOT COALESCE, AND THAT IS DELIBERATE. `replayMissed` awaits
 * each `ingest`, `ingest` awaits the handler, and `submit` resolves only after
 * the lane is torn down — so each recovered message opens a FRESH lane and gets
 * its own turn. A burst that happened during downtime is therefore still
 * replayed as two turns, and `add_movie` could still run twice on that one path.
 *
 * It is left that way on purpose: the alternative is submitting the whole
 * backlog without awaiting, which turns a restart into one enormous merged turn
 * answering messages of quite different ages — and `receiver.ts` already refuses
 * to replay from a virgin watermark precisely because a burst of stale answers
 * is the worst restart behaviour available. Serial-and-in-order beats
 * merged-and-confusing here. The cost is `BURST_SETTLE_MS` per recovered
 * message at boot.
 */

/** A message waiting for its turn, with the promise its submitter is holding. */
interface Queued<T> {
  item: T;
  /** Resolved once the batch containing this item has been handled. */
  done: () => void;
}

interface Lane<T> {
  pending: Queued<T>[];
}

export interface TurnQueueOptions<T> {
  /**
   * What makes two messages compete. Items with DIFFERENT keys run
   * concurrently — Robin's turn must never wait behind Jeff's.
   */
  keyOf: (item: T) => string;
  /**
   * Runs one turn for a whole batch, oldest message first. May throw; the lane
   * survives it (see the test), because a failing turn must not cost this person
   * every message they send afterwards.
   */
  run: (batch: T[]) => Promise<void>;
  /**
   * 🔴 CALLED THE INSTANT A MESSAGE IS ACCEPTED, BEFORE THE SETTLE WINDOW.
   *
   * This exists because the settle window would otherwise delay the READ RECEIPT
   * as well as the reply, and those two are not the same promise. `connector.ts`
   * says of `markRead`: *"The read receipt goes out as Jedd picks the message
   * up, not after it has thought about it."* Marking read from inside the turn
   * would have made that sentence quietly false for every message — five seconds
   * of total silence after texting is exactly what the receipt exists to
   * prevent, and the settle's cost was weighed against a 25–790s turn, which is
   * the right frame for the REPLY and the wrong one for the ACKNOWLEDGEMENT.
   *
   * ⚠️ It must not be slow — it runs inside the submitter's own frame — and
   * anything it throws is caught and logged rather than allowed to fail the
   * submit. A failed read receipt must never cost somebody their answer.
   */
  onAccepted?: (item: T) => void;
  /**
   * Most messages one batch may carry. `lane.pending` is otherwise unbounded:
   * during a 790s turn a person can queue arbitrarily many messages and they
   * would all be joined into ONE model input. The remainder is not dropped — the
   * drain loop takes it on the next pass, in order.
   */
  maxBatch?: number;
  /**
   * The burst-settle window: awaited before each batch is committed, so
   * messages still arriving join it. Injected rather than a bare number so
   * tests drive it by hand and nothing here waits on a real clock.
   */
  settle: () => Promise<void>;
  log?: (line: string) => void;
}

/**
 * 🔴 FIVE SECONDS, AND THE UNIT IS A HUMAN'S SECOND THOUGHT, NOT A NETWORK HOP.
 *
 * The live burst that motivated this was 7s wide end to end and 5.3s between the
 * two messages ("Option #1." at 02:22:32, "the film!" at 02:22:38 — measured
 * from `audit.jsonl` completion times, so the arrivals were slightly tighter
 * still). It is the interval in which someone realises they left something out.
 *
 * Raising it merges more and delays every reply; lowering it splits bursts back
 * into separate turns, which is correct-but-chatty now rather than wrong.
 * Against turns that run 25–790 seconds this is 0.6%–20% of one turn, and it
 * costs nothing that a person can feel over SMS.
 */
export const BURST_SETTLE_MS = 5_000;

/**
 * Most messages one turn will answer at once. Not a correctness bound — the
 * remainder is taken by the next pass, in order — but a bound on how much of one
 * person's typing becomes a single model input.
 */
export const MAX_BATCH = 20;

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Serialises turns per sender and coalesces a burst into one turn.
 *
 * PURE apart from the injected settle — no BlueBubbles, no agent, no network —
 * so the whole ordering rule is pinned by tests that drive the window by hand,
 * the same way `classifyPayload` keeps the inbound rules away from HTTP.
 */
export class TurnQueue<T> {
  private readonly lanes = new Map<string, Lane<T>>();

  private readonly log: (line: string) => void;

  constructor(private readonly opts: TurnQueueOptions<T>) {
    this.log = opts.log ?? ((l) => console.error(l));
  }

  /**
   * Accept a message. Resolves when the batch containing it has been handled —
   * so replay stays serial and a test can await a turn — and **never rejects**,
   * because the live caller is a fire-and-forget webhook with nowhere to put an
   * error.
   *
   * ⚠️ It can still throw SYNCHRONOUSLY if `keyOf` throws, which is a different
   * escape from that contract and is the caller's own bug. `receiver.ts` catches
   * it; nothing here can, because without a key there is no lane to put the
   * message in and no honest way to resolve its promise.
   */
  submit(item: T): Promise<void> {
    const key = this.opts.keyOf(item);
    let done!: () => void;
    const handled = new Promise<void>((r) => {
      done = r;
    });
    const queued: Queued<T> = { item, done };

    const lane = this.lanes.get(key);
    if (lane) {
      // A turn for this person is already in flight or settling. Joining the
      // lane is the entire fix: this message will be answered by that turn's
      // batch or the next one, and never by a second concurrent turn.
      lane.pending.push(queued);
    } else {
      this.lanes.set(key, { pending: [queued] });
      /**
       * ⚠️ `.catch` RATHER THAN A BARE `void`. `drain` contains everything it
       * can, but a rejection escaping here would be an UNHANDLED REJECTION, and
       * this ships on node:24-alpine where the default is
       * `--unhandled-rejections=throw` — the process would EXIT. Jedd going
       * silent for the whole household is not an acceptable consequence of one
       * lane failing.
       */
      void this.drain(key).catch((e) => {
        this.log(`[queue] 🔴 ${key}: the drain loop itself failed: ${(e as Error).message}`);
      });
    }

    /**
     * ⚠️ AFTER the message is safely in a lane, never before. This is the read
     * receipt (see `onAccepted`), and a receipt for a message we then failed to
     * enqueue would be a lie told instantly.
     */
    try {
      this.opts.onAccepted?.(item);
    } catch (e) {
      this.log(`[queue] ${key}: onAccepted threw and was ignored: ${(e as Error).message}`);
    }
    return handled;
  }

  /** Is a turn owed to this sender right now? For diagnostics and tests. */
  inFlight(key: string): boolean {
    return this.lanes.has(key);
  }

  private async drain(key: string): Promise<void> {
    const lane = this.lanes.get(key);
    if (!lane) return;
    try {
      while (lane.pending.length > 0) {
        // Let the burst finish arriving before committing to what is in it.
        await this.opts.settle();

        // Take-all, synchronously. Anything that arrives from here on lands in
        // a fresh `pending` and is handled by the next pass, in order.
        const batch = lane.pending.splice(0, Math.min(lane.pending.length, this.opts.maxBatch ?? MAX_BATCH));
        if (batch.length > 1) {
          this.log(
            `[queue] ${key}: ${batch.length} messages COALESCED into one turn — they arrived as one ` +
              'thought and are answered as one, so no tool runs twice',
          );
        }
        try {
          await this.opts.run(batch.map((b) => b.item));
        } catch (e) {
          /**
           * 🔴 SWALLOWED HERE, SO IT HAS TO BE LOUD HERE.
           *
           * Letting it out would abandon the loop with messages still in
           * `pending`, and this person would never be answered again — the
           * failure this whole file exists to make impossible. The turn body in
           * `main.ts` already apologises to the sender on its own catch; this
           * line is for whoever reads the log.
           */
          this.log(`[queue] 🔴 ${key}: the turn threw and was contained: ${(e as Error).message}`);
        } finally {
          for (const b of batch) b.done();
        }
      }
    } finally {
      /**
       * 🔴 THE LOOP CAN ALSO BE LEFT BY A THROW, AND THAT PATH ORPHANS MESSAGES.
       *
       * `settle()` and `log()` are INJECTED and sit outside the inner try, so a
       * throw from either abandons the loop with items still in `pending` —
       * their `done()` never called, their submitters hanging forever, their
       * messages never answered. Neither can throw as shipped, which is exactly
       * why it would go unnoticed the day one can.
       *
       * So nothing leaves this function still owed a resolution. A dropped
       * message is bad; a dropped message that also HANGS its caller is worse,
       * and the caller here is `replayMissed`, which awaits it.
       */
      if (lane.pending.length > 0) {
        this.log(
          `[queue] 🔴 ${key}: the drain loop was abandoned with ${lane.pending.length} message(s) ` +
            'still queued. They will NOT be answered. This should be unreachable — read what threw above it.',
        );
        for (const q of lane.pending) q.done();
        lane.pending.length = 0;
      }
      /**
       * 🔴 NO `await` BETWEEN THE LOOP TEST ABOVE AND THIS LINE. See the header.
       * A message accepted into a lane after the last drain has given up is a
       * message nobody will ever answer. The straggler loop above is synchronous
       * and so does not open that window.
       */
      this.lanes.delete(key);
    }
  }
}
