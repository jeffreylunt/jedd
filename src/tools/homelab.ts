import { commandGate } from '../command-gate.js';
import { jellyfinGet } from '../jellyfin.js';
import { renderOutcome, runOnHp, clip } from '../hp.js';
import {
  assertSafeToRestart,
  isValidContainerName,
  parseContainerState,
  parseSessions,
  tunnelVerdict,
} from '../safety.js';
import { escapeForGrep } from './docker.js';
import { fail, ok, type Tool } from './types.js';

/**
 * The generic capability. One tool instead of twenty curated verbs — the model
 * is assumed competent at composing shell, and the gate decides what may run.
 */
export const hpShell: Tool = {
  name: 'hp_shell',
  description:
    'Run a READ-ONLY shell command on the homelab host (hp, 192.168.1.7) over ssh, as an ' +
    'UNPRIVILEGED account. Use this for host-level diagnostics: uptime, df, free, ps, ss, reading ' +
    'files, curl against a local service. Returns exit code, stdout and stderr separately — always ' +
    'read the exit code, because an empty stdout with a non-zero exit is an ERROR, not an empty ' +
    'result. This account has NO docker access, so docker commands here fail with "permission ' +
    'denied" — use docker_ps, docker_inspect, docker_logs and container_netns instead. Commands that ' +
    'would change the system are refused by a code gate; restarting a container is a separate tool.',
  minRole: 'owner',
  writes: false,
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to run on hp, e.g. `docker ps --format "{{.Names}} {{.Status}}"`',
      },
    },
    required: ['command'],
  },
  async run(args, ctx) {
    const command = typeof args['command'] === 'string' ? args['command'] : '';
    if (!command.trim()) return fail('No command supplied.');

    const verdict = commandGate(command);
    if (!verdict.allowed) {
      return fail(`REFUSED by the command gate: ${verdict.reason}\nThe command was NOT run.`);
    }

    const outcome = await runOnHp(ctx.config.shellSshHost, command);
    const rendered = `$ ${command}\n\n${renderOutcome(outcome)}`;
    return outcome.exitCode === 0 ? ok(rendered) : fail(rendered);
  },
};

/** Who is connected to Jellyfin and what, if anything, is playing. */
export const jellyfinSessions: Tool = {
  name: 'jellyfin_sessions',
  description:
    'List current Jellyfin sessions and what each is playing. Use this to answer "is anyone watching" ' +
    'and before proposing anything disruptive.',
  minRole: 'owner',
  writes: false,
  parameters: { type: 'object', properties: {}, required: [] },
  async run(_args, ctx) {
    const res = await jellyfinGet(ctx.config, '/Sessions');
    if (!res.ok) return fail(`Could not read Jellyfin /Sessions: ${res.error}. Playback state is UNKNOWN.`);
    const check = parseSessions(res.body);
    if (!check.known) return fail(check.detail);
    const lines = check.activeSessions.length
      ? check.activeSessions.map((s) => `  - ${s}`).join('\n')
      : '  (nobody is playing anything)';
    return ok(`${check.detail}\n${lines}`);
  },
};

/**
 * Live TV health, which is the thing that actually breaks.
 *
 * 🔴 THIS TOOL DELIBERATELY NEVER ASKS JELLYFIN ABOUT CHANNELS OR TUNERS.
 *
 * `/LiveTv/Channels` (and anything else that enumerates channels or tuners)
 * iterates the tuner, and against a DEAD tuner that call is what wedged Jellyfin
 * site-wide for hours on 2026-07-26. A dead tuner is exactly the state someone is
 * in when they ask "is live TV broken", so the diagnostic would fire precisely
 * when it does the most damage. An earlier version of this tool called
 * `/LiveTv/Channels?limit=1`; it was removed rather than commented against.
 *
 * What is left still answers the question, from the Dispatcharr side where the
 * faults actually originate: is the proxy serving, is it erroring, is the tunnel
 * container up, and is Jellyfin itself alive (via `/System/Info`, which touches
 * no tuner). Each half carries its own success flag — a failure on one side never
 * reads as "fine".
 */
export const livetvStatus: Tool = {
  name: 'livetv_status',
  description:
    'Check Live TV health: whether the Dispatcharr proxy is up and serving, its recent error lines, ' +
    'whether gluetun is up, and whether Jellyfin itself is alive. Use this for any "live TV is broken / ' +
    'channel not working" question. Does not touch the tuner, so it is safe to run when live TV is down.',
  minRole: 'owner',
  writes: false,
  parameters: {
    type: 'object',
    properties: {
      log_lines: {
        type: 'number',
        description: 'How many recent Dispatcharr log lines to scan for errors (default 200).',
      },
    },
    required: [],
  },
  async run(args, ctx) {
    // Finiteness matters: NaN survives Math.min/Math.max and would interpolate
    // as the TEXT "NaN" into a command running on the privileged identity.
    const requested = args['log_lines'];
    const logLines = Math.min(
      Math.max(
        typeof requested === 'number' && Number.isFinite(requested) ? Math.trunc(requested) : 200,
        20,
      ),
      1000,
    );
    const sections: string[] = [];
    let anyFailure = false;

    // Jellyfin liveness only — /System/Info does not enumerate tuners.
    const info = await jellyfinGet(ctx.config, '/System/Info');
    if (!info.ok) {
      anyFailure = true;
      sections.push(`Jellyfin: NOT reachable — ${info.error}`);
    } else {
      const body = info.body as Record<string, unknown> | undefined;
      sections.push(`Jellyfin: up (version ${body?.['Version'] ?? 'unknown'})`);
    }

    // Is the Dispatcharr proxy actually serving? Unauthenticated version endpoint.
    const version = await runOnHp(
      ctx.config.adminSshHost,
      `curl -s --max-time 8 -o /dev/null -w "%{http_code}" ${ctx.config.dispatcharr.baseUrl}/api/core/version/`,
    );
    const code = version.stdout.trim();
    if (version.exitCode !== 0 || code !== '200') {
      anyFailure = true;
      sections.push(
        `Dispatcharr proxy: NOT serving (http=${code || 'none'}, exit=${version.exitCode}, ` +
          `stderr=${version.stderr.trim() || '(empty)'})`,
      );
    } else {
      sections.push('Dispatcharr proxy: serving (HTTP 200 on /api/core/version/)');
    }

    const up = await runOnHp(
      ctx.config.adminSshHost,
      'docker ps --format "{{.Names}}|{{.Status}}" | grep -E "^(dispatcharr|gluetun)\\|"',
    );
    sections.push(
      up.exitCode === 0 && up.stdout.trim()
        ? `Container status:\n${up.stdout.trim()}`
        : `Container status: UNKNOWN (exit=${up.exitCode}, stderr=${up.stderr.trim() || '(empty)'})`,
    );
    if (up.exitCode !== 0) anyFailure = true;

    const logs = await runOnHp(
      ctx.config.adminSshHost,
      `docker logs --tail ${logLines} dispatcharr 2>&1 | grep -iE "error|traceback|refused|timeout|failed" | tail -25`,
    );
    // grep exits 1 on "no matches" — that is a clean result, not a failure.
    if (logs.exitCode > 1) {
      anyFailure = true;
      sections.push(
        `Dispatcharr recent errors: UNKNOWN (exit=${logs.exitCode}, stderr=${logs.stderr.trim() || '(empty)'})`,
      );
    } else {
      sections.push(
        logs.stdout.trim()
          ? `Dispatcharr error lines in last ${logLines}:\n${clip(logs.stdout, 3000)}`
          : `Dispatcharr error lines in last ${logLines}: none`,
      );
    }

    const text = sections.join('\n\n');
    return anyFailure ? fail(text) : ok(text);
  },
};

/**
 * The one mutating tool, and the only place a restart can happen.
 *
 * It gathers its own evidence rather than trusting arguments: whether the
 * container is up, and whether anyone is watching. The verdict is computed by
 * `assertSafeToRestart`, which refuses on UNKNOWN.
 */
export const restartContainer: Tool = {
  name: 'restart_container',
  description:
    'Restart a homelab container. Protected containers (jellyfin, dispatcharr, gluetun) are restarted ' +
    'ONLY when completely down and only when Jellyfin reports nobody watching. The preconditions are ' +
    'checked in code and cannot be overridden — if this refuses, report the refusal.',
  minRole: 'owner',
  writes: true,
  parameters: {
    type: 'object',
    properties: {
      container: { type: 'string', description: 'Exact container name.' },
    },
    required: ['container'],
  },
  async run(args, ctx) {
    const container = typeof args['container'] === 'string' ? args['container'].trim() : '';
    if (!container) return fail('No container name supplied.');
    // The CANONICAL validator, shared with the structured docker tools. An
    // inline near-copy lived here and was weaker: it accepted `-sonarr` and
    // `.sonarr`, which the docker-tool tests list as names that are not names.
    // Two validators guarding the same privileged identity means tightening one
    // silently leaves the other — and this is the one on the WRITE path.
    if (!isValidContainerName(container)) {
      return fail(`"${container}" is not a valid container name. Nothing was restarted.`);
    }
    // The gluetun invariant is NOT checked here. It lives inside
    // assertSafeToRestart, so it holds for every caller rather than for this one.

    // Evidence, gathered here rather than taken on trust.
    const ps = await runOnHp(
      ctx.config.adminSshHost,
      `docker ps -a --format "{{.Names}}|{{.Status}}" | grep -E "^${escapeForGrep(container)}\\|"`,
      30_000,
      ctx.exec,
    );
    const state = parseContainerState(ps.stdout, ps.exitCode);
    if (!state.known) {
      return fail(
        `Could not determine the state of "${container}" (exit=${ps.exitCode}, ` +
          `stderr=${ps.stderr.trim() || '(empty)'}). Refusing to restart something I cannot see.`,
      );
    }
    const { status, isUp: containerIsUp } = state;

    const sessionsRes = await jellyfinGet(ctx.config, '/Sessions');
    const playback = sessionsRes.ok
      ? parseSessions(sessionsRes.body)
      : { known: false, activeSessions: [], detail: `/Sessions unreadable: ${sessionsRes.error}` };

    const verdict = assertSafeToRestart(container, {
      containerIsUp,
      playback,
      readOnly: ctx.config.readOnly,
    });
    if (!verdict.allowed) {
      return fail(`NOT RESTARTED. ${verdict.reason} (observed status: ${status})`);
    }

    const restart = await runOnHp(
      ctx.config.adminSshHost,
      `docker restart ${container}`,
      90_000,
      ctx.exec,
    );
    return restart.exitCode === 0
      ? ok(`Restarted ${container}. ${verdict.reason}\n${renderOutcome(restart)}`)
      : fail(`Restart of ${container} FAILED.\n${renderOutcome(restart)}`);
  },
};

/**
 * The most common real fix on this homelab, and a genuinely useful write.
 *
 * After any gluetun restart some `network_mode: container:gluetun` dependents
 * keep a stale, dead network namespace and have zero egress, while `docker ps`
 * cheerfully reports them Up. Restarting sonarr/radarr/prowlarr is documented as
 * 🟢 safe mid-match — they serve no playback, so nobody's stream is interrupted.
 *
 * The viewer check still runs. It is expected to pass, and that is exactly why
 * it stays: a precondition that only runs when you expect it to fail is a
 * precondition nobody has tested.
 */
export const restartArrStack: Tool = {
  name: 'restart_arr_stack',
  description:
    'Restart sonarr, radarr and prowlarr together. This is the fix for the common "arrs are down / ' +
    'Jedd cannot search" fault caused by a stale network namespace after a gluetun restart. Safe ' +
    'during playback — these containers serve no video. Owner only.',
  minRole: 'owner',
  writes: true,
  parameters: { type: 'object', properties: {}, required: [] },
  async run(_args, ctx) {
    const containers = ['sonarr', 'radarr', 'prowlarr'];

    if (ctx.config.readOnly) {
      return fail('Jedd is running read-only (JEDD_ALLOW_WRITES is not set). Nothing was restarted.');
    }

    // Same viewer gate as everything else. Owner authorisation unlocks the tool;
    // it does not unlock restarting while someone is mid-something.
    const sessionsRes = await jellyfinGet(ctx.config, '/Sessions');
    const playback = sessionsRes.ok
      ? parseSessions(sessionsRes.body)
      : { known: false, activeSessions: [], detail: `/Sessions unreadable: ${sessionsRes.error}` };

    for (const container of containers) {
      const verdict = assertSafeToRestart(container, {
        containerIsUp: true,
        playback,
        readOnly: ctx.config.readOnly,
      });
      if (!verdict.allowed) {
        return fail(`NOT RESTARTED (none of them). ${verdict.reason}`);
      }
    }

    const restart = await runOnHp(
      ctx.config.adminSshHost,
      `docker restart ${containers.join(' ')}`,
      120_000,
    );
    if (restart.exitCode !== 0) {
      return fail(`Restart FAILED.\n${renderOutcome(restart)}`);
    }

    // 🔴 THE POST-CHECK, AND IT IS NOT OPTIONAL.
    //
    // These containers live in gluetun's network namespace. Restarting a
    // `container:gluetun` dependent is exactly the operation that can leave it
    // on a stale or detached namespace — and `docker ps` reports "Up" either
    // way, so exit code 0 proves nothing about whether traffic is still in the
    // tunnel. Jeff's standing rule is that VPN protection is non-negotiable.
    const verify = await verifyTunnel(ctx.config.adminSshHost, 'sonarr');
    const summary = `Restarted ${containers.join(', ')}. ${playback.detail}`;
    if (verify.verdict === 'leaking') {
      return fail(
        `🔴 ${summary}\n\nBUT THE TUNNEL IS NOT PROTECTING THEM: ${verify.detail}\n` +
          'A container that comes back on the naked home connection is worse than one that is down. ' +
          'Escalate to a human immediately; do not attempt a repair.',
      );
    }
    if (verify.verdict === 'unknown') {
      return fail(
        `${summary}\n\n⚠️ Could NOT verify the tunnel: ${verify.detail}\n` +
          'Treat VPN protection as UNCONFIRMED until a human checks. UNKNOWN is not "protected".',
      );
    }
    return ok(`${summary}\n${verify.detail}\n${renderOutcome(restart)}`);
  },
};

/**
 * Is this container's traffic actually leaving through the VPN?
 *
 * Compares the container's exit IP against the HOST's exit IP. If they MATCH,
 * the container is not in the tunnel.
 *
 * Deliberately does NOT pin an expected VPN prefix: pinning `191.96.` produced a
 * false alarm once gluetun moved to a different exit, and re-pinning just
 * re-brittles it. "Differs from the host" is true whenever the tunnel holds and
 * false whenever it does not, with no value to maintain.
 *
 * Returns three states. **`unknown` must never be treated as protected** — a
 * probe that could not run has not shown anything.
 */
async function verifyTunnel(
  sshHost: string,
  container: string,
): Promise<{ verdict: 'protected' | 'leaking' | 'unknown'; detail: string }> {
  // `ifconfig.me/ip` returns a bare address; bare `ifconfig.me` returns ~200
  // lines of HTML that would parse into nonsense.
  const containerIp = await runOnHp(
    sshHost,
    `docker exec ${container} curl -s --max-time 15 ifconfig.me/ip`,
    40_000,
  );
  const hostIp = await runOnHp(sshHost, 'curl -s --max-time 15 ifconfig.me/ip', 40_000);

  return tunnelVerdict(
    { exitCode: containerIp.exitCode, ip: containerIp.stdout },
    { exitCode: hostIp.exitCode, ip: hostIp.stdout },
  );
}
