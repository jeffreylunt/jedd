import type { Config } from './config.js';
import type { Tool } from './tools/types.js';

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Present on assistant messages that requested tools. */
  toolCalls?: LlmToolCall[];
  /** Present on tool messages: which call this answers. */
  toolCallId?: string;
  toolName?: string;
}

export interface LlmReply {
  text: string;
  toolCalls: LlmToolCall[];
}

export interface LlmClient {
  readonly label: string;
  chat(messages: LlmMessage[], tools: Tool[]): Promise<LlmReply>;
}

function toOllamaMessages(messages: LlmMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', content: m.content, tool_name: m.toolName };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content,
        tool_calls: m.toolCalls.map((c) => ({
          function: { name: c.name, arguments: c.arguments },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

/**
 * Ollama client for the pinned local model, `qwen3.8:27b-mlx`.
 *
 * Every setting below was MEASURED against the live endpoint by
 * `scripts/probe-ollama.mjs`, not inherited. See
 * `spaces/jedd-v2/knowledge/qwen3-8-27b-mlx-measured.md`.
 *
 *  - `think: true` — Jeff wants thinking and will pay latency for it. Reasoning
 *    cost 137–320 characters across the probe, so the feared empty-output trap
 *    is a BUDGET failure, not an argument against thinking.
 *  - `num_predict: 3000` — ~16× the largest reasoning burst observed, so
 *    thinking cannot eat the whole allowance before an answer is emitted.
 *  - `num_ctx: 16384` — keeps the model FULLY resident (`/api/ps` reported
 *    `size_vram === size`). Do not raise it to buy thinking headroom; that is
 *    what spills to CPU and produces 110s turns.
 *  - `keep_alive: '30m'` — an ~18 GB model must not cold-reload mid-conversation.
 *  - `tool_choice` is NOT sent. It is silently ignored by this stack (verified:
 *    `tool_choice:"required"` on a message needing no tool returned no call).
 *    Sending it would imply a guarantee that does not exist.
 */
/**
 * Wall clock for ONE MODEL CALL — not one turn. See `MAX_STEPS` in `agent.ts`:
 * a single turn makes up to that many of these, so a turn's worst case is the
 * product, not this number.
 *
 * ⚠️ EXPORTED because `presence.ts` derives the typing-indicator ceiling from
 * it. They were two independent magic numbers (900_000 and 360_000) and the
 * indicator died at 6 minutes on a turn that ran 787 seconds and completed
 * fine. Changing one now forces you past the other.
 */
export const TURN_TIMEOUT_MS = 900_000;

export class OllamaClient implements LlmClient {
  readonly label: string;

  constructor(private readonly config: Config) {
    this.label = `ollama:${config.llm.model}`;
  }

  async chat(messages: LlmMessage[], tools: Tool[]): Promise<LlmReply> {
    // Wall clock for ONE model turn, including a cold model load.
    //
    // RAISED 240s -> 900s on 2026-08-26 at Jeff's explicit request, after this
    // timeout silently killed the same real request TWICE in twenty minutes.
    // Measured both times: "Give me the other 14" (a 14-item list) aborted at
    // ~240s. The first failure ALSO involved a cold load -- the ollama runner
    // started the same second the message arrived and took ~10 min -- but the
    // SECOND failed on a model that was already resident and demonstrably
    // generating (runner CPU climbing 2.2 -> 11.6%). So a cold load is NOT
    // required to blow this budget: a long enough generation does it alone.
    //
    // WHAT THIS DOES NOT FIX, and it is the worse half: an abort here is
    // SILENT. There is no user-facing message, so a killed turn and a message
    // that never arrived look identical to whoever sent it. Raising the ceiling
    // makes the failure rarer, not visible. A "still working" signal is the
    // real fix and is tracked separately.

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${this.config.llm.baseUrl.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.config.llm.model,
          messages: toOllamaMessages(messages),
          tools: tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
          stream: false,
          think: true,
          keep_alive: '30m',
          options: { temperature: 0.2, num_ctx: 16384, num_predict: 3000 },
        }),
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const body = (await res.json()) as {
      done_reason?: string;
      message?: {
        content?: string;
        thinking?: string;
        tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[];
      };
    };

    const raw = body.message?.tool_calls ?? [];
    const toolCalls: LlmToolCall[] = raw.flatMap((call, i) => {
      const name = call.function?.name;
      if (!name) return [];
      let args: Record<string, unknown> = {};
      const rawArgs = call.function?.arguments;
      if (typeof rawArgs === 'string') {
        try {
          args = JSON.parse(rawArgs) as Record<string, unknown>;
        } catch {
          args = {};
        }
      } else if (rawArgs && typeof rawArgs === 'object') {
        args = rawArgs as Record<string, unknown>;
      }
      // Ollama supplies its own call id; use it rather than inventing one.
      return [{ id: call.id ?? `call_${Date.now()}_${i}`, name, arguments: args }];
    });

    const text = body.message?.content ?? '';

    // ⚠️ Empty content on a TOOL-CALLING turn is normal — the model returns a
    // call and no prose. The real budget failure is `done_reason: "length"` with
    // nothing to show for it, so that is what gets flagged, not emptiness.
    if (body.done_reason === 'length' && !text.trim() && toolCalls.length === 0) {
      throw new Error(
        'Model hit its token budget without producing an answer or a tool call ' +
          '(done_reason=length). Reasoning consumed the whole num_predict allowance.',
      );
    }

    // `message.thinking` is deliberately NOT returned. It is reasoning, not reply,
    // and must never reach the user or the transcript.
    return { text, toolCalls };
  }
}

/**
 * Is the model endpoint actually there, and does it have the model we ask for?
 *
 * 🔴 WARN, NEVER FATAL — AND THE DISTINCTION IS THE WHOLE DESIGN.
 *
 * Config PRESENCE is statically checkable and cannot become true later, so
 * hard-failing on it is right. REACHABILITY is a fact about this second: an
 * Ollama that is restarting at 03:00 is serving again at 03:05. Exiting on it
 * would convert a two-minute blip into a dead bot, and under a supervisor into
 * a restart loop. So this reports and returns; it never decides.
 *
 * ⚠️ IT IS NOT DECORATION. Nothing else contacts the model before serving, and
 * a wrong `LLM_BASE_URL` produces the worst failure this system has: the process
 * boots, the healthcheck passes, the webhook registers, and then EVERY turn
 * throws — so a person texts and gets silence, indefinitely, with the only
 * evidence in a log. This line is the difference between finding that out at
 * boot and finding it out from a user who thinks the bot is ignoring them.
 */
export async function probeLlm(
  config: Config,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; detail: string }> {
  const base = config.llm.baseUrl.replace(/\/$/, '');
  try {
    const r = await fetchImpl(`${base}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    if (!r.ok) return { ok: false, detail: `${base} answered http ${r.status}` };
    const body = (await r.json()) as { models?: { name?: string }[] };
    const names = (body.models ?? []).map((m) => m.name).filter(Boolean) as string[];
    if (!names.includes(config.llm.model)) {
      /**
       * Reachable but WITHOUT the configured model is its own failure, and a
       * distinct one: the endpoint answers, so every connectivity check passes,
       * and the model name is only wrong at generation time. Name what IS there
       * — a typo is obvious next to the real list and invisible on its own.
       */
      return {
        ok: false,
        detail:
          `${base} is reachable but has no model named "${config.llm.model}". ` +
          `It offers: ${names.slice(0, 8).join(', ') || '(none)'}${names.length > 8 ? ', …' : ''}`,
      };
    }
    return { ok: true, detail: `${base} has ${config.llm.model}` };
  } catch (e) {
    return { ok: false, detail: `${base} is unreachable: ${(e as Error).message}` };
  }
}

export function createLlmClient(config: Config): LlmClient {
  switch (config.llm.provider) {
    case 'ollama':
      return new OllamaClient(config);
    case 'anthropic':
      throw new Error(
        'The Anthropic client is not implemented yet — the LlmClient interface is the seam for it. ' +
          'Set LLM_PROVIDER=ollama.',
      );
    default:
      throw new Error(`Unknown LLM provider: ${String(config.llm.provider)}`);
  }
}
