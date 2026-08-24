import type { Config } from '../config.js';
import type { FollowupStore } from '../followups.js';
import type { ExecImpl } from '../hp.js';
import type { Role } from '../permissions.js';

export interface ToolContext {
  role: Role;
  senderHandle: string;
  config: Config;
  /**
   * Test seam ONLY: the exec implementation `runOnHp` should use. Unset in
   * production, where `runOnHp` falls back to `execFile`.
   *
   * It exists so a test can assert on the exact command string a tool would have
   * sent over ssh — including asserting that a REFUSED argument produced no ssh
   * call at all. A refusal that still ran the command is the failure mode this
   * seam is here to detect, and it is not observable from the return value.
   */
  exec?: ExecImpl;
  /**
   * Test seam ONLY: how a tool waits. Unset in production, where it is a real
   * timer. Exists so a settle delay does not make the suite take a minute.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Where a tool records work that is not finished when it returns.
   *
   * Optional so a tool that cannot schedule still WORKS — it just cannot promise
   * to come back. A tool must therefore never claim a follow-up it did not
   * manage to schedule.
   */
  followups?: FollowupStore;
}

/**
 * Every tool returns this shape, and the loop appends it to history verbatim.
 *
 * `ok` is set by the tool from what actually happened — a non-zero exit code, an
 * HTTP error, a refused precondition. Nothing downstream re-derives it from
 * prose. This is the record that makes "did you do it" answerable by
 * construction.
 */
export interface ToolResult {
  ok: boolean;
  /** Rendered back to the model as the tool message content. */
  content: string;
}

export interface Tool {
  name: string;
  description: string;
  /** Minimum role required to CALL this tool. Enforced by the loop, not the prompt. */
  minRole: Role;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export function ok(content: string): ToolResult {
  return { ok: true, content };
}

export function fail(content: string): ToolResult {
  return { ok: false, content };
}
