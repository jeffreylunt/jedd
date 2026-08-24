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
 * Ollama-backed client (the homelab's local qwen3.8:27b-mlx).
 *
 * Two measured quirks of this stack are handled here rather than discovered
 * again later:
 *  - `think: false` is required for qwen3.x or the token budget is spent on
 *    hidden reasoning and the reply comes back empty.
 *  - `tool_choice` is silently dropped by Ollama, so there is NO forced tool
 *    calling available. The loop must not depend on forcing.
 */
export class OllamaClient implements LlmClient {
  readonly label: string;

  constructor(private readonly config: Config) {
    this.label = `ollama:${config.llm.model}`;
  }

  async chat(messages: LlmMessage[], tools: Tool[]): Promise<LlmReply> {
    const res = await fetch(`${this.config.llm.baseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.llm.model,
        messages: toOllamaMessages(messages),
        tools: tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
        stream: false,
        think: false,
        options: { temperature: 0.2, num_ctx: 16384 },
      }),
    });

    if (!res.ok) {
      throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const body = (await res.json()) as {
      message?: {
        content?: string;
        tool_calls?: { function?: { name?: string; arguments?: unknown } }[];
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
      return [{ id: `call_${Date.now()}_${i}`, name, arguments: args }];
    });

    return { text: body.message?.content ?? '', toolCalls };
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
