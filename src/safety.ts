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
