/**
 * Homelab safety rules, as CODE.
 *
 * These are not instructions to the model. There is no phrasing of a request
 * that reaches a protected container through a path this module does not
 * adjudicate, because the dangerous verbs are not expressible through the
 * generic shell tool at all (see `commandGate`) and exist only behind
 * `assertSafeToRestart`.
 */

/**
 * Blast-radius tiers.
 *
 * 🔴 THE DEFAULT IS THE POINT. An unclassified container is `live-tv`, the most
 * restrictive tier — never `safe`.
 *
 * The previous design was a flat "protected" set, which meant anything NOT on
 * the list was treated as unprotected. That inverts the requirement: a container
 * nobody had thought about (a newly added service, a renamed one) got the
 * PERMISSIVE treatment precisely because nobody had considered it.
 */
export type BlastRadius = 'safe' | 'live-tv';

/**
 * Containers that serve no video and therefore cannot interrupt a viewer.
 * Restarting the arrs is documented safe **mid-match** and is the single most
 * common real fix on this homelab.
 *
 * Adding to this list is a safety decision, not a convenience. The test is not
 * "does restarting it usually work" but "can restarting it interrupt a stream
 * someone is watching right now".
 */
const SAFE_TIER = new Set([
  'sonarr',
  'radarr',
  'prowlarr',
  'flaresolverr',
  'janitorr',
  'qbittorrent',
]);

export function blastRadiusFor(container: string): BlastRadius {
  return SAFE_TIER.has(container) ? 'safe' : 'live-tv';
}

/**
 * Containers in the live-TV tier that are ALSO explicitly named in Jeff's rules.
 * Kept for message clarity; `blastRadiusFor` already covers them by default.
 */
export const PROTECTED_CONTAINERS = new Set([
  'jellyfin',
  'dispatcharr',
  'gluetun',
  'gluetun-torrents',
]);

/**
 * A jellyfin session that is actively playing something.
 *
 * Deliberately narrow: a session is "active playback" if it has a NowPlayingItem
 * and is not paused. A paused stream still counts as a human mid-something, so
 * paused ALSO blocks a restart — `IsPaused === true` still has a NowPlayingItem.
 */
export interface PlaybackCheck {
  /** false when /Sessions could not be fetched or parsed — this means UNKNOWN. */
  known: boolean;
  activeSessions: string[];
  detail: string;
}

/**
 * Parse a Jellyfin /Sessions payload into a playback verdict.
 *
 * Anything unexpected returns `known: false`. UNKNOWN is not "no playback";
 * callers must treat it as a refusal.
 */
export function parseSessions(raw: unknown): PlaybackCheck {
  if (!Array.isArray(raw)) {
    return {
      known: false,
      activeSessions: [],
      detail: `/Sessions did not return an array (got ${typeof raw}) — playback state UNKNOWN`,
    };
  }
  const active: string[] = [];
  for (const s of raw) {
    if (typeof s !== 'object' || s === null) {
      return {
        known: false,
        activeSessions: [],
        detail: '/Sessions contained a non-object entry — playback state UNKNOWN',
      };
    }
    const session = s as Record<string, unknown>;
    const nowPlaying = session['NowPlayingItem'];
    if (nowPlaying && typeof nowPlaying === 'object') {
      const item = nowPlaying as Record<string, unknown>;
      const user = typeof session['UserName'] === 'string' ? session['UserName'] : 'unknown user';
      const title = typeof item['Name'] === 'string' ? item['Name'] : 'unknown title';
      const playState = session['PlayState'];
      const paused =
        playState && typeof playState === 'object'
          ? Boolean((playState as Record<string, unknown>)['IsPaused'])
          : false;
      active.push(`${user} — ${title}${paused ? ' (paused)' : ''}`);
    }
  }
  return {
    known: true,
    activeSessions: active,
    detail: active.length
      ? `${active.length} session(s) with media loaded: ${active.join('; ')}`
      : `${raw.length} session(s) connected, none with media loaded`,
  };
}

export type TunnelVerdict = 'protected' | 'leaking' | 'unknown';

/**
 * Decide whether a container's traffic is actually inside the VPN tunnel, by
 * comparing its exit IP with the host's own exit IP.
 *
 * 🔴 Three states, and **`unknown` must never be treated as protected.** A probe
 * that could not run has shown nothing. This is the same discipline as UNKNOWN
 * playback, applied to the diagnosis side.
 *
 * Deliberately compares against the HOST rather than a pinned VPN prefix.
 * Pinning `191.96.` false-alarmed once gluetun moved to the SLC exit
 * (`194.62.x`, which is what it is on today), and re-pinning only re-brittles
 * it. "Differs from the host" holds whenever the tunnel does, with no value to
 * maintain and no provider assumption baked in.
 */
export function tunnelVerdict(
  container: { exitCode: number; ip: string },
  host: { exitCode: number; ip: string },
): { verdict: TunnelVerdict; detail: string } {
  const looksLikeIp = (s: string) => /^[0-9a-f.:]+$/i.test(s) && s.length >= 7;
  const inner = container.ip.trim();
  const outer = host.ip.trim();

  if (container.exitCode !== 0 || !looksLikeIp(inner)) {
    return {
      verdict: 'unknown',
      detail: `could not read the container's exit IP (exit=${container.exitCode}, got ${JSON.stringify(inner.slice(0, 80))})`,
    };
  }
  if (host.exitCode !== 0 || !looksLikeIp(outer)) {
    return {
      verdict: 'unknown',
      detail: `could not read the host's exit IP to compare against (exit=${host.exitCode}, got ${JSON.stringify(outer.slice(0, 80))})`,
    };
  }
  if (inner === outer) {
    return {
      verdict: 'leaking',
      detail: `the container's exit IP equals the host's (${outer}) — it is NOT in the tunnel`,
    };
  }
  return {
    verdict: 'protected',
    detail: `Tunnel verified: container exits via ${inner}, host via ${outer} (different).`,
  };
}

export interface ContainerState {
  /** false when the container's state could not be determined AT ALL. */
  known: boolean;
  isUp: boolean;
  status: string;
}

/**
 * Read a container's state from `docker ps -a --format "{{.Names}}|{{.Status}}"`.
 *
 * Two failure modes are deliberately distinguished, because collapsing them is
 * how "I could not tell" becomes "it is down" — and "it is down" is the input
 * that unlocks a restart:
 *   - non-zero exit / empty output → `known: false` (refuse; we saw nothing)
 *   - a real row → `known: true` with `isUp` from the Status column
 *
 * ⚠️ `docker ps --filter name=X` is a SUBSTRING match and would report
 * `audiobookshelf-audiobookshelf-1` as `audiobookshelf`. The caller greps for an
 * anchored exact name instead; this function assumes that has been done.
 */
export function parseContainerState(stdout: string, exitCode: number): ContainerState {
  if (exitCode !== 0) return { known: false, isUp: false, status: '' };
  const line = stdout.trim().split('\n')[0]?.trim() ?? '';
  if (!line) return { known: false, isUp: false, status: '' };
  const parts = line.split('|');
  if (parts.length < 2) return { known: false, isUp: false, status: line };
  const status = (parts[1] ?? '').trim();
  if (!status) return { known: false, isUp: false, status: line };
  // Docker's Status column starts with "Up …" only when running. Everything else
  // ("Exited (0) 2 minutes ago", "Created", "Restarting", "Dead") is not up.
  return { known: true, isUp: status.startsWith('Up'), status };
}

export interface RestartVerdict {
  allowed: boolean;
  reason: string;
}

/**
 * gluetun carries the VPN for the whole arr stack, and rolling its exit takes
 * live TV down for minutes plus a forced dispatcharr restart. Jeff's standing
 * rule is that this is never Jedd's call.
 *
 * 🔴 This lives HERE, inside the pure decision function, and not only in the
 * calling tool. A review found the invariant guarded by a single untested
 * `startsWith('gluetun')` line in one call site — delete that line and nothing
 * went red. An invariant enforced in one caller is enforced nowhere.
 */
export function isNeverRestartable(container: string): boolean {
  return container === 'gluetun' || container.startsWith('gluetun-');
}

/**
 * The restart precondition, in full.
 *
 * A protected container may be restarted ONLY when it is completely down AND
 * Jellyfin playback state is KNOWN and idle. Every other combination refuses,
 * including — deliberately — the case where we could not tell.
 */
export function assertSafeToRestart(
  container: string,
  opts: { containerIsUp: boolean; playback: PlaybackCheck; readOnly: boolean },
): RestartVerdict {
  if (opts.readOnly) {
    return {
      allowed: false,
      reason:
        'Jedd is running read-only (JEDD_ALLOW_WRITES is not set). No container will be restarted.',
    };
  }

  // Checked before anything else, and inside this function rather than in a
  // caller, so no argument combination can reach a gluetun restart.
  if (isNeverRestartable(container)) {
    return {
      allowed: false,
      reason:
        `Refusing: ${container} carries the VPN for the whole arr stack. Rolling it takes live TV ` +
        'down for minutes and forces a dispatcharr restart. This is never Jedd\'s call — a human does it.',
    };
  }

  if (blastRadiusFor(container) === 'safe') {
    // ⚠️ The SAFE tier deliberately does NOT gate on playback, and that is a
    // loosening from the previous version — recorded so nobody "restores" it.
    //
    // These containers serve no video, so a restart cannot interrupt a stream.
    // Requiring idle would block the most common real fix (stale netns after a
    // gluetun restart) at exactly the moment it is most needed: someone is
    // watching, the arrs are down, and the fix is safe mid-match. A precondition
    // that blocks the correct action is not caution, it is a bug.
    //
    // Playback is still OBSERVED and reported, just not used as a gate.
    return {
      allowed: true,
      reason:
        `${container} is in the SAFE tier — it serves no video, so a restart cannot interrupt a ` +
        `viewer. Playback at the time: ${opts.playback.known ? opts.playback.detail : 'UNKNOWN'}.`,
    };
  }

  if (opts.containerIsUp) {
    return {
      allowed: false,
      reason:
        `Refusing: ${container} is in the LIVE-TV tier and it is currently UP. ` +
        'Live-TV-tier containers are restarted only when completely down with no viewer possible.' +
        (PROTECTED_CONTAINERS.has(container)
          ? ''
          : ' (It is in that tier because it is not on the SAFE list — an unclassified container ' +
            'always gets the most restrictive treatment.)'),
    };
  }

  if (!opts.playback.known) {
    // 🔴 The one case where UNKNOWN does not block, and the reasoning is narrow.
    //
    // Playback is read FROM Jellyfin. So when the container being restarted IS
    // Jellyfin and `docker ps` says it is down, /Sessions being unreadable is a
    // CONSEQUENCE of the outage, not missing information — a Jellyfin that is not
    // running has no viewers, by definition. Jeff's standing carve-out is exactly
    // this: "completely down, no viewers possible → fix it autonomously."
    //
    // Note the evidence: `containerIsUp` comes from `docker ps`, NOT from the
    // endpoint served by the dead container. Without that independence this would
    // be circular. Any other container reaching this branch still refuses.
    if (container === 'jellyfin' && !opts.containerIsUp) {
      return {
        allowed: true,
        reason:
          'jellyfin is completely down per docker ps, so /Sessions is unreadable as a consequence ' +
          'of the outage and no viewer is possible. This is the documented completely-down carve-out.',
      };
    }
    return {
      allowed: false,
      reason:
        `Refusing: ${container} is down, but Jellyfin playback state is UNKNOWN ` +
        `(${opts.playback.detail}). UNKNOWN is not idle — a human decides this one.`,
    };
  }

  if (opts.playback.activeSessions.length > 0) {
    return {
      allowed: false,
      reason: `Refusing: someone is watching right now — ${opts.playback.detail}`,
    };
  }

  return {
    allowed: true,
    reason: `${container} is completely down and Jellyfin reports no active playback (${opts.playback.detail}).`,
  };
}

/**
 * 🔴 The ONLY thing standing between a model-supplied container name and the
 * PRIVILEGED ssh identity.
 *
 * Structured docker tools run as the admin account, and their command strings
 * are literals in this repo with exactly one hole in them: the container name.
 * That hole is interpolated into a string the REMOTE shell will parse, so a name
 * containing `;`, a space, `$(…)`, a backtick or a newline would not be a name —
 * it would be a second command, running privileged, with the whole point of the
 * identity split bypassed.
 *
 * The pattern is Docker's own (`[a-zA-Z0-9][a-zA-Z0-9_.-]*`), so nothing that is
 * genuinely a container name is rejected. Everything else is refused before it
 * reaches ssh. **Do not loosen this to "escape it instead" — validation of a
 * known-narrow shape is checkable; escaping is a shell-quoting argument nobody
 * wins.**
 */
export function isValidContainerName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name);
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * HOST CONTENTION — the diagnosis side of the safe-fix path (task-10)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The most common cause of live-TV stutter on this box is NOT a broken stream.
 * It is host contention: qBittorrent saturating the uplink and the CPU that
 * gluetun needs for encryption. The homelab knowledge base records the
 * discriminator: **Jellyfin's LAN response is THE canary — ~1-5 ms healthy,
 * hundreds of ms under contention.**
 *
 * 🔴 AND THE INVERSION THAT MAKES THIS THE RIGHT FIX: a person saying "the game
 * is stuttering" is a person WATCHING. Their report is proof that the
 * restart-blocking condition holds, so the intuitive response — restart
 * something in the live-TV path — is the worst available action (a mid-game
 * Dispatcharr restart cost eight hours on 2026-04-27). Shedding qBittorrent's
 * bandwidth is the one documented fix that helps a viewer WITHOUT touching the
 * stream. The report tightens the gate; it does not license a restart.
 */

/** Median latency at or above this means the host is contended. */
export const CONTENTION_MS = 50;
/** Below this, qBittorrent is not moving enough to be the bottleneck. */
export const QBIT_ACTIVE_BYTES_PER_SEC = 512 * 1024;
/** Fewer successful probes than this and the measurement is UNKNOWN, not fast. */
export const MIN_LATENCY_SAMPLES = 5;

export interface LatencyReading {
  /** false when too few probes returned a usable timing — UNKNOWN, never "fast". */
  known: boolean;
  medianMs: number;
  samplesMs: number[];
  detail: string;
}

/**
 * Parse repeated `http=<code> total=<seconds>` probe lines into a MEDIAN.
 *
 * 🔴 The median is not a stylistic choice. Measured on an idle box, single
 * samples were 21.5 ms, 17.5 ms and 22.1 ms among readings of ~1.0 ms — a
 * first-call warm-up artefact. One sample would false-positive contention and
 * authorise a write. The median of several is stable at ~1.1 ms while remaining
 * fully sensitive to real contention, which slows EVERY sample rather than one.
 *
 * A non-200 sample contributes NOTHING — it is not a slow response, it is an
 * absent one, and averaging it in would invent a number.
 */
export function parseLatencySamples(stdout: string, exitCode: number): LatencyReading {
  const blank = (detail: string): LatencyReading => ({ known: false, medianMs: 0, samplesMs: [], detail });
  if (exitCode !== 0) return blank(`the latency probe itself failed (exit ${exitCode})`);

  const samples: number[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^http=(\d{3}) total=([0-9.]+)$/.exec(line.trim());
    if (!m) continue;
    if (m[1] !== '200') continue;
    const seconds = Number(m[2]);
    if (!Number.isFinite(seconds)) continue;
    samples.push(seconds * 1000);
  }
  if (samples.length < MIN_LATENCY_SAMPLES) {
    return blank(
      `only ${samples.length} of ${MIN_LATENCY_SAMPLES} required probes returned a usable timing — ` +
        'latency is UNKNOWN, which is not the same as fast',
    );
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2 : (sorted[mid] as number);
  return {
    known: true,
    medianMs: median,
    samplesMs: sorted,
    detail: `median ${median.toFixed(1)} ms over ${samples.length} probes (${sorted.map((s) => s.toFixed(1)).join(', ')})`,
  };
}

export interface QbitTransfer {
  /** false when qBittorrent's API could not be read — UNKNOWN, never "idle". */
  known: boolean;
  downBytesPerSec: number;
  upBytesPerSec: number;
  detail: string;
}

/**
 * Read `GET /api/v2/transfer/info`.
 *
 * ⚠️ An unreachable qBittorrent API is UNKNOWN, emphatically not "idle". The
 * inventory records that bridge-local traffic to `172.20.0.1:8080` returns 000
 * while the tunnel is perfectly healthy when `FIREWALL_OUTBOUND_SUBNETS` is
 * empty. Reading that silence as "qBittorrent is doing nothing" would conclude
 * the exact opposite of the truth on a box that is being saturated.
 */
export function parseQbitTransfer(stdout: string, exitCode: number): QbitTransfer {
  const blank = (detail: string): QbitTransfer => ({
    known: false,
    downBytesPerSec: 0,
    upBytesPerSec: 0,
    detail,
  });
  if (exitCode !== 0) return blank(`could not reach qBittorrent's API (exit ${exitCode})`);
  let body: unknown;
  try {
    body = JSON.parse(stdout.trim());
  } catch {
    return blank(`qBittorrent returned something that is not JSON: "${stdout.trim().slice(0, 120)}"`);
  }
  const rec = body as Record<string, unknown>;
  const down = rec['dl_info_speed'];
  const up = rec['up_info_speed'];
  if (typeof down !== 'number' || typeof up !== 'number') {
    return blank('qBittorrent\'s transfer/info had no numeric dl_info_speed/up_info_speed');
  }
  return {
    known: true,
    downBytesPerSec: down,
    upBytesPerSec: up,
    detail: `qBittorrent is moving ${(down / 1024).toFixed(0)} KB/s down, ${(up / 1024).toFixed(0)} KB/s up`,
  };
}

/**
 * FOUR outcomes, and three of them refuse.
 *
 * `unknown` and `clear` are deliberately DIFFERENT verdicts even though both
 * refuse: "I measured it and it is fine" and "I could not measure it" are
 * different facts about the world, and collapsing them is how a blind instrument
 * starts reporting good news. `qbit-not-the-cause` is the third refusal, and it
 * is the useful one — most live-TV faults are not fixable by shedding load, and
 * saying so beats applying a fix that cannot help.
 */
export type ContentionVerdict = 'shed-warranted' | 'clear' | 'qbit-not-the-cause' | 'unknown';

export function hostContentionVerdict(
  latency: LatencyReading,
  qbit: QbitTransfer,
): { verdict: ContentionVerdict; detail: string } {
  // UNKNOWN is checked FIRST and on BOTH instruments. A verdict computed from an
  // instrument that did not report is not a cautious verdict, it is a guess.
  if (!latency.known) {
    return {
      verdict: 'unknown',
      detail: `Cannot measure host contention: ${latency.detail}. I am not able to tell whether anything is wrong.`,
    };
  }
  if (!qbit.known) {
    return {
      verdict: 'unknown',
      detail:
        `Jellyfin latency read fine (${latency.detail}) but ${qbit.detail}. ` +
        'Whether qBittorrent is the contributor is UNKNOWN, so shedding it is not justified.',
    };
  }
  if (latency.medianMs < CONTENTION_MS) {
    return {
      verdict: 'clear',
      detail:
        `The host is NOT contended: Jellyfin answers in ${latency.detail}, well under the ${CONTENTION_MS} ms ` +
        `threshold. ${qbit.detail}. This is a measurement, not a failure to measure — whatever the problem is, ` +
        'host contention is not it.',
    };
  }
  const busiest = Math.max(qbit.downBytesPerSec, qbit.upBytesPerSec);
  if (busiest < QBIT_ACTIVE_BYTES_PER_SEC) {
    return {
      verdict: 'qbit-not-the-cause',
      detail:
        `The host IS contended (${latency.detail}, over the ${CONTENTION_MS} ms threshold) but ${qbit.detail} — ` +
        `below the ${(QBIT_ACTIVE_BYTES_PER_SEC / 1024).toFixed(0)} KB/s that would make it the bottleneck. ` +
        'Shedding qBittorrent would not fix this. Something else is loading the host.',
    };
  }
  return {
    verdict: 'shed-warranted',
    detail:
      `The host is contended (${latency.detail}, over the ${CONTENTION_MS} ms threshold) and ${qbit.detail}, ` +
      'which is enough to be the cause. Shedding qBittorrent frees uplink and VPN-encrypt CPU without ' +
      'touching anyone\'s stream.',
  };
}

/**
 * Did the symptom actually improve?
 *
 * 🔴 Deliberately computed from the SYMPTOM, never from the mechanism. "The API
 * returned 200" and "qBittorrent reports alternate limits are on" are the fix
 * reporting on itself; neither is evidence that a viewer's stream got better.
 * UNKNOWN when either reading is blind — an unverifiable fix is reported as
 * unverified, not as success.
 */
export type RecoveryVerdict = 'improved' | 'not-improved' | 'unknown';

export function recoveryVerdict(
  before: LatencyReading,
  after: LatencyReading,
): { verdict: RecoveryVerdict; detail: string } {
  if (!before.known || !after.known) {
    return {
      verdict: 'unknown',
      detail: `Cannot tell whether this helped: ${!before.known ? before.detail : after.detail}.`,
    };
  }
  if (after.medianMs < CONTENTION_MS) {
    return {
      verdict: 'improved',
      detail:
        `Jellyfin latency went from ${before.medianMs.toFixed(1)} ms to ${after.medianMs.toFixed(1)} ms, ` +
        `back under the ${CONTENTION_MS} ms threshold.`,
    };
  }
  return {
    verdict: 'not-improved',
    detail:
      `Jellyfin latency is still ${after.medianMs.toFixed(1)} ms (was ${before.medianMs.toFixed(1)} ms), ` +
      `at or over the ${CONTENTION_MS} ms threshold. The load shed did NOT resolve the symptom.`,
  };
}
