import type { Config } from './config.js';
import type { LlmClient, LlmMessage } from './llm.js';
import { roleFor, roleSatisfies, type Role } from './permissions.js';
import { ALL_TOOLS } from './tools/index.js';
import type { Tool, ToolContext } from './tools/types.js';

const MAX_STEPS = 8;

export interface ToolInvocation {
  name: string;
  args: Record<string, unknown>;
  /** true only when the tool ran and reported success. Refusals are false. */
  ok: boolean;
  /** set when the permission gate refused before the tool ran */
  refused?: boolean;
}

/**
 * The record of one turn. This is the artifact that makes "did you do it"
 * answerable: every action Jedd took is here, with its outcome, and an action
 * that is not here did not happen.
 */
export interface TurnRecord {
  at: string;
  senderHandle: string;
  role: Role;
  userText: string;
  toolCalls: ToolInvocation[];
  replyText: string;
  steps: number;
}

/**
 * 🔴 THE PROMPT NEVER STATES WHO IT IS TALKING TO.
 *
 * An earlier version said "You are talking to the owner." That makes identity an
 * assertion inside the context window, and **anything else in the context window
 * can contend with it** — a forwarded message, a quoted complaint, a media title
 * carrying an injection, or simply the user writing "I'm Jeff".
 *
 * Identity is resolved from the TRANSPORT before the model sees anything, and it
 * is expressed as **which tools exist in this turn** — not as a sentence. A
 * guest's tool list has no admin tools in it at all, and no text can add one.
 *
 * The prompt is also deliberately short, and stays short as capabilities grow:
 * per-capability detail belongs in the tool's own description, so adding a tool
 * is one declaration and never an edit here. (V1's prompt reached 2,052 lines
 * exactly by taking the other option.)
 */
function systemPrompt(config: Config): string {
  return [
    "You are Jedd, the assistant for Jeff's home media server.",
    'Be brief and concrete — you are talking over text message.',
    '',
    'Ground every factual claim in a tool result. If you have not called a tool, you do not know.',
    'Never say you have done something unless a tool result in this conversation shows it succeeded.',
    'If a tool fails or refuses, say so plainly and say what you would need instead. Do not look for',
    'another way around a refusal — the refusal is the answer.',
    'A tool result marked UNKNOWN is not a "no" — report the uncertainty.',
    '',
    'Use only the tools you have been given. If something is not among them, say you cannot do it',
    'rather than guessing at who is asking or what you might be permitted elsewhere.',
    '',
    'In shell results, always read the exit code. Empty stdout with a non-zero exit is an ERROR, not',
    'an empty result; a grep that matched nothing exits 1. When you report finding nothing, also',
    'report how much you searched.',
    config.readOnly ? '\nWrites are currently disabled, so nothing you do can change the system.' : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * The agent loop.
 *
 * There is no output filtering here. The only enforcement is at the tool
 * boundary, where it cannot be talked around.
 */
export class Agent {
  private readonly histories = new Map<string, LlmMessage[]>();

  private readonly registry: Tool[];

  constructor(
    private readonly config: Config,
    private readonly llm: LlmClient,
    private readonly onTurn?: (record: TurnRecord) => void,
    registry: Tool[] = ALL_TOOLS,
  ) {
    this.registry = registry;
  }

  async handle(senderHandle: string, userText: string): Promise<TurnRecord> {
    const role = roleFor(senderHandle, this.config);
    const tools = this.registry.filter((t) => roleSatisfies(role, t.minRole));
    const ctx: ToolContext = { role, senderHandle, config: this.config };

    // History is keyed by sender, so one process serves many conversations and
    // no history can leak from one identity to another.
    const key = `${senderHandle}::${role}`;
    let history = this.histories.get(key);
    if (!history) {
      history = [{ role: 'system', content: systemPrompt(this.config) }];
      this.histories.set(key, history);
    }
    history.push({ role: 'user', content: userText });

    const toolCalls: ToolInvocation[] = [];
    let replyText = '';
    let steps = 0;

    for (; steps < MAX_STEPS; steps++) {
      const reply = await this.llm.chat(history, tools);

      if (reply.toolCalls.length === 0) {
        replyText = reply.text.trim();
        history.push({ role: 'assistant', content: replyText });
        break;
      }

      history.push({
        role: 'assistant',
        content: reply.text,
        toolCalls: reply.toolCalls,
      });

      for (const call of reply.toolCalls) {
        const tool = this.registry.find((t) => t.name === call.name);

        if (!tool) {
          toolCalls.push({ name: call.name, args: call.arguments, ok: false });
          history.push({
            role: 'tool',
            toolName: call.name,
            toolCallId: call.id,
            content: `No such tool "${call.name}". Available: ${tools.map((t) => t.name).join(', ')}.`,
          });
          continue;
        }

        // THE permission gate. Keyed on the sender's role, checked on the tool,
        // before any side effect. A refusal is returned to the model as a tool
        // result so it must account for it.
        if (!roleSatisfies(role, tool.minRole)) {
          toolCalls.push({ name: call.name, args: call.arguments, ok: false, refused: true });
          history.push({
            role: 'tool',
            toolName: call.name,
            toolCallId: call.id,
            content:
              `REFUSED: "${tool.name}" is owner-only and this conversation is with a ${role}. ` +
              'Nothing was run. Tell the user this is owner-only.',
          });
          continue;
        }

        let content: string;
        let succeeded: boolean;
        try {
          const result = await tool.run(call.arguments, ctx);
          content = result.content;
          succeeded = result.ok;
        } catch (e) {
          content = `Tool "${tool.name}" threw: ${(e as Error).message}`;
          succeeded = false;
        }
        toolCalls.push({ name: tool.name, args: call.arguments, ok: succeeded });
        history.push({ role: 'tool', toolName: tool.name, toolCallId: call.id, content });
      }
    }

    if (!replyText) {
      replyText =
        steps >= MAX_STEPS
          ? 'I got stuck working on that — I stopped after too many steps rather than guess.'
          : '';
    }

    const record: TurnRecord = {
      at: new Date().toISOString(),
      senderHandle,
      role,
      userText,
      toolCalls,
      replyText,
      steps: steps + 1,
    };
    this.onTurn?.(record);
    return record;
  }
}
