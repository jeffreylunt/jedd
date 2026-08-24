/**
 * Homelab safety rules, as CODE.
 *
 * These are not instructions to the model. There is no phrasing of a request
 * that reaches a protected container through a path this module does not
 * adjudicate, because the dangerous verbs are not expressible through the
 * generic shell tool at all (see `commandGate`) and exist only behind
 * `assertSafeToRestart`.
 */

/** Containers whose restart can interrupt something a human is doing right now. */
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

export interface RestartVerdict {
  allowed: boolean;
  reason: string;
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

  if (!PROTECTED_CONTAINERS.has(container)) {
    // Unprotected containers still require known-idle playback, because a
    // restart of e.g. sonarr can still churn the box mid-stream.
    if (!opts.playback.known) {
      return {
        allowed: false,
        reason: `Refusing: Jellyfin playback state is UNKNOWN (${opts.playback.detail}). UNKNOWN is not idle.`,
      };
    }
    if (opts.playback.activeSessions.length > 0) {
      return {
        allowed: false,
        reason: `Refusing: someone is watching right now — ${opts.playback.detail}`,
      };
    }
    return { allowed: true, reason: `${container} is not a protected container and nothing is playing.` };
  }

  if (opts.containerIsUp) {
    return {
      allowed: false,
      reason:
        `Refusing: ${container} is a protected container and it is currently UP. ` +
        'Protected containers are restarted only when completely down.',
    };
  }

  if (!opts.playback.known) {
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
