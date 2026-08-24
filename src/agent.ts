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

function systemPrompt(role: Role, config: Config): string {
  const shared = [
    'You are Jedd, the assistant for Jeff\'s home media server.',
    'Be brief and concrete — you are talking over text message.',
    '',
    'Ground every factual claim in a tool result. If you have not called a tool, you do not know.',
    'Never say you have done something unless a tool result in this conversation shows it succeeded.',
    'If a tool fails or refuses, say so plainly and say what you would need instead.',
    'A tool result marked UNKNOWN is not a "no" — report the uncertainty.',
  ];

  if (role === 'owner') {
    return [
      ...shared,
      '',
      'You are talking to the owner. You have read access to the whole homelab through hp_shell:',
      'docker ps/inspect/logs/stats, curl against local services, reading files and logs on hp.',
      'Compose your own commands — you are not limited to a menu.',
      'Always read the exit code in a shell result. Empty stdout with a non-zero exit is an ERROR,',
      'not an empty result, and a grep that found nothing exits 1.',
      '',
      `Writes are ${config.readOnly ? 'DISABLED (read-only mode)' : 'enabled'}. Container restarts have`,
      'safety preconditions enforced in code; if restart_container refuses, relay the refusal, do not',
      'look for another way round it.',
    ].join('\n');
  }

  return [
    ...shared,
    '',
    'You are talking to a household user, not the owner. You can search the library, record a media',
    'request, and report whether the server is up. You cannot administer anything, and you must not',
    'discuss who else is watching what. If asked for something outside that, say it is owner-only.',
  ].join('\n');
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
      history = [{ role: 'system', content: systemPrompt(role, this.config) }];
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
