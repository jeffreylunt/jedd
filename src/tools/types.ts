import type { Config } from '../config.js';
import type { Role } from '../permissions.js';

export interface ToolContext {
  role: Role;
  senderHandle: string;
  config: Config;
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
