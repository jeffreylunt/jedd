/**
 * Replay real V1 turns through V2's loop and record what V2 WOULD have said.
 *
 * ── WHY OFFLINE RATHER THAN LIVE ─────────────────────────────────────────────
 *
 * V1 and V2 share one Ollama on one Mac (`qwen3.8:27b-mlx`, 23.8 GB, and
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

const CORPUS = '/Users/jeff/.superbot2/spaces/jedd-v2/corpus/v1-parity-corpus.jsonl';
const OUT = '/Users/jeff/.superbot2/spaces/jedd-v2/corpus/v2-replay.jsonl';

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

  // Spread the sample across the whole 5.5 months rather than taking the tail,
  // or the result describes one week's traffic and calls it the corpus.
  const step = Math.max(1, Math.floor(all.length / limit));
  const sample = all.filter((_, i) => i % step === 0).slice(0, limit);

  const config = loadConfig();
  if (!config.readOnly) throw new Error('replay refuses to run with JEDD_ALLOW_WRITES set');

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

  for (const [i, turn] of sample.entries()) {
    // A fresh Agent per turn: the corpus has no session continuity, and reusing
    // one would leak an earlier sender's history into a later turn.
    const agent = new Agent(config, llm as never, undefined, tools);
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
      `  [${i + 1}/${sample.length}] ${turn.user.slice(0, 44).padEnd(44)} ` +
        `-> ${toolNames.join(',') || '(no tool)'} ${Date.now() - started}ms${error ? ' ERROR' : ''}`,
    );
  }

  console.error(`\ndone: ${sample.length} turns, ${noTool} with no tool call, ${errors} errors`);
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
