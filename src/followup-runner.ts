import type { Config } from './config.js';
import type { FollowupStore, Followup } from './followups.js';
import { jellyfinGet, type JellyfinResponse } from './jellyfin.js';
import type { ExecImpl } from './hp.js';
import { roleFor } from './permissions.js';
import { parseSessions } from './safety.js';
import {
  SHED_DOWN_BYTES_PER_SEC,
  SHED_UP_BYTES_PER_SEC,
  observeContention,
  readThrottleState,
  restoreQbitSpeed,
} from './tools/qbit.js';
import type { ToolContext } from './tools/types.js';

/**
 * What happens when a follow-up comes due.
 *
 * 🔴 EVERY BRANCH HERE ANSWERS THE SAME THREE QUESTIONS BEFORE IT SPEAKS: why
 * did I wake, who am I talking to, and what did I actually observe. A follow-up
 * that cannot answer all three does not send — it defers, and when it runs out
 * of deferrals it says plainly that it could not finish.
 *
 * The failure mode being designed against is not "the message was wrong". It is
 * an unprompted message from a machine that cannot account for itself, which a
 * person cannot act on and learns to ignore.
 */

/** How long to wait before re-checking whether a shed can be lifted. */
export const RESTORE_CHECK_DELAY_MS = 30 * 60 * 1000;
/** How long to wait after an inconclusive check before trying again. */
export const RETRY_DELAY_MS = 15 * 60 * 1000;

export interface FollowupDeps {
  config: Config;
  send: (to: string, text: string) => Promise<void>;
  exec?: ExecImpl;
  sleep?: (ms: number) => Promise<void>;
  jellyfin?: (config: Config, path: string) => Promise<JellyfinResponse>;
  now?: () => Date;
}

export interface FollowupOutcome {
  id: string;
  action: 'restored' | 'held' | 'deferred' | 'abandoned' | 'nothing-to-do' | 'not-delivered';
  sent: boolean;
  detail: string;
}

/** Run every follow-up that is due. Never throws — a bad one must not stop the rest. */
export async function runDueFollowups(
  store: FollowupStore,
  deps: FollowupDeps,
): Promise<FollowupOutcome[]> {
  const now = deps.now?.() ?? new Date();
  const outcomes: FollowupOutcome[] = [];
  for (const followup of store.due(now)) {
    try {
      outcomes.push(await runOne(followup, store, deps, now));
    } catch (e) {
      store.resolve(followup.id, 'abandoned', `threw: ${(e as Error).message}`, now);
      outcomes.push({
        id: followup.id,
        action: 'abandoned',
        sent: false,
        detail: `threw: ${(e as Error).message}`,
      });
    }
  }
  return outcomes;
}

async function runOne(
  followup: Followup,
  store: FollowupStore,
  deps: FollowupDeps,
  now: Date,
): Promise<FollowupOutcome> {
  const ctx: ToolContext = {
    role: 'owner',
    senderHandle: followup.senderHandle,
    config: deps.config,
    exec: deps.exec,
    sleep: deps.sleep,
  };

  /**
   * 🔴 The recipient's authorisation is re-derived NOW, not trusted from the
   * stored record.
   *
   * The record was written by a different process, possibly days ago, and
   * `OWNER_HANDLE` may have changed since. A stored "this person is the owner"
   * would be an identity assertion travelling through time, which is the same
   * mistake as taking identity from message content — just with a longer delay.
   */
  const role = roleFor(followup.senderHandle, deps.config);
  const speak = async (text: string): Promise<boolean> => {
    if (role !== 'owner') return false;
    await deps.send(followup.senderHandle, text);
    return true;
  };

  const why =
    `Following up on my own initiative, ${describeAge(followup.createdAt, now)} after I ` +
    `${followup.reason}\nWhat I saw then: ${followup.observed}`;

  // ── What is actually in force right now? ───────────────────────────────────
  const state = await readThrottleState(ctx);
  if (!state.known) {
    return await deferOrGiveUp(
      followup,
      store,
      now,
      `could not read qBittorrent's state (${state.detail})`,
      async () =>
        speak(
          `${why}\n\nI came back to take that throttle off and I CANNOT TELL whether it is still on — ` +
            `${state.detail}. I have stopped retrying. qBittorrent may still be limited to ` +
            `${kb(SHED_DOWN_BYTES_PER_SEC)} down / ${kb(SHED_UP_BYTES_PER_SEC)} up, and I would rather ` +
            'say that than guess. Worth a look when you have a moment.',
        ),
    );
  }

  if (!state.throttled) {
    // Nothing to undo, and nothing anyone needs to hear about it. An unprompted
    // "I checked and there was nothing to do" is exactly the noise that teaches
    // people to ignore this channel.
    store.resolve(followup.id, 'done', 'throttle was already off; nothing to undo', now);
    return { id: followup.id, action: 'nothing-to-do', sent: false, detail: 'throttle already off' };
  }

  if (!state.ours) {
    const detail =
      `alternate limits are ${state.altDown}/${state.altUp} B/s, not the ${SHED_DOWN_BYTES_PER_SEC}/` +
      `${SHED_UP_BYTES_PER_SEC} I set`;
    store.resolve(followup.id, 'abandoned', `not ours: ${detail}`, now);
    const sent = await speak(
      `${why}\n\nI came back to take my throttle off, but qBittorrent is now limited by settings that ` +
        `are not mine (${detail}). Someone or something else changed them, so I have left them alone. ` +
        'My own throttle is no longer what is in force.',
    );
    return { id: followup.id, action: sent ? 'abandoned' : 'not-delivered', sent, detail };
  }

  // ── Would lifting it hurt anyone right now? ───────────────────────────────
  //
  // Restoring INCREASES host load, so this is the direction that can disturb a
  // viewer. The same rule as everywhere else: an unreadable /Sessions is UNKNOWN
  // and UNKNOWN refuses.
  const get = deps.jellyfin ?? jellyfinGet;
  const sessionsRes = await get(deps.config, '/Sessions');
  const playback = sessionsRes.ok
    ? parseSessions(sessionsRes.body)
    : { known: false, activeSessions: [], detail: `/Sessions unreadable: ${sessionsRes.error}` };

  if (!playback.known) {
    return await deferOrGiveUp(
      followup,
      store,
      now,
      `cannot tell whether anyone is watching (${playback.detail})`,
      async () =>
        speak(
          `${why}\n\nqBittorrent is still throttled and I have NOT lifted it: I cannot tell whether ` +
            `anyone is watching (${playback.detail}), and lifting it puts load back on the box. I have ` +
            'stopped retrying — run restore_qbit_speed when you know the coast is clear.',
        ),
    );
  }
  if (playback.activeSessions.length > 0) {
    return await deferOrGiveUp(
      followup,
      store,
      now,
      `someone is watching (${playback.detail})`,
      async () =>
        speak(
          `${why}\n\nqBittorrent is still throttled. I have left it that way because someone has been ` +
            `watching every time I checked (${playback.detail}), and lifting it puts load back on the ` +
            'box. It is not hurting anything where it is — tell me when you want it back.',
        ),
    );
  }

  // ── Is the box actually better? ───────────────────────────────────────────
  //
  // 🔴 ONLY `clear` licenses lifting it. Every other known verdict means the box
  // is still contended, and putting the load back would undo the fix.
  //
  // ⚠️ `qbit-not-the-cause` in particular must NOT be read as "the shed was
  // pointless, so undo it". While the throttle is ON, qBittorrent's throughput
  // is capped by definition — so a successful shed MAKES qBittorrent look
  // innocent. Treating that as grounds to lift would produce a loop: lift,
  // contend, shed, look innocent, lift. **A measurement taken through your own
  // intervention is not independent of it.**
  const observation = await observeContention(ctx);
  if (observation.verdict === 'unknown') {
    return await deferOrGiveUp(
      followup,
      store,
      now,
      `could not measure the host (${observation.detail})`,
      async () =>
        speak(
          `${why}\n\nqBittorrent is still throttled and I have NOT lifted it, because I could not ` +
            `measure whether the box is better: ${observation.detail} I have stopped retrying rather ` +
            'than lift a limit on a guess.',
        ),
    );
  }
  if (observation.verdict !== 'clear') {
    return await deferOrGiveUp(
      followup,
      store,
      now,
      `host still contended (${observation.verdict})`,
      async () =>
        speak(
          `${why}\n\nqBittorrent is STILL throttled and I am leaving it that way: the box is still ` +
            `loaded — ${observation.detail}\nTaking the limit off now would put that load straight back. ` +
            'I have stopped checking; run restore_qbit_speed when you want it back.',
        ),
    );
  }

  // ── Lift it, and verify with the tool that checks its own work ────────────
  const restore = await restoreQbitSpeed.run({}, { ...ctx, config: { ...deps.config, readOnly: false } });
  if (!restore.ok) {
    return await deferOrGiveUp(
      followup,
      store,
      now,
      `restore failed (${restore.content})`,
      async () =>
        speak(
          `${why}\n\nThe box looks fine now (${observation.detail}) so I tried to take the throttle off, ` +
            `and the restore FAILED: ${restore.content}\nqBittorrent may still be limited.`,
        ),
    );
  }

  store.resolve(followup.id, 'done', 'throttle lifted and verified', now);
  const sent = await speak(
    `${why}\n\nThe box is fine now — ${observation.detail}\n` +
      `Nobody is watching (${playback.detail}), so I have taken the throttle off: ${restore.content}`,
  );
  return {
    id: followup.id,
    action: sent ? 'restored' : 'not-delivered',
    sent,
    detail: 'throttle lifted and verified',
  };
}

/**
 * Try again later, or give up and SAY so.
 *
 * The give-up message is the point. A follow-up that quietly stops retrying has
 * left a change on the box that nobody knows about, which is the state this
 * whole module exists to prevent.
 */
async function deferOrGiveUp(
  followup: Followup,
  store: FollowupStore,
  now: Date,
  note: string,
  giveUpMessage: () => Promise<boolean>,
): Promise<FollowupOutcome> {
  const deferred = store.defer(followup.id, new Date(now.getTime() + RETRY_DELAY_MS), note, now);
  if (deferred) {
    return { id: followup.id, action: 'deferred', sent: false, detail: note };
  }
  store.resolve(followup.id, 'abandoned', note, now);
  const sent = await giveUpMessage();
  return { id: followup.id, action: sent ? 'abandoned' : 'not-delivered', sent, detail: note };
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(0)} KB/s`;
}

function describeAge(fromIso: string, now: Date): string {
  const ms = now.getTime() - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 0) return 'some time';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}
