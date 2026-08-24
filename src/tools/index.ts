import { type Config } from '../config.js';
import type { IdentityVerdict } from '../identity-probe.js';
import { InviteLedger } from '../invite-ledger.js';
import { JfagoClient } from '../jfago.js';
import { roleSatisfies, type Role } from '../permissions.js';
import { containerNetns, dockerInspect, dockerLogs, dockerPs } from './docker.js';
import {
  hpShell,
  jellyfinSessions,
  livetvStatus,
  restartArrStack,
  restartContainer,
} from './homelab.js';
import { addAudiobook } from './add-audiobook.js';
import { makeAddMovie, makeAddSeries } from './add-media.js';
import { makeAddSeason } from './add-season.js';
import { makeCatalogueSearch } from './catalogue.js';
import { makeCheckStatus } from './check-status.js';
import { resolveChoice } from './choice.js';
import { kindleStatus, saveKindleEmail } from './kindle.js';
import { librarySearch } from './library.js';
import { makeInviteTool, type InviteDeps } from './invite.js';
import { homelabStatus } from './media.js';
import { diagnoseHostContention, restoreQbitSpeed, shedHostLoad } from './qbit.js';
import { makeRunbookTool } from './runbook.js';
import { makeSendEbook, type SendEbookDeps } from './send-ebook.js';
import { makeTrending } from './trending.js';
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
  librarySearch,
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
const GUEST_WRITE_TOOLS: Tool[] = [
  makeAddMovie(),
  makeAddSeries(),
  // 🔴 `add_season` is the verb V1 had and V2 shipped without: `add_series`
  // scopes seasons at CREATE time only, so a show Sonarr already holds had no
  // path at all. Jeff hit it on his first real test, asking for Seinfeld S3.
  makeAddSeason(),
  saveKindleEmail,
  addAudiobook,
];

/**
 * 🔴 THE INVITE TOOL IS BUILT FROM INJECTED DEPS, WHICH IS WHY IT WAS MISSING.
 *
 * `invite_to_jellyfin` was written, tested and mutation-swept — and then not
 * registered, because it is the only tool that cannot be a module-level const:
 * it needs a jfa-go client, a persistent ledger and **a way to send a text**,
 * and the send path belongs to the connector, not to a tool file. Every other
 * tool could be added by appending to an array in this file; this one needed a
 * parameter, so adding it was a two-file change and the second file was never
 * edited. **It was absent by omission, in a registry whose whole design is that
 * absence should be by construction.**
 *
 * That is the reason `buildTools` now takes deps rather than the invite tool
 * reaching for a module-level singleton: the thing that decides whether a
 * credential can be minted is now visible in the call that builds the registry.
 */
export interface ToolDeps {
  /** Absent → `invite_to_jellyfin` is not registered at all. */
  invite?: InviteDeps;
  /**
   * Absent → `send_ebook` is not registered at all.
   *
   * 🔴 `send_ebook` had the SAME omission as the invite tool and it is the one
   * that shows the shape of the trap: it was **verified live end to end, a real
   * book reached a real Kindle**, through a script that constructed it directly.
   * "It works" and "it is reachable" were both true, of different objects.
   */
  ebook?: SendEbookDeps;
}

/**
 * ⚠️ An INERT invite tool, for enumeration only — `ALL_TOOLS`, and nothing else.
 *
 * It is pointed at `jfa-go.invalid` (RFC 2606, can never resolve) with a sender
 * that throws, so the worst a mistaken use can do is fail to mint. The
 * enumeration invariants — every tool declares `writes`, every tool is gated by
 * role, no tool takes an unvouched delivery address — must see this tool, and
 * they can only see what is in a list.
 *
 * ⚠️ `ALL_TOOLS` already carries `hpShell` regardless of the identity proof, so
 * it is a documentation surface rather than a runnable registry. Do not start
 * treating it as one.
 */
const INERT_SEND_EBOOK: SendEbookDeps = {
  send: async () => {
    throw new Error('ALL_TOOLS carries an INERT send_ebook; it cannot mail. Use buildTools(deps).');
  },
  onlySendTo: 'nobody@invalid',
};

const INERT_INVITE: InviteDeps = {
  jfago: new JfagoClient({
    baseUrl: 'http://jfa-go.invalid:8056',
    inviteBaseUrl: 'http://jfa-go.invalid',
    username: '',
    password: '',
    profile: 'Default',
    validityHours: 24,
  }),
  ledger: new InviteLedger('/nonexistent/jedd-inert-invites.jsonl'),
  send: async () => {
    throw new Error('ALL_TOOLS carries an INERT invite tool; it cannot send. Use buildTools(deps).');
  },
};
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
export function buildTools(config: Config, shellIdentity?: IdentityVerdict, deps: ToolDeps = {}): Tool[] {
  const tools = [...GUEST_TOOLS, ...GUEST_WRITE_TOOLS, ...OWNER_READ_TOOLS, ...OWNER_WRITE_TOOLS];
  if (shellIdentity?.safe) tools.push(hpShell);
  if (config.runbookPath) tools.push(makeRunbookTool(config.runbookPath));
  // Same rule as hp_shell and read_runbook: no jfa-go, no tool. A registered
  // invite tool that cannot reach jfa-go would offer a capability that fails
  // AFTER the model has promised it to someone.
  if (deps.invite && config.jfago.password) tools.push(makeInviteTool(deps.invite));
  // Same rule: no SMTP credential, no tool. A send_ebook that cannot mail would
  // tell somebody their book is on the way and then fail at the last step.
  if (deps.ebook && config.kindle.smtpPassword) tools.push(makeSendEbook(deps.ebook));
  // Same rule again: no TMDB token, no tool. A registered whats_popular with no
  // credential would answer every "what's good right now" with a failure, after
  // the model has already offered to look.
  if (config.tmdb.readToken) tools.push(makeTrending());
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
  makeInviteTool(INERT_INVITE),
  makeSendEbook(INERT_SEND_EBOOK),
  // ⚠️ `read_runbook` is registered conditionally by `buildTools` and was missing
  // from here, so every invariant quantified over ALL_TOOLS — role gating, the
  // writes declaration, the delivery-address rule — silently skipped it.
  // Reachable in production is not the same as covered by the guards.
  makeRunbookTool('/nonexistent/enumeration-only.md'),
  // ⚠️ Conditionally registered by `buildTools` (needs a TMDB token), so it has
  // the same shape as `read_runbook` and must be listed here by hand or every
  // invariant quantified over ALL_TOOLS silently skips it.
  makeTrending(),
];

export type { Tool } from './types.js';
