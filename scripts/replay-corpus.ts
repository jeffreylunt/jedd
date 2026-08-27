/**
 * Replay real V1 turns through V2's loop and record what V2 WOULD have said.
 *
 * ── WHY OFFLINE RATHER THAN LIVE ─────────────────────────────────────────────
 *
 * V1 and V2 share one Ollama on one Mac (`qwen3.8:27b`, 23.8 GB, and
 * `/api/ps` shows it unloaded between turns). A LIVE shadow means a household
 * message triggers a V1 turn AND a V2 turn for the same model at the same
 * moment — adding latency to Jeff's working bot, whose p90 is already 85 s.
 *
 * Replaying the corpus instead is better on every axis: **zero load on the live
 * message path, reproducible, and it compares against V1's ACTUAL replies**
 * rather than whatever turns happen to arrive tonight.
 *
 * ── 🔴 WRITES ARE BLOCKED AT THE FETCH BOUNDARY, NOT BY CONFIG ───────────────
 *
 * `config.readOnly` decides which tools get REGISTERED. That is a different
 * thing from "no request can mutate the homelab", and only the second is safe to
 * run 800 times unattended against real services. So every non-GET is refused in
 * the transport itself: a tool that ignored the flag, a tool nobody audited, and
 * a tool written next week are all covered by the same barrier.
 *
 * This is V1's own harness discipline, and it is the half that made its results
 * trustworthy.
 */
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Agent } from '../src/agent.js';
import { loadConfig } from '../src/config.js';
import { createLlmClient } from '../src/llm.js';
import { buildTools } from '../src/tools/index.js';

// Dev-only replay harness. The corpus lives outside the repo (it holds real
// conversation transcripts and must never be committed), so its location is
// configuration rather than a constant.
const CORPUS = process.env.REPLAY_CORPUS ?? './corpus/v1-parity-corpus.jsonl';
const OUT = process.env.REPLAY_OUT ?? './corpus/v2-replay.jsonl';

/**
 * The handle to replay as OWNER, so the OWNER path is measured, not assumed.
 *
 * Sourced from `JEDD_REPLAY_OWNER_HANDLE`, falling back to the configured
 * `OWNER_HANDLE`. It exists as a separate variable because the live shadow runs
 * with a SYNTHETIC owner handle, and a replay wants the real one — but the value
 * is never hardcoded here. An unset override simply replays as whoever
 * `OWNER_HANDLE` names, which is the safe reading: it cannot silently promote a
 * handle that the running config does not already treat as the owner.
 */
const REPLAY_OWNER = process.env.JEDD_REPLAY_OWNER_HANDLE?.trim();

/**
 * 🔴 CONVERSATIONS, NOT ISOLATED TURNS.
 *
 * The first version of this harness replayed each turn with a fresh agent, so V2
 * got NO history while V1's reply had been made WITH it. Continuations —
 * *"The first one"*, *"is season 2 of it all there?"*, *"How about now?"* — were
 * then scored against a V1 that could see the thread. That is not an unfavourable
 * comparison, it is a MEANINGLESS one, and continuations are common traffic.
 *
 * Turns are grouped into conversations by sender and gap, and one Agent serves a
 * whole conversation so history accumulates exactly as it would live.
 */
const CONVERSATION_GAP_MS = 30 * 60 * 1000;

interface CorpusTurn {
  rowid: number;
  at: string;
  sender: string;
  user: string;
  v1_reply: string | null;
  v1_latency_s: number | null;
}

/** Refuse every mutating request in the transport. Returns a report of attempts. */
function blockWritesAtFetchBoundary(): { attempts: string[] } {
  const attempts: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = String(input instanceof Request ? input.url : input);
    // Ollama's own chat endpoint is a POST and is not a homelab mutation.
    const isModel = url.includes('/api/chat') || url.includes('/api/generate');
    if (method !== 'GET' && !isModel) {
      attempts.push(`${method} ${url}`);
      throw new Error(
        `WRITE BLOCKED AT THE FETCH BOUNDARY: ${method} ${url}. The replay harness refuses every ` +
          'non-GET so a tool that ignores config.readOnly still cannot mutate the homelab.',
      );
    }
    return real(input as RequestInfo, init);
  }) as typeof fetch;
  return { attempts };
}

async function main(): Promise<void> {
  const limit = Number(process.argv[2] ?? 20);
  const stub = process.argv.includes('--stub');

  const blocked = blockWritesAtFetchBoundary();

  const all = readFileSync(CORPUS, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as CorpusTurn);

  // Group into conversations: same sender, and no gap longer than the threshold.
  const convs: CorpusTurn[][] = [];
  for (const t of all) {
    const last = convs[convs.length - 1];
    const prev = last?.[last.length - 1];
    const sameThread =
      prev && prev.sender === t.sender &&
      Date.parse(t.at) - Date.parse(prev.at) < CONVERSATION_GAP_MS;
    if (sameThread) last!.push(t);
    else convs.push([t]);
  }
  // Prefer MULTI-TURN conversations: single-turn ones cannot exercise the very
  // thing this rewrite exists to measure.
  const multi = convs.filter((c) => c.length > 1);
  const step = Math.max(1, Math.floor(multi.length / limit));
  const sample = multi.filter((_, i) => i % step === 0).slice(0, limit);
  console.error(
    `${all.length} turns -> ${convs.length} conversations (${multi.length} multi-turn); ` +
      `replaying ${sample.length} conversations`,
  );

  const base = loadConfig();
  if (!base.readOnly) throw new Error('replay refuses to run with JEDD_ALLOW_WRITES set');
  // 🔴 Measure the OWNER path. It carries the write privileges, so it cannot ship
  // unmeasured — and offline, with writes blocked at the transport, setting this
  // costs nothing. The live shadow keeps the synthetic handle.
  const config = REPLAY_OWNER ? { ...base, ownerHandle: REPLAY_OWNER } : base;

  const llm = stub
    ? {
        label: 'stub',
        // A stub that calls no tool and echoes — enough to prove the HARNESS,
        // and it costs no model time. Validate the instrument before spending
        // an hour of inference on it.
        chat: async () => ({ text: 'stub reply', toolCalls: [] }),
      }
    : createLlmClient(config);

  const tools = buildTools(config);
  console.error(`replaying ${sample.length} of ${all.length} turns · model=${llm.label}`);
  console.error(`tools=${tools.map((t) => t.name).join(', ')}`);

  mkdirSync(dirname(OUT), { recursive: true });
  let noTool = 0;
  let errors = 0;

  for (const [ci, conv] of sample.entries()) {
   // ONE agent per conversation, so history accumulates as it would live.
   const agent = new Agent(config, llm as never, undefined, tools);
   const role = conv[0]!.sender === config.ownerHandle ? 'owner' : 'guest';
   console.error(`\n-- conversation ${ci + 1}/${sample.length} (${role}, ${conv.length} turns) --`);
   for (const turn of conv) {
    const started = Date.now();
    let replyText = '';
    let toolNames: string[] = [];
    let steps = 0;
    let error: string | null = null;
    try {
      const rec = await agent.handle(turn.sender, turn.user);
      replyText = rec.replyText;
      toolNames = rec.toolCalls.map((c) => c.name);
      steps = rec.steps;
    } catch (e) {
      error = (e as Error).message;
      errors += 1;
    }
    if (toolNames.length === 0) noTool += 1;
    appendFileSync(
      OUT,
      `${JSON.stringify({
        conversation: ci,
        role,
        rowid: turn.rowid,
        at: turn.at,
        sender: turn.sender,
        user: turn.user,
        v1_reply: turn.v1_reply,
        v2_reply: replyText,
        v2_tools: toolNames,
        v2_steps: steps,
        v2_ms: Date.now() - started,
        error,
      })}\n`,
      'utf8',
    );
    console.error(
      `  ${turn.user.slice(0, 46).padEnd(46)} -> ${toolNames.join(',') || '(no tool)'} ` +
        `${Date.now() - started}ms${error ? ' ERROR' : ''}`,
    );
   }
  }

  const turns = sample.reduce((n, c) => n + c.length, 0);
  console.error(`\ndone: ${turns} turns in ${sample.length} conversations, ${noTool} with no tool call, ${errors} errors`);
  console.error(
    blocked.attempts.length
      ? `🔴 ${blocked.attempts.length} WRITE ATTEMPT(S) BLOCKED: ${blocked.attempts.join('; ')}`
      : '✅ no write was attempted at the fetch boundary',
  );
  console.error(`written: ${OUT}`);
}

main().catch((e) => {
  console.error(`fatal: ${(e as Error).message}`);
  process.exit(1);
});
