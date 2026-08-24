import { type Config } from '../config.js';
import type { IdentityVerdict } from '../identity-probe.js';
import { roleSatisfies, type Role } from '../permissions.js';
import { containerNetns, dockerInspect, dockerLogs, dockerPs } from './docker.js';
import {
  hpShell,
  jellyfinSearch,
  jellyfinSessions,
  livetvStatus,
  restartArrStack,
  restartContainer,
} from './homelab.js';
import { addAudiobook } from './add-audiobook.js';
import { makeAddMovie, makeAddSeries } from './add-media.js';
import { makeCatalogueSearch } from './catalogue.js';
import { makeCheckStatus } from './check-status.js';
import { resolveChoice } from './choice.js';
import { kindleStatus, saveKindleEmail } from './kindle.js';
import { homelabStatus } from './media.js';
import { diagnoseHostContention, restoreQbitSpeed, shedHostLoad } from './qbit.js';
import { makeRunbookTool } from './runbook.js';
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
 *
 * The docker tools (`docker_ps`, `docker_inspect`, `docker_logs`,
 * `container_netns`) are the reason the identity split costs no capability. The
 * shell account has no docker access at all, and none is missing: those reads
 * were never shell-shaped. Their command strings are literals here with one
 * hole, a container name, validated by `isValidContainerName` before it is
 * interpolated. 🔴 That validation is the entire defence on the privileged
 * identity — see `src/tools/docker.ts`.
 */

const GUEST_TOOLS: Tool[] = [
  jellyfinSearch,
  homelabStatus,
  makeCatalogueSearch(),
  makeCheckStatus(),
  resolveChoice,
  kindleStatus,
];

/**
 * 🔴 GUEST WRITES. Jeff, 2026-08-24: "yes guests can request real media and add users."
 *
 * These are `writes: true` at `minRole: 'guest'` — the combination that did not
 * exist when `buildTools` inferred write-ness from which array a tool sat in,
 * and the reason `registerable()` now quantifies the kill switch over the whole
 * registry instead. This is the first real member of that combination.
 */
const GUEST_WRITE_TOOLS: Tool[] = [makeAddMovie(), makeAddSeries(), saveKindleEmail, addAudiobook];
const OWNER_READ_TOOLS: Tool[] = [
  jellyfinSessions,
  livetvStatus,
  diagnoseHostContention,
  dockerPs,
  dockerInspect,
  dockerLogs,
  containerNetns,
];
/**
 * ⚠️ `shed_host_load` is a WRITE and lives here, so it does not exist at all
 * unless writes are enabled — even though it is the SAFEST action in the set and
 * the only one that can be applied while someone is watching. Safe-to-run and
 * allowed-to-run are different axes, and this file only decides the second.
 */
const OWNER_WRITE_TOOLS: Tool[] = [restartContainer, restartArrStack, shedHostLoad, restoreQbitSpeed];

/**
 * Build the tool registry for this process.
 *
 * Two things are decided here rather than at call time, because a tool that is
 * never registered cannot be argued for:
 *  - `hp_shell` is omitted entirely when the ssh identity split is missing.
 *  - write tools are omitted entirely when running read-only.
 *
 * 🔴 `shellIdentity` is the verdict from `proveShellIdentityIsSafe()`, which
 * RUNS `id` and a docker crossing against both hosts. **Omitting it means
 * `hp_shell` is not registered at all** — a caller that forgets to prove the
 * boundary gets no free-form shell, rather than getting one on the strength of a
 * string comparison. Fail closed by construction, not by remembering to check.
 */
export function buildTools(config: Config, shellIdentity?: IdentityVerdict): Tool[] {
  const tools = [...GUEST_TOOLS, ...GUEST_WRITE_TOOLS, ...OWNER_READ_TOOLS, ...OWNER_WRITE_TOOLS];
  if (shellIdentity?.safe) tools.push(hpShell);
  if (config.runbookPath) tools.push(makeRunbookTool(config.runbookPath));
  return registerable(tools, config);
}

/**
 * 🔴 THE READ-ONLY KILL SWITCH, APPLIED OVER THE WHOLE REGISTRY.
 *
 * Every candidate tool passes through here, and the rule is quantified rather
 * than aimed at a named list: **for every tool, `writes` implies absent when
 * `readOnly`.**
 *
 * This replaces gating on the OWNER write array, which made the guest tool list
 * byte-identical with writes on and off. That was dormant only because no guest
 * write tool existed — and Jeff has now authorised guests to add media and
 * provision accounts, so the first one is imminent. A second hand-maintained
 * GUEST_WRITE_TOOLS array would have fixed this instance and rebuilt the same
 * trap one list further along: **write-ness is a property of the MEMBER, not of
 * the list it sits in.**
 *
 * An undeclared tool is REFUSED rather than defaulted, because defaulting picks
 * the permissive answer for an author who simply forgot.
 */
export function registerable(tools: Tool[], config: Config): Tool[] {
  for (const t of tools) {
    if (typeof t.writes !== 'boolean') {
      throw new Error(
        `Tool "${t.name}" does not declare writes. Every tool must declare whether it can change ` +
          'the homelab, so the read-only kill switch can cover it regardless of which role it is ' +
          'offered to. This is not defaulted on purpose.',
      );
    }
  }
  return config.readOnly ? tools.filter((t) => !t.writes) : tools;
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
export const ALL_TOOLS: Tool[] = [
  ...GUEST_TOOLS,
  ...GUEST_WRITE_TOOLS,
  ...OWNER_READ_TOOLS,
  ...OWNER_WRITE_TOOLS,
  hpShell,
];

export type { Tool } from './types.js';
