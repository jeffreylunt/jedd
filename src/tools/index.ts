import { assertShellIdentityIsSafe, type Config } from '../config.js';
import { roleSatisfies, type Role } from '../permissions.js';
import {
  hpShell,
  jellyfinSearch,
  jellyfinSessions,
  livetvStatus,
  restartArrStack,
  restartContainer,
} from './homelab.js';
import { homelabStatus, requestMedia } from './media.js';
import type { Tool } from './types.js';

/**
 * Which ssh identity a tool uses is decided by WHO COMPOSES THE COMMAND TEXT.
 *
 *   model-composed text  → `config.shellSshHost`  (unprivileged, no docker)
 *   code-composed text   → `config.adminSshHost`  (privileged, has docker)
 *
 * `livetv_status` and `restart_container` run privileged, and that is safe
 * because their command strings are literals in this repo with only validated,
 * non-string parameters interpolated. `hp_shell` is the only tool where the
 * model writes the command, and it is the only one that must be unprivileged.
 *
 * If you add a tool that interpolates model-supplied STRINGS into a shell
 * command, it belongs on the shell identity, not the admin one.
 */

const GUEST_TOOLS: Tool[] = [requestMedia, jellyfinSearch, homelabStatus];
const OWNER_READ_TOOLS: Tool[] = [jellyfinSessions, livetvStatus];
const OWNER_WRITE_TOOLS: Tool[] = [restartContainer, restartArrStack];

/**
 * Build the tool registry for this process.
 *
 * Two things are decided here rather than at call time, because a tool that is
 * never registered cannot be argued for:
 *  - `hp_shell` is omitted entirely when the ssh identity split is missing.
 *  - write tools are omitted entirely when running read-only.
 */
export function buildTools(config: Config): Tool[] {
  const tools = [...GUEST_TOOLS, ...OWNER_READ_TOOLS];
  if (assertShellIdentityIsSafe(config).safe) tools.push(hpShell);
  if (!config.readOnly) tools.push(...OWNER_WRITE_TOOLS);
  return tools;
}

/**
 * The tools a given role may use.
 *
 * ⚠️ This filters what is DECLARED. It is not the security check — the loop
 * re-checks `minRole` on every call before any side effect. Both exist on
 * purpose; do not delete the loop's check because guests never see these tools.
 */
export function toolsForRole(tools: Tool[], role: Role): Tool[] {
  return tools.filter((t) => roleSatisfies(role, t.minRole));
}

/** Every tool that exists, regardless of config. For tests and documentation. */
export const ALL_TOOLS: Tool[] = [...GUEST_TOOLS, ...OWNER_READ_TOOLS, ...OWNER_WRITE_TOOLS, hpShell];

export type { Tool } from './types.js';
