import { clip, renderOutcome, runOnHp } from '../hp.js';
import { isValidContainerName, parseContainerState } from '../safety.js';
import { fail, ok, type Tool, type ToolContext } from './types.js';

/**
 * Docker reads as STRUCTURED TOOLS, not as shell commands.
 *
 * 🔴 This file is what makes the ssh identity split cost nothing.
 *
 * `hp_shell` now runs as an unprivileged account with no docker group, so
 * `docker ps` through the shell fails at the kernel — verified on 2026-08-24,
 * including through `awk 'BEGIN{system("docker …")}'`. The obvious-looking
 * reaction was to hand the shell account docker access back through a socket
 * proxy. That would have rebuilt the boundary out of the same material the
 * security review already defeated.
 *
 * It was unnecessary, and the reason generalises: **`docker ps`, `inspect` and
 * `logs` were never shell-shaped.** They are read-only, fixed-shape, and
 * parameterized by nothing but a container name and a couple of numbers. That is
 * the definition of a structured tool. So they move here, onto the privileged
 * identity, where the command text is a literal in this repo.
 *
 * The invariant every tool in this file must keep:
 *
 *   **No model-supplied STRING is ever interpolated into these commands.**
 *
 * Container names go through `isValidContainerName` first; numbers are clamped
 * into a range and re-rendered from a JS number. If you find yourself adding a
 * `grep pattern` or a `format` parameter here, stop — that is model-composed
 * command text, and it belongs on `hp_shell` and the unprivileged identity.
 */

/** Validate a model-supplied container name, or explain the refusal. */
function containerArg(args: Record<string, unknown>): { name: string } | { error: string } {
  const raw = typeof args['container'] === 'string' ? args['container'].trim() : '';
  if (!raw) return { error: 'No container name supplied.' };
  if (!isValidContainerName(raw)) {
    return {
      error:
        `"${raw}" is not a valid container name. Names match [a-zA-Z0-9][a-zA-Z0-9_.-]* — ` +
        'no spaces, quotes, semicolons or substitutions. Nothing was run.',
    };
  }
  return { name: raw };
}

/** Read a numeric argument, clamped. Never trusts the model's range. */
function clampedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * `docker ps -a`, the whole table.
 *
 * No name filter: `docker ps --filter name=X` is a SUBSTRING match and would
 * report `audiobookshelf-audiobookshelf-1` as `audiobookshelf`. The model can
 * read a table; it cannot un-see a wrong row.
 */
export const dockerPs: Tool = {
  name: 'docker_ps',
  // Reaches the homelab over ssh; absent entirely when none is configured.
  needsHomelabSsh: true,
  description:
    'List every container on hp with its status and image (docker ps -a). This is how you check ' +
    'whether something is up, exited or restarting. The generic shell CANNOT run docker — use this ' +
    'instead. Includes stopped containers, so an absent name really means the container does not exist.',
  minRole: 'owner',
  writes: false,
  parameters: { type: 'object', properties: {}, required: [] },
  async run(_args, ctx) {
    const outcome = await runOnHp(
      ctx.config.adminSshHost,
      'docker ps -a --format "{{.Names}}|{{.Status}}|{{.Image}}"',
      30_000,
      ctx.exec,
    );
    if (outcome.exitCode !== 0) {
      return fail(`Could not list containers. Container state is UNKNOWN.\n${renderOutcome(outcome)}`);
    }
    const rows = outcome.stdout.trim();
    if (!rows) {
      // Exit 0 with no rows is a real, if surprising, answer — but it is far more
      // often a sign that the command did not do what we think, so say which.
      return fail('docker ps -a exited 0 but returned NO rows. Treat container state as UNKNOWN.');
    }
    return ok(`Containers on hp (name|status|image):\n${clip(rows)}`);
  },
};

/**
 * A curated `docker inspect`, deliberately not the raw JSON.
 *
 * The template is a literal here; only a validated name is interpolated. Raw
 * inspect output is ~10 KB per container and would evict the conversation, and
 * the fields that actually answer homelab questions are these.
 *
 * ⚠️ The homelab knowledge base records that `docker inspect` reports a mount or
 * a network as perfectly correct while the container cannot use it. Inspect is
 * the DECLARED state. For "is this container really in gluetun's namespace", use
 * `container_netns`, which observes the kernel.
 */
export const dockerInspect: Tool = {
  name: 'docker_inspect',
  // Reaches the homelab over ssh; absent entirely when none is configured.
  needsHomelabSsh: true,
  description:
    "Inspect one container's configuration and state on hp: status, health, restart count, start/finish " +
    'times, exit code, image, network mode and restart policy. Takes a container name only. Note this ' +
    'reports what docker was CONFIGURED with — for whether a container is really sharing gluetun\'s ' +
    'network namespace, use container_netns instead.',
  minRole: 'owner',
  writes: false,
  parameters: {
    type: 'object',
    properties: {
      container: { type: 'string', description: 'Exact container name, e.g. "sonarr".' },
    },
    required: ['container'],
  },
  async run(args, ctx) {
    const parsed = containerArg(args);
    if ('error' in parsed) return fail(parsed.error);

    // Every field is a literal in this template. The only hole is the name.
    const format = [
      'status={{.State.Status}}',
      'running={{.State.Running}}',
      'health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}',
      'exit_code={{.State.ExitCode}}',
      'started={{.State.StartedAt}}',
      'finished={{.State.FinishedAt}}',
      'restart_count={{.RestartCount}}',
      'image={{.Config.Image}}',
      'network_mode={{.HostConfig.NetworkMode}}',
      'restart_policy={{.HostConfig.RestartPolicy.Name}}',
    ].join('\\n');

    const outcome = await runOnHp(
      ctx.config.adminSshHost,
      `docker inspect --format '${format}' ${parsed.name}`,
      30_000,
      ctx.exec,
    );
    if (outcome.exitCode !== 0) {
      return fail(
        `Could not inspect "${parsed.name}" — it may not exist. State is UNKNOWN.\n${renderOutcome(outcome)}`,
      );
    }
    return ok(`docker inspect ${parsed.name}:\n${clip(outcome.stdout.trim())}`);
  },
};

/**
 * `docker logs` for one container.
 *
 * Both parameters are NUMBERS, clamped and re-rendered from a JS number, so
 * nothing the model writes reaches the remote shell as text. A `grep` parameter
 * would be model-composed command text and does not belong on this identity —
 * the model can read the lines and filter them itself.
 */
export const dockerLogs: Tool = {
  name: 'docker_logs',
  // Reaches the homelab over ssh; absent entirely when none is configured.
  needsHomelabSsh: true,
  description:
    'Read recent log lines from one container on hp (stdout and stderr combined). Takes a container ' +
    'name, an optional line count (default 100, max 1000) and an optional age in minutes. The generic ' +
    'shell CANNOT run docker — use this to read any container log.',
  minRole: 'owner',
  writes: false,
  parameters: {
    type: 'object',
    properties: {
      container: { type: 'string', description: 'Exact container name, e.g. "jellyfin".' },
      tail: { type: 'number', description: 'How many recent lines to return (default 100, max 1000).' },
      since_minutes: {
        type: 'number',
        description: 'Only lines from the last N minutes (optional, max 1440).',
      },
    },
    required: ['container'],
  },
  async run(args, ctx) {
    const parsed = containerArg(args);
    if ('error' in parsed) return fail(parsed.error);

    const tail = clampedNumber(args['tail'], 100, 1, 1000);
    const sinceRaw = args['since_minutes'];
    const since =
      typeof sinceRaw === 'number' && Number.isFinite(sinceRaw)
        ? ` --since ${clampedNumber(sinceRaw, 60, 1, 1440)}m`
        : '';

    const outcome = await runOnHp(
      ctx.config.adminSshHost,
      `docker logs --tail ${tail}${since} ${parsed.name} 2>&1`,
      45_000,
      ctx.exec,
    );
    if (outcome.exitCode !== 0) {
      return fail(
        `Could not read logs for "${parsed.name}". Log content is UNKNOWN.\n${renderOutcome(outcome)}`,
      );
    }
    const body = outcome.stdout.trim();
    return ok(
      body
        ? `Last ${tail} line(s) of ${parsed.name}${since ? ` (last ${since.trim().split(' ')[1]})` : ''}:\n${clip(body)}`
        : `${parsed.name} produced NO log output for that window (the command succeeded — the log is genuinely empty).`,
    );
  },
};

/**
 * Network modes that mean "this container shares nobody else's namespace".
 * `host` shares the HOST's, which is still not another container's — either way
 * there is no peer container to compare inodes with. A user-defined network name
 * is also legal here, hence the trailing alternative, but it must still look like
 * a name rather than like an error message.
 */
const STANDALONE_NETWORK_MODES = /^(bridge|host|none|default|[a-zA-Z0-9][a-zA-Z0-9_.-]*)$/;

/**
 * The netns-inode diagnostic, as its own structured tool.
 *
 * 🔴 THE FAULT THIS EXISTS FOR: after a gluetun restart, a
 * `network_mode: container:gluetun` dependent can keep a stale, dead network
 * namespace. It has zero egress, and `docker ps` reports it **Up** the whole
 * time. `docker inspect` also still shows the same NetworkMode, because that is
 * the DECLARED configuration and it never changed.
 *
 * The only thing that distinguishes the two states is the kernel's own inode:
 * `readlink /proc/self/ns/net` inside the container, compared against the same
 * read inside its declared peer. Equal inodes mean genuinely shared; different
 * inodes mean the namespace went stale, and for sonarr/radarr/prowlarr the
 * documented fix is `restart_arr_stack`.
 *
 * ⚠️ **`HostConfig.NetworkMode` reports `container:<64-hex-id>`, NOT
 * `container:gluetun`.** An earlier version of this tool compared it against the
 * literal string `container:gluetun` and therefore said "nothing to compare" for
 * every container it was written for — it would have been silent on exactly the
 * fault it exists to detect. Caught by running it against the real homelab; the
 * unit fixture had invented a shape docker never emits. The peer is now RESOLVED
 * from that id, which also means the tool never needs to know the tunnel
 * container's name.
 *
 * Three states, and **`unknown` is never "fine"** — a probe that could not run
 * has shown nothing. `docker exec` needs the container to be running, so a
 * stopped container is unknown, not healthy.
 */
export const containerNetns: Tool = {
  name: 'container_netns',
  // Reaches the homelab over ssh; absent entirely when none is configured.
  needsHomelabSsh: true,
  description:
    "Check whether a container is REALLY sharing another container's network namespace (the gluetun " +
    'tunnel case), by comparing kernel netns inodes (readlink /proc/self/ns/net) rather than trusting ' +
    'docker. Use this when arrs are up but cannot reach anything, or after any gluetun restart: a ' +
    'stale namespace looks perfectly healthy to docker ps and docker inspect. Takes a container name only.',
  minRole: 'owner',
  writes: false,
  parameters: {
    type: 'object',
    properties: {
      container: {
        type: 'string',
        description: 'Exact container name, e.g. "sonarr". Must be running for the probe to work.',
      },
    },
    required: ['container'],
  },
  async run(args, ctx) {
    const parsed = containerArg(args);
    if ('error' in parsed) return fail(parsed.error);
    const { name } = parsed;

    const declared = await runOnHp(
      ctx.config.adminSshHost,
      `docker inspect --format '{{.HostConfig.NetworkMode}}' ${name}`,
      30_000,
      ctx.exec,
    );
    const networkMode = declared.exitCode === 0 ? declared.stdout.trim() : '';
    if (!networkMode) {
      return fail(
        `Could not read the network mode of "${name}". Namespace state is UNKNOWN.\n${renderOutcome(declared)}`,
      );
    }

    const self = await readNetns(ctx, name);
    if (!self.ok) {
      return fail(
        `${name} declares network_mode=${networkMode}, but its namespace could NOT be read ` +
          `(${self.detail}). UNKNOWN is not healthy — check whether the container is running.`,
      );
    }

    // A container on its own bridge/host network shares nobody's namespace, so
    // there is no inode to compare and "MISMATCH" would be a false alarm. A false
    // alarm here trains the reader to ignore the real one.
    const peerRef = /^container:(.+)$/.exec(networkMode)?.[1];
    if (!peerRef) {
      // Fail CLOSED on a mode we do not recognise. Anything that is not one of
      // docker's own network modes is a read that did not return what we think,
      // and answering "nothing to compare" would turn a garbled read into a
      // reassuring green — the UNKNOWN-as-fine bug class this repo exists to
      // avoid. `readNetns` already applies exactly this discipline to the inode.
      if (!STANDALONE_NETWORK_MODES.test(networkMode)) {
        return fail(
          `${name} reported an UNRECOGNISED network mode "${networkMode}". That is not a namespace ` +
            'verdict, it is a read that did not return what was expected. Namespace state is UNKNOWN.',
        );
      }
      return ok(
        `${name}: netns inode ${self.inode}, network_mode=${networkMode}. This container does not ` +
          'share another container\'s network namespace by configuration, so there is nothing to compare.',
      );
    }

    const peer = await resolvePeerName(ctx, peerRef);
    if (!peer.ok) {
      return fail(
        `${name} declares network_mode=${networkMode} but the container it points at could NOT be ` +
          `resolved (${peer.detail}). Whether the namespace is shared is UNKNOWN, which is not fine.`,
      );
    }

    const tunnel = await readNetns(ctx, peer.name);
    if (!tunnel.ok) {
      return fail(
        `${name} has netns inode ${self.inode} and points at ${peer.name}, but ${peer.name}'s own ` +
          `namespace could NOT be read (${tunnel.detail}). Whether they match is UNKNOWN, which is ` +
          'not the same as fine.',
      );
    }

    if (self.inode === tunnel.inode) {
      return ok(
        `${name} IS in ${peer.name}'s network namespace — both report inode ${self.inode}. ` +
          'The namespace is healthy; if traffic is still failing, the fault is elsewhere.',
      );
    }
    return fail(
      `🔴 STALE NAMESPACE: ${name} reports netns inode ${self.inode} but ${peer.name} reports ` +
        `${tunnel.inode}, while ${name} is configured to share ${peer.name}'s namespace. This is the ` +
        'post-gluetun-restart fault: docker ps says Up and the container has no egress. The ' +
        'documented fix for sonarr/radarr/prowlarr is restart_arr_stack.',
    );
  },
};

/**
 * Turn the `container:<id>` reference docker actually reports into a name.
 *
 * The id comes from docker, not from the model, but it is still validated before
 * interpolation: "it came from a trusted source" is how an injection sink stops
 * being reviewed.
 */
async function resolvePeerName(
  ctx: ToolContext,
  ref: string,
): Promise<{ ok: true; name: string } | { ok: false; detail: string }> {
  if (!isValidContainerName(ref)) {
    return { ok: false, detail: `docker reported an unusable peer reference "${ref}"` };
  }
  const out = await runOnHp(
    ctx.config.adminSshHost,
    `docker inspect --format '{{.Name}}' ${ref}`,
    30_000,
    ctx.exec,
  );
  // docker renders names with a leading slash: /gluetun
  const name = out.stdout.trim().replace(/^\//, '');
  if (out.exitCode !== 0 || !name || !isValidContainerName(name)) {
    return { ok: false, detail: `exit=${out.exitCode}, stdout="${out.stdout.trim() || '(empty)'}"` };
  }
  return { ok: true, name };
}

/**
 * Escape the one regex metacharacter a valid container name may contain.
 *
 * `isValidContainerName` permits `[a-zA-Z0-9_.-]`, of which only `.` is special
 * in an ERE outside a bracket expression. This is not defence against injection
 * — the name is already validated — it is defence against matching the WRONG
 * container, which decides an up/down verdict that elsewhere unlocks a restart.
 */
export function escapeForGrep(name: string): string {
  return name.replace(/\./g, '\\.');
}

/** Read one container's kernel netns inode. Name must already be validated. */
async function readNetns(
  ctx: ToolContext,
  container: string,
): Promise<{ ok: true; inode: string } | { ok: false; detail: string }> {
  // Confirm it is running first: `docker exec` on a stopped container fails with
  // a message that reads like a namespace problem and is not one.
  const ps = await runOnHp(
    ctx.config.adminSshHost,
    // `.` is legal in a container name AND a regex metacharacter, so an
    // unescaped name matches other containers: `^my_app.v2-1\\|` also matches a
    // row for `my_appXv2-1`, and only the FIRST row is read.
    `docker ps -a --format "{{.Names}}|{{.Status}}" | grep -E "^${escapeForGrep(container)}\\|"`,
    30_000,
    ctx.exec,
  );
  const state = parseContainerState(ps.stdout, ps.exitCode);
  if (!state.known) return { ok: false, detail: `could not determine whether ${container} exists` };
  if (!state.isUp) return { ok: false, detail: `${container} is not running (${state.status})` };

  const probe = await runOnHp(
    ctx.config.adminSshHost,
    `docker exec ${container} readlink /proc/self/ns/net`,
    30_000,
    ctx.exec,
  );
  const raw = probe.stdout.trim();
  // Expected shape is exactly `net:[4026532519]`. Anything else is not an inode,
  // and half-parsing it would invent a comparison out of an error message.
  const match = /^net:\[(\d+)\]$/.exec(raw);
  if (probe.exitCode !== 0 || !match) {
    return {
      ok: false,
      detail: `readlink returned exit=${probe.exitCode}, stdout="${raw || '(empty)'}"`,
    };
  }
  return { ok: true, inode: match[1] as string };
}
