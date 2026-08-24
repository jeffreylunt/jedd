import { roleSatisfies, type Role } from '../permissions.js';
import { hpShell, jellyfinSearch, jellyfinSessions, livetvStatus, restartContainer } from './homelab.js';
import { homelabStatus, requestMedia } from './media.js';
import type { Tool } from './types.js';

export const ALL_TOOLS: Tool[] = [
  // guest
  requestMedia,
  jellyfinSearch,
  homelabStatus,
  // owner
  hpShell,
  jellyfinSessions,
  livetvStatus,
  restartContainer,
];

/**
 * The tools a given role may use.
 *
 * This is also what gets DECLARED to the model: a guest is never shown that
 * `hp_shell` exists, so the usual failure mode (model tries, gets refused,
 * apologises at the user) mostly does not arise. The gate in the loop is still
 * the thing that enforces it — declaration is convenience, not security.
 */
export function toolsForRole(role: Role): Tool[] {
  return ALL_TOOLS.filter((t) => roleSatisfies(role, t.minRole));
}

export function findTool(name: string): Tool | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}

export type { Tool } from './types.js';
