/**
 * ── THE SECOND LOOK: ONE MORE MODEL ROUND BEFORE A CAPABILITY DENIAL SHIPS ───
 *
 * 🔴 WHAT THIS IS FOR, IN ONE SENTENCE: Jedd has told Jeff four times that it
 * could not do something it could do, and a false denial CLOSES THE QUESTION —
 * it is confident, fluent, and reads as a design limit rather than a defect.
 *
 * Measured instances, all from `data/audit.jsonl`, all `role=owner`:
 *
 *   2026-08-24 22:07  "I don't have a tool to flip monitoring on for an
 *                      existing season"        → `add_season` was registered.
 *   2026-08-24 22:50  Jedd, unprompted, 43 minutes later: *"My earlier 'I can't
 *                      do this' was wrong — I had the tool all along."*
 *   2026-08-26 17:26  "Still no write tool on my side — I can only read"
 *   2026-08-26 17:33  "I have no write tool for Prowlarr, only read"
 *                                              → `indexer_admin` was registered,
 *                      and the same process used it 13 minutes later.
 *   2026-08-28 23:15  "I can only see live sessions, not watch history … that's
 *                      not something I can pull"
 *                                              → `homelab_read` had rendered 14
 *                      watched titles for the same owner 49 hours earlier.
 *
 * The last one cost more than a wrong sentence: Jeff's next message was a
 * feature request for a capability he already owned.
 *
 * ── 🔴 THE TWO GENERATOR SHAPES, AND WHY THE OBVIOUS FIX ONLY COVERS ONE ─────
 *
 * The fix proposed on `task-2026-08-26T17-49-38Z` was to cross-check a denial
 * against the registered tool list. That works on:
 *
 *   NAMED    "I have no write tool for PROWLARR" — names a tool class, so a
 *            registry lookup has something to look up.
 *
 * It has NOTHING TO GRAB on:
 *
 *   UNNAMED  "that's not something I can pull" — names no tool, no service, no
 *            verb that maps to one. A registry lookup cannot fire on it.
 *
 * ⚠️ A registry cross-check would therefore be a DEFENCE THAT COVERS ONE
 * INSTANCE OF A CLASS WHILE READING AS THOUGH IT COVERS THE CLASS — working
 * code, described in words that make every future reader see the hazard handled
 * and move on. That shape is why these instances survived three readers. It is
 * deliberately NOT what this file does.
 *
 * ── WHY THE ADJUDICATOR HAS TO BE THE MODEL, AND THIS IS THE LOAD-BEARING
 *    ARGUMENT — READ IT BEFORE REPLACING THIS WITH SOMETHING CHEAPER ─────────
 *
 * To decide whether an UNNAMED denial is false, you must answer: *does any
 * registered tool answer what was asked?* **That is the tool-selection problem
 * itself.** If code could decide it, the model would not have got it wrong in
 * the first place — a local, model-free guard that adjudicates the unnamed shape
 * is asking the code to succeed at exactly the task the model just failed.
 *
 * So there is no sound purely-lexical verdict here, and this file does not
 * pretend to one. It splits the job:
 *
 *   DETECTING that a denial was made   — lexical, imprecise, FAIL-OPEN (below).
 *   DECIDING whether it is true        — handed back to the model, with its own
 *                                        tool list and one instruction.
 *
 * The detector is allowed to be a heuristic BECAUSE it never decides anything.
 * Its only power is to spend one more model round. A miss is the status quo; a
 * false fire costs latency and cannot change a correct answer into a wrong one,
 * because the second round has the same tools behind the same role gate.
 *
 * ── 🔴 THIS IS NOT OUTPUT FILTERING, AND THE DIFFERENCE IS NOT A QUIBBLE ─────
 *
 * README: *"the code's job is to decide what may be called — not to police what
 * gets said. There is no output filtering anywhere in the loop."* That still
 * holds. Nothing here rewrites, blocks, or vetoes a reply. The ONLY thing this
 * can do is give the model one more turn with a note. If it says the same thing
 * again, that is what is sent, verbatim. Code never composes user-facing text
 * and never suppresses any.
 */

/**
 * Words that make a sentence a claim about JEDD'S INSTRUMENTS rather than about
 * the world.
 *
 * 🔴 THE ANCHOR IS THE CAPABILITY NOUN, NOT THE NEGATION, AND THAT DISTINCTION
 * IS THE WHOLE PRECISION STORY.
 *
 * Matching "I can't" alone fires on 26% of real turns (67 of 262 in
 * `data/audit.jsonl`), and most of those are honest reports of an OUTCOME:
 *
 *   "No channels are listed for it yet, so I can't say where to watch"   ← fine
 *   "the search timed out, so I can't tell you what's available"          ← fine
 *
 * Those are grounded in something a tool returned this turn. The defect is the
 * other thing — a claim about the SET OF INSTRUMENTS:
 *
 *   "I have no write tool for Prowlarr"
 *   "I don't have a tool to flip monitoring on"
 *   "that's not something I can pull"
 *
 * Requiring a capability noun ("tool", "access", "way to", "scheduler") or a
 * self-scoping construction ("I can only…", "my only…", "not something I can…")
 * takes the trigger from 26% of turns to 11%, and every known false denial
 * except one is still caught.
 */
const CAPABILITY_DENIAL =
  // "no tool" / "not have a tool" / "don't have a results tool" / "no write tool for Prowlarr"
  /(?:\bno\b|\bnot\b|n'?t)\s+(?:\w+\s+){0,4}(?:tools?|access|scheduler|way\s+to|means\s+to)\b/i
    .source +
  '|' +
  [
    /\btool\s+(?:for|to)\s+that\b/,
    // 🔴 THE UNNAMED SHAPE. This is the one the registry cross-check cannot see,
    // and it is the phrasing that cost Jeff a spurious feature request.
    /\b(?:not|isn'?t)\s+something\s+I\s+can\b/,
    // "I can only see live sessions, not watch history" — a scope limit read off
    // ONE tool's result and reported as the boundary of the system.
    /\bI\s+can\s+only\b/,
    /\bI\s+only\s+have\b/,
    /\bmy\s+only\b/,
    /\ball\s+I\s+(?:have|can)\b/,
    /\bonly\s+(?:\w+\s+){0,2}tools?\b/,
    /\bnothing\s+I\s+can\b/,
    /\bthe\s+limit\s+of\s+what\s+I\s+can\b/,
    /\bout\s+of\s+reach\b/,
    /\bI\s+(?:have|'?ve\s+got)\s+no\b/,
    /\bowner-only\b/,
  ]
    .map((r) => r.source)
    .join('|');

const DENIAL_RE = new RegExp(CAPABILITY_DENIAL, 'i');

/**
 * Does this reply READ AS a claim about what Jedd can do?
 *
 * 🔴 NAMED "READS AS" ON PURPOSE, AND DO NOT RENAME IT TO `isCapabilityDenial`.
 *
 * It is a phrase list. Phrase lists cannot catch a register — a paraphrase this
 * one has never seen ("Tom's viewing isn't visible from here") walks straight
 * past it, and no amount of adding alternatives changes that in kind. A name
 * asserting it *is* a denial would be the same overclaim this whole file exists
 * to avoid, one layer down.
 *
 * MEASURED against all 262 turns of `data/audit.jsonl` (see
 * `test/capability-denial.test.ts`, which pins the numbers):
 *
 *   fires on           30 of 262 turns  (11%)
 *   precision          ~90% against hand labels
 *   recall             79% of hand-labelled capability denials
 *   known FALSE denials caught  11 of 12
 *
 * The one it misses is the 2026-08-26 03:04 identity denial ("I can't tell who
 * I'm talking to over here"), which is a DIFFERENT defect and was already fixed
 * at its own root — `whoIsSpeaking` in `src/agent.ts` now states the role as a
 * fact. It is left uncaught deliberately rather than bolted on here.
 *
 * ⚠️ 79% IS NOT 100% AND THE GAP IS NOT CLOSEABLE BY EDITING THIS LIST. Read it
 * as: this catches the shapes Jedd has actually used, on the traffic we have.
 * The failure direction is safe — a miss leaves the turn exactly as it is today.
 */
export function readsAsCapabilityDenial(replyText: string): boolean {
  return DENIAL_RE.test(replyText);
}

/**
 * Did something IN THIS TURN license the model to say it could not do the thing?
 *
 * ── 🔴 A REFUSAL LICENSES IT ABSOLUTELY, AND NOT TO SAVE A MODEL CALL ────────
 *
 * The system prompt is explicit: *"If a tool fails or refuses, say so plainly…
 * Do not look for another way around a refusal — the refusal is the answer."*
 * Nudging the model to look again after the permission gate has spoken would
 * contradict a deliberate rule and push it toward routing AROUND that gate —
 * turning a guard against a wrong SENTENCE into pressure toward a wrong ACTION.
 * That is a far worse trade than the one this file is making, so a refused call
 * ends the question whatever else happened in the turn.
 *
 * ── ⚠️ A FAILURE ONLY LICENSES IT IF NOTHING ELSE WORKED, AND THIS RULE WAS
 *    WRONG UNTIL A TEST CAUGHT IT ────────────────────────────────────────────
 *
 * This used to read `toolCalls.some((c) => !c.ok)` — ANY failure licensed the
 * denial. That waved through one of the three denials PROVEN false: on
 * 2026-08-26 at 16:25Z the model called `homelab_read` six times, two failed and
 * **four succeeded**, and it then reported its own choice of `limit` as the
 * endpoint's boundary — *"items 16–28 are out of reach through this endpoint"* —
 * when that tool's schema, in its context, offered `limit` up to 200.
 *
 * A guard whose skip condition covers a third of the cases it exists for is
 * complete on paper and inert in production, and nothing about it would have
 * looked wrong. So: a turn where something WORKED is not a turn where the model
 * was blocked. Only a clean sweep of failures is evidence of an obstruction.
 */
export function turnLicensedTheDenial(toolCalls: { ok: boolean; refused?: boolean }[]): boolean {
  if (toolCalls.some((c) => c.refused === true)) return true;
  return toolCalls.length > 0 && toolCalls.every((c) => !c.ok);
}

/**
 * The note pushed into history before the extra round.
 *
 * 🔴 IT NAMES THE INFERENCE, NOT THE PHRASING. The 2026-08-28 failure was not a
 * wording slip: `jellyfin_sessions` returned a TRUE result (two idle sessions)
 * and the model converted THE SCOPE OF THAT ONE RESULT into a claim about the
 * system — "sessions is all I can see" — while `homelab_read` held the rest.
 * A note that said "be careful how you word denials" would not touch that. This
 * one names the bad step: a tool's result bounds THAT TOOL, never the registry.
 *
 * ⚠️ IT MUST NOT SAY "you are probably wrong" OR "call a tool". Both instruct an
 * outcome rather than a check, and a model that complies with either turns a
 * true denial into a fabricated capability or a pointless call. The instruction
 * is to LOOK, and to keep the answer if looking confirms it — so the honest
 * denials in the 11% cost a round trip and nothing else.
 *
 * ⚠️ IT SAYS "THIS ASSISTANT", NOT "YOU TOLD THIS USER". It fires for guests
 * too, and a guest has never been told any such thing — a note that opens with a
 * false statement about the conversation it is in would be the model's own
 * unsupported-assertion defect, written by us, in the fix for it.
 */
export const SECOND_LOOK_NOTE =
  'Before that reply is sent: it tells the user something cannot be done. That is a claim about ' +
  'YOUR TOOL LIST, and it is the one kind of claim this assistant has got wrong before — saying ' +
  'it had no tool for something that was in its list the whole time.\n' +
  'A tool result describes THAT TOOL. It never describes the boundary of what you can do. If one ' +
  'tool returned something narrow, that bounds the tool, not you.\n' +
  'So read your tool list again now, all of it, including the general-purpose ones that do not ' +
  'have the obvious name for this request. If one of them could answer what was asked, use it. If ' +
  'you look and none of them can, say the same thing again — a confirmed "no" is a good answer, ' +
  'and repeating it costs nothing.';
