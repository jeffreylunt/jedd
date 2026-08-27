/**
 * WHEN A REPLY SHOULD QUOTE THE MESSAGE IT IS ANSWERING.
 *
 * iMessage can anchor a reply to one specific earlier message ("reply to a
 * specific message" in the UI; `selectedMessageGuid` on the wire). Jeff asked
 * for it in exactly one situation and explicitly scoped out the rest:
 *
 *   "if the user sends more than one message before a response from Jedd, we
 *    should have Jedd reply to the specific message so it is clear that it
 *    isn't responding to the most recent one. Only in that case."
 *
 * ── WHY THIS IS A BURST COUNT AND NOT "IS THIS THE NEWEST MESSAGE" ──────────
 *
 * Turns run CONCURRENTLY. `BlueBubblesReceiver` kicks each webhook off with
 * `void this.ingest(...)`, so two messages sent 3 seconds apart are two turns in
 * flight at once, each answering its own message and knowing nothing about the
 * other. That is what produces the confusion Jeff is describing: the reply to
 * the FIRST message lands after the second one is already on screen.
 *
 * The obvious rule — "thread it if this is not their newest message" — gets the
 * late reply right and the other one wrong. When the reply to the SECOND message
 * goes out, that message *is* the newest, so the rule sends it plain — but the
 * person is staring at two unanswered messages and still cannot tell which one
 * a bare reply belongs to. Both replies in that exchange are ambiguous, so both
 * need anchoring, which is also the literal reading of Jeff's sentence: they
 * sent more than one message before a response.
 *
 * So the unit is the BURST: the messages from one person that are in play at the
 * same time. A burst opens when a message arrives, grows while replies are still
 * owed, and disappears once every message in it has been answered. One message
 * in the burst — the ordinary one-in-one-out exchange — sends plain, because an
 * unnecessary reply-quote is visual noise and Jeff ruled it out.
 *
 * ── WHICH MESSAGE A REPLY TARGETS IS NOT A GUESS ────────────────────────────
 *
 * There is no heuristic here for picking the target and there must not be one.
 *
 * ⚠️ AMENDED 2026-08-27. This paragraph used to argue from *"`agent.handle` is
 * handed exactly ONE message's text; a turn is physically incapable of answering
 * two."* **That is no longer true** — `main.ts` now hands it a whole BURST,
 * joined — and it was never the load-bearing part anyway, because a second
 * concurrent turn was mutating the same history array while the first ran, so a
 * turn answered whatever had been pushed into it regardless of what it was
 * handed.
 *
 * The conclusion survives on a better premise: **one turn per burst** means the
 * batch IS the subject, and the reply addresses the batch's newest message the
 * way a person's own reply to a burst would. Still structural, still not
 * inference, and `decide()` is still only ever asked whether to anchor, never
 * where. A model-chosen or "most similar" target would be a guess layered on top
 * of a fact the code already holds.
 */

/**
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴 DISABLED 2026-08-26 — AND ITS PRECONDITION WAS MET ON 2026-08-27.
 *    STILL OFF, DELIBERATELY. READ THE "STATUS" BLOCK AT THE BOTTOM OF THIS
 *    COMMENT BEFORE ASSUMING IT IS STILL BLOCKED.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Everything in this file is correct about WHICH MESSAGE TRIGGERED A TURN, and
 * that turned out to be the wrong thing to anchor to.
 *
 * Measured on Jeff's own thread, and he spotted it before we did:
 *
 *   11:43:30 JEFF  "Yes run the search"
 *   11:45:24 JEFF  "How many people watching?"
 *   11:46:32 JEDD  "Nobody's watching — 5 sessions…"   anchored to "Yes run the search"
 *   11:47:39 JEDD  "The search works now…"             anchored to "How many people watching?"
 *
 * **Both answers are anchored to the other question.** The anchors are not
 * buggy — they are FAITHFUL. Turn start times reconstructed from the log
 * durations (180836ms and 133563ms) land at 11:43:31 and 11:45:25, one second
 * after each message, so each reply really was anchored to the message that
 * started its turn. What is crossed is the CONTENT: both turns called both tool
 * families (`find_gaps,search_episode…,jellyfin_sessions` and
 * `jellyfin_sessions,search_episode…`), each had every fact available, and each
 * answered the other one's question.
 *
 * The design note further down says a turn is handed one message's text and so
 * is structurally incapable of answering two. That is still true. The inference
 * drawn from it — that the turn therefore answers ITS OWN message — is what
 * died. **The trigger is not the subject.**
 *
 * So threading currently makes a SPECIFIC, CONFIDENT claim it cannot support,
 * and that is worse than the ambiguity it was built to remove: an unanchored
 * reply is merely unclear, an inverted one asserts "I am answering *this*"
 * while answering something else.
 *
 * ⚠️ THIS IS NOT A THREADING BUG AND MUST NOT BE "FIXED" HERE. Threading is the
 * instrument that made a pre-existing defect visible for the first time —
 * Jedd has been answering the wrong question for as long as two turns have run
 * concurrently, and before anchoring there was no way to see it, because a bare
 * reply is read as answering whatever is newest. Turning this flag on again
 * without repairing trigger→content re-hides the defect; deleting this file
 * loses the only detector.
 *
 * TO RE-ENABLE: the mapping from trigger to content must be sound — one turn
 * per burst, or a turn that cannot answer outside its own message. If neither
 * is achievable, the open question is whether to anchor on the message the
 * answer is ABOUT rather than the one that triggered the turn, which means a
 * heuristic. That was correctly refused while the trigger was believed
 * reliable; that premise is now dead, so the choice is a heuristic or nothing.
 *
 * ── 🔴 STATUS 2026-08-27: THE PRECONDITION IS MET. THE FLAG IS STILL FALSE. ──
 *
 * `src/turn-queue.ts` delivers **one turn per burst** — the first of the two
 * options named above, exactly as written. Concurrent turns for one sender are
 * no longer possible, so the trigger→content mapping is sound again and the
 * reason this flag was switched off no longer exists.
 *
 * It stays `false` anyway, and NOT by inertia. Flipping it is a separate change
 * with its own live verification: anchoring has never once been observed against
 * a coalesced burst, and the open question it raises is new — a batch of N
 * messages produces ONE reply, so `decide()` sees `burstSize >= 2` and anchors
 * it to the newest, which is *probably* right and has never been seen on a real
 * phone. Shipping two unverified behaviours in one restart is how you end up
 * unable to say which one broke.
 *
 * ⚠️ A DATED GATE WHOSE CONDITION HAS QUIETLY BEEN MET READS AS STILL-BLOCKED
 * FOREVER. That is why this paragraph exists rather than nothing. Whoever picks
 * this up: the blocker is discharged, the work left is verification, not repair.
 */
export const REPLY_THREADING_ENABLED = false;

/**
 * 🔴 A BURST HAS TO BE ABLE TO EXPIRE, OR ONE LOST TURN THREADS FOREVER.
 *
 * `answered()` runs on the send path. A turn that throws inside the model call
 * never reaches a send, so its message would sit in the burst permanently and
 * every later reply to that person would be anchored — a cosmetic bug with no
 * symptom except that Jeff eventually asks why everything is quoted.
 *
 * The bound is not a cleanup pass, it is part of the QUESTION: a message nobody
 * answered twenty minutes ago is not "in play" any more, whatever the reason.
 * It sits above the 900s model-turn timeout so a legitimately slow turn is never
 * expired out from under itself.
 */
export const BURST_TTL_MS = 20 * 60 * 1000;

/** Defensive cap on distinct senders held at once. Bursts are seconds-to-minutes long. */
const MAX_SENDERS = 200;

export interface ThreadDecision {
  /** The guid to anchor to, or `null` for an ordinary un-quoted reply. */
  replyTo: string | null;
  /** How many of this person's messages were in play. 1 is the ordinary case. */
  burstSize: number;
  /** Why, in words, for the turn log. */
  detail: string;
}

interface Pending {
  guid: string;
  at: number;
  answered: boolean;
}

/**
 * Tracks, per sender, which of their messages are still awaiting a reply.
 *
 * PURE apart from the clock — no I/O, no BlueBubbles, no network — so the whole
 * rule can be pinned by tests that pass a fake `now`, the same way
 * `classifyPayload` keeps the inbound rules away from the HTTP layer.
 */
export class ReplyThreading {
  private readonly bySender = new Map<string, Pending[]>();

  constructor(private readonly ttlMs: number = BURST_TTL_MS) {}

  /** A message has arrived and Jedd now owes this person a reply to it. */
  arrived(senderHandle: string, guid: string | null, now = Date.now()): void {
    // No guid, nothing to anchor to later — and counting it would inflate the
    // burst into threading replies to a message we cannot name.
    if (!guid) return;
    const burst = this.prune(senderHandle, now);
    if (burst.some((p) => p.guid === guid)) return; // BlueBubbles double-fires
    burst.push({ guid, at: now, answered: false });
    this.bySender.set(senderHandle, burst);
    if (this.bySender.size > MAX_SENDERS) {
      const oldest = this.bySender.keys().next();
      if (!oldest.done && oldest.value !== senderHandle) this.bySender.delete(oldest.value);
    }
  }

  /**
   * Should the reply to `guid` be anchored to it?
   *
   * ⚠️ NON-MUTATING. The send it is about can still fail, and closing the burst
   * on a decision rather than on an outcome would let a failed reply mark its
   * message answered.
   */
  decide(senderHandle: string, guid: string | null | undefined, now = Date.now()): ThreadDecision {
    if (!guid) {
      return {
        replyTo: null,
        burstSize: 0,
        detail: 'this message answers no specific incoming message (a follow-up, or a transport with no guids)',
      };
    }
    const burst = this.prune(senderHandle, now);
    const size = burst.length;
    if (size >= 2) {
      return {
        replyTo: guid,
        burstSize: size,
        detail: `${size} messages from this person are in play, so a bare reply would look like an answer to the newest one`,
      };
    }
    return {
      replyTo: null,
      burstSize: size,
      detail: 'one message in play — a plain reply is unambiguous, and a reply-quote here is noise',
    };
  }

  /** The reply to `guid` has gone out. Closes the burst once nothing is owed. */
  answered(senderHandle: string, guid: string | null | undefined, now = Date.now()): void {
    if (!guid) return;
    const burst = this.prune(senderHandle, now);
    const hit = burst.find((p) => p.guid === guid);
    if (hit) hit.answered = true;
    if (burst.every((p) => p.answered)) this.bySender.delete(senderHandle);
    else this.bySender.set(senderHandle, burst);
  }

  /** Messages currently in play for this sender. For tests and the turn log. */
  inPlay(senderHandle: string, now = Date.now()): number {
    return this.prune(senderHandle, now).length;
  }

  private prune(senderHandle: string, now: number): Pending[] {
    const burst = (this.bySender.get(senderHandle) ?? []).filter((p) => now - p.at < this.ttlMs);
    if (burst.length === 0) this.bySender.delete(senderHandle);
    else this.bySender.set(senderHandle, burst);
    return burst;
  }
}
