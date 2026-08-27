import { runOnHp } from '../hp.js';
import {
  MIN_LATENCY_SAMPLES,
  hostContentionVerdict,
  parseLatencySamples,
  parseQbitTransfer,
  recoveryVerdict,
  type LatencyReading,
} from '../safety.js';
import { RESTORE_CHECK_DELAY_MS } from '../followup-runner.js';
import { fail, ok, type Tool, type ToolContext } from './types.js';

/**
 * The first safe autonomous fix: shed host load by throttling qBittorrent.
 *
 * 🔴 WHY THIS FIX AND NOT A RESTART. A person reporting "the game is stuttering"
 * is a person WATCHING. Their report is itself proof that the restart-blocking
 * condition holds, so the intuitive response — restart something in the live-TV
 * path — is the worst available action (a mid-game Dispatcharr restart cost
 * eight hours of live TV on 2026-04-27). The report TIGHTENS the safety gate.
 *
 * Shedding qBittorrent's bandwidth is the one documented fix that helps a viewer
 * *without touching the stream*: it frees uplink and the CPU gluetun needs for
 * encryption, and it cannot interrupt playback because qBittorrent is not in the
 * playback path at all.
 *
 * ⚠️ That last sentence is a claim about THIS action specifically, not one
 * inherited from the SAFE tier it belongs to. The tier's own lesson is that a
 * member admitted on family resemblance is the one that fires wrongly — so:
 * qBittorrent serves no video, holds no lock Jellyfin takes, and shares only
 * host bandwidth and CPU with it. Reducing its share is strictly subtractive.
 *
 * ── HOW THE THROTTLE IS APPLIED, AND WHY IT IS NOT THE OBVIOUS WAY ───────────
 *
 * The obvious implementation is `POST /transfer/toggleSpeedLimitsMode`, flipping
 * qBittorrent into its "alternate speed limits" mode. **On this box that would
 * have made the problem WORSE.** Measured 2026-08-24: `up_limit` is 5 MB/s but
 * `alt_dl_limit` and `alt_up_limit` are both **0, meaning UNLIMITED**. Flipping
 * to alternate mode would have REMOVED the only cap in force. A fix is not safe
 * because its name sounds safe.
 *
 * So the throttle WRITES explicit shed values into the alternate limits first,
 * then switches to alternate mode. The advantage of using the alternate pair
 * rather than the normal one: **qBittorrent itself remembers what "normal"
 * means.** Restoring is a single mode flip back to 0, and Jeff's real limits
 * (`dl 0 / up 5 MB/s`) are never touched, never copied, and never need to be
 * remembered by Jedd — which matters because Jedd has no persistence yet, so any
 * "restore the value I saw earlier" design would lose the value on restart.
 *
 * `setSpeedLimitsMode` is used rather than `toggleSpeedLimitsMode` because it is
 * idempotent: a toggle applied twice by a retry silently un-does the fix.
 */

/** Shed values written into qBittorrent's ALTERNATE limits. Code constants. */
export const SHED_DOWN_BYTES_PER_SEC = 1024 * 1024;
export const SHED_UP_BYTES_PER_SEC = 256 * 1024;

/** How long to let the shed take effect before re-measuring the symptom. */
const SETTLE_MS = 20_000;

/**
 * Number of latency probes per measurement.
 *
 * ⚠️ MUST exceed `MIN_LATENCY_SAMPLES`, or every measurement is permanently
 * UNKNOWN and the tool can never act again. Asserted at module load rather than
 * left as a comment — the comment version of this invariant survived a mutation
 * that set it to 4 with the whole suite green.
 */
export const PROBE_COUNT = 7;
if (PROBE_COUNT <= MIN_LATENCY_SAMPLES) {
  throw new Error(
    `PROBE_COUNT (${PROBE_COUNT}) must exceed MIN_LATENCY_SAMPLES (${MIN_LATENCY_SAMPLES}) or every ` +
      'latency measurement is UNKNOWN and no fix can ever be applied.',
  );
}

/** Seconds between probes, so the sample window is seconds rather than milliseconds. */
const PROBE_SPACING_S = 0.5;
/** Per-probe budget. 20 s is the standing rule for every Jellyfin curl. */
const PROBE_MAX_TIME_S = 20;
/**
 * The ssh call must outlast the worst case it can produce, or the tool becomes
 * LESS able to measure exactly as the box gets slower. 7 probes x 20 s plus
 * spacing needs ~145 s; an earlier version allowed 60 s for work it had budgeted
 * 140 s of, so a genuinely contended box killed its own measurement.
 */
const PROBE_SSH_TIMEOUT_MS = Math.ceil(PROBE_COUNT * (PROBE_MAX_TIME_S + PROBE_SPACING_S) * 1000) + 20_000;

async function settle(ctx: ToolContext, ms: number): Promise<void> {
  if (ctx.sleep) return ctx.sleep(ms);
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Measure Jellyfin's LAN response time FROM THE HOST.
 *
 * It must run on hp: the question is whether hp itself is contended, and a probe
 * from this Mac would measure the Mac's network path instead. Uses
 * `/System/Info/Public`, which needs no key and — critically — **touches no
 * tuner**. Anything that enumerates channels or tuners is what wedged Jellyfin
 * site-wide for hours on 2026-07-26, and a stuttering-live-TV report is exactly
 * when a dead tuner is most likely.
 */
export async function measureLatency(ctx: ToolContext): Promise<LatencyReading> {
  const url = `${ctx.config.jellyfin.baseUrl}/System/Info/Public`;
  const outcome = await runOnHp(
    ctx.config.adminSshHost,
    `for i in $(seq 1 ${PROBE_COUNT}); do curl -s -o /dev/null --max-time ${PROBE_MAX_TIME_S} ` +
      `-w "http=%{http_code} total=%{time_total}\\n" ${url}; sleep ${PROBE_SPACING_S}; done`,
    PROBE_SSH_TIMEOUT_MS,
    ctx.exec,
  );
  return parseLatencySamples(outcome.stdout, outcome.exitCode, outcome.timedOut);
}

/** Read qBittorrent's current throughput. */
export async function measureQbit(ctx: ToolContext) {
  const outcome = await runOnHp(
    ctx.config.adminSshHost,
    `curl -s --max-time 8 ${ctx.config.qbittorrent.baseUrl}/api/v2/transfer/info`,
    20_000,
    ctx.exec,
  );
  return parseQbitTransfer(outcome.stdout, outcome.exitCode);
}

/**
 * The complete contention observation, shared by the diagnosis tool, the fix's
 * precondition, and the follow-up that decides whether the throttle can come off.
 *
 * One function so all three answer the same question the same way. A follow-up
 * that judged "is the box ok now" by a different rule than the one that judged
 * "is the box bad now" could take a throttle off a box it would immediately want
 * to put one back on.
 */
export async function observeContention(ctx: ToolContext) {
  const latency = await measureLatency(ctx);
  const qbit = await measureQbit(ctx);
  return { latency, qbit, ...hostContentionVerdict(latency, qbit) };
}

/**
 * What throttle, if any, is currently in force — and is it OURS?
 *
 * Three states. `unknown` is not "no throttle": an unreadable qBittorrent must
 * never license the follow-up to conclude there is nothing to clean up, because
 * concluding that is how a throttle stays on forever with nobody watching it.
 */
export async function readThrottleState(
  ctx: ToolContext,
): Promise<
  | { known: true; throttled: boolean; ours: boolean; altDown: number; altUp: number }
  | { known: false; detail: string }
> {
  const mode = await runOnHp(
    ctx.config.adminSshHost,
    `curl -s --max-time 8 ${ctx.config.qbittorrent.baseUrl}/api/v2/transfer/speedLimitsMode`,
    20_000,
    ctx.exec,
  );
  const raw = mode.stdout.trim();
  if (mode.exitCode !== 0 || (raw !== '0' && raw !== '1')) {
    return { known: false, detail: `speedLimitsMode read gave "${raw || '(empty)'}" (exit=${mode.exitCode})` };
  }
  const prefs = await runOnHp(
    ctx.config.adminSshHost,
    `curl -s --max-time 8 ${ctx.config.qbittorrent.baseUrl}/api/v2/app/preferences`,
    20_000,
    ctx.exec,
  );
  const limits = parseAltLimits(prefs.stdout, prefs.exitCode);
  if (!limits.known) return { known: false, detail: `preferences unreadable (${limits.detail})` };
  return {
    known: true,
    throttled: raw === '1',
    ours: limits.altDown === SHED_DOWN_BYTES_PER_SEC && limits.altUp === SHED_UP_BYTES_PER_SEC,
    altDown: limits.altDown,
    altUp: limits.altUp,
  };
}

/**
 * Diagnose only. Read-only, and safe to offer even when writes are disabled.
 *
 * This exists as its own tool because **"I cannot measure this" has to be a
 * reportable outcome.** A user asking "is live TV stuttering because of the
 * box?" deserves the measurement whether or not anything is fixable, and
 * deserves to be told when the instruments were blind rather than being told
 * that nothing is wrong.
 */
export const diagnoseHostContention: Tool = {
  name: 'diagnose_host_contention',
  description:
    'Measure whether the homelab host is overloaded, which is the most common cause of live-TV ' +
    'stuttering. Compares Jellyfin\'s LAN response time (the canary: ~1 ms healthy, hundreds of ms ' +
    'contended) against qBittorrent\'s current throughput. Read-only — it changes nothing. Returns one ' +
    'of four answers: contended and qBittorrent is the cause, contended but something else is, not ' +
    'contended, or could-not-measure. Use this before proposing any fix, and to answer "is the box ok".',
  minRole: 'owner',
  writes: false,
  parameters: { type: 'object', properties: {}, required: [] },
  async run(_args, ctx) {
    const verdict = await observeContention(ctx);
    const body = `${verdict.detail}\n\nverdict: ${verdict.verdict}`;
    // `clear` is a successful measurement; `unknown` is not. The ok flag is the
    // thing the turn record derives from, so it must not call a blind probe fine.
    return verdict.verdict === 'unknown' ? fail(body) : ok(body);
  },
};

/**
 * The fix. Fixed argv, no model-supplied command text, no parameters at all.
 *
 * "Safe" here is a property of WHICH TOOLS EXIST, not of a sentence in a prompt
 * telling the model to only run safe fixes and not of a filter over a command
 * string. There is no unsafe operation to screen out because none can be
 * expressed through this tool: the model's entire influence is the decision to
 * call it.
 */
export const shedHostLoad: Tool = {
  name: 'shed_host_load',
  description:
    'Fix live-TV stuttering caused by host overload, by throttling qBittorrent to free uplink bandwidth ' +
    'and VPN-encryption CPU. SAFE WHILE SOMEONE IS WATCHING — it touches no container in the playback ' +
    'path and interrupts nothing. It refuses unless it has MEASURED that the host is contended AND that ' +
    'qBittorrent is the cause, then re-measures afterwards to say whether it actually helped. Use ' +
    'restore_qbit_speed to undo it.',
  minRole: 'owner',
  writes: true,
  parameters: { type: 'object', properties: {}, required: [] },
  async run(_args, ctx) {
    if (ctx.config.readOnly) {
      return fail(
        `${ctx.config.displayName} is running read-only (JEDD_ALLOW_WRITES is not set). Nothing was changed.`,
      );
    }

    // ── PRECONDITION ────────────────────────────────────────────────────────
    const observation = await observeContention(ctx);
    const before = observation.latency;
    const verdict = { verdict: observation.verdict, detail: observation.detail };
    if (verdict.verdict !== 'shed-warranted') {
      return fail(`NOT APPLIED. ${verdict.detail}`);
    }

    // ── DO NOT CLOBBER A SETTING SOMEONE IS USING ───────────────────────────
    // The throttle writes qBittorrent's ALTERNATE limits. They are currently
    // unused on this box (both 0), which is what makes them free to borrow. If
    // they are ever configured, borrowing them would silently overwrite a real
    // setting — so check, and refuse rather than guess.
    const prefs = await runOnHp(
      ctx.config.adminSshHost,
      `curl -s --max-time 8 ${ctx.config.qbittorrent.baseUrl}/api/v2/app/preferences`,
      20_000,
      ctx.exec,
    );
    const existing = parseAltLimits(prefs.stdout, prefs.exitCode);
    if (!existing.known) {
      return fail(
        `NOT APPLIED. Could not read qBittorrent's current preferences (${existing.detail}), so I cannot ` +
          'tell whether throttling would overwrite a setting you rely on. UNKNOWN is not permission.',
      );
    }
    if (existing.altDown !== 0 || existing.altUp !== 0) {
      return fail(
        `NOT APPLIED. qBittorrent's alternate speed limits are already configured ` +
          `(down ${existing.altDown}, up ${existing.altUp} B/s). This fix borrows those two settings, and ` +
          'overwriting values someone chose deliberately is not a safe fix. Throttle it by hand instead.',
      );
    }

    // ── APPLY ───────────────────────────────────────────────────────────────
    const shed = await runOnHp(
      ctx.config.adminSshHost,
      `curl -s --max-time 10 -o /dev/null -w "%{http_code}" -X POST --data-urlencode ` +
        `'json={"alt_dl_limit":${SHED_DOWN_BYTES_PER_SEC},"alt_up_limit":${SHED_UP_BYTES_PER_SEC}}' ` +
        `${ctx.config.qbittorrent.baseUrl}/api/v2/app/setPreferences`,
      20_000,
      ctx.exec,
    );
    if (shed.exitCode !== 0 || shed.stdout.trim() !== '200') {
      return fail(
        `NOT APPLIED. Setting the shed limits failed (exit=${shed.exitCode}, http=${shed.stdout.trim() || 'none'}). ` +
          'Nothing was changed.',
      );
    }

    // 🔴 CORROBORATE THE WRITE BEFORE FLIPPING THE MODE. This is the most
    // dangerous moment in the file, and an HTTP 200 does not cover it.
    //
    // `POST /app/preferences` returns 200 for any syntactically valid `json=`
    // payload and reports nothing per key — a renamed or dropped preference
    // across a qBittorrent version bump is accepted and silently ignored. If
    // that happened, the alternate limits would still be 0/0, which on this box
    // means UNLIMITED, and flipping to alternate mode would REMOVE the 5 MB/s
    // upload cap that is currently the only one in force. The tool would then
    // report a throttle it had not applied, on a box someone just told us was
    // stuttering. Uncapping qBittorrent in response to a stutter report is the
    // exact inversion this whole file exists to prevent.
    const confirm = await runOnHp(
      ctx.config.adminSshHost,
      `curl -s --max-time 8 ${ctx.config.qbittorrent.baseUrl}/api/v2/app/preferences`,
      20_000,
      ctx.exec,
    );
    const landed = parseAltLimits(confirm.stdout, confirm.exitCode);
    if (!landed.known || landed.altDown !== SHED_DOWN_BYTES_PER_SEC || landed.altUp !== SHED_UP_BYTES_PER_SEC) {
      return fail(
        'NOT APPLIED. qBittorrent accepted the shed limits with HTTP 200 but reading them back gave ' +
          `${landed.known ? `down ${landed.altDown}, up ${landed.altUp}` : landed.detail} instead of ` +
          `down ${SHED_DOWN_BYTES_PER_SEC}, up ${SHED_UP_BYTES_PER_SEC}. I have NOT switched qBittorrent into ` +
          'alternate mode: doing so with the alternate limits unset would remove the upload cap that is ' +
          'currently in force and make the problem worse. Nothing was changed.',
      );
    }

    const mode = await setSpeedLimitsMode(ctx, 1);
    if (!mode.ok) {
      return fail(
        `PARTIALLY APPLIED. The shed limits were written but switching qBittorrent into alternate mode ` +
          `failed (${mode.detail}), so the throttle is NOT in force. qBittorrent is running at its normal ` +
          'limits. Nothing is broken; the fix simply did not take.',
      );
    }

    // ── AFTER-CHECK, INDEPENDENT OF THE MECHANISM ───────────────────────────
    // 🔴 Deliberately NOT "did the API return 200" and NOT "does qBittorrent
    // report alternate mode on". Both are the fix reporting on itself. The only
    // thing that answers "did this help" is the symptom: Jellyfin's latency,
    // measured the same way it was measured before.
    await settle(ctx, SETTLE_MS);
    const after = await measureLatency(ctx);
    const recovery = recoveryVerdict(before, after);
    // 🔴 NOTHING WILL EVER TAKE THIS THROTTLE OFF ON ITS OWN.
    //
    // The shed is a change to the box that outlives the conversation, and the
    // person who asked for help is not going to remember to ask for it back. So
    // the tool schedules its own return visit, and the promise it makes in the
    // reply is conditional on that scheduling having actually succeeded — a tool
    // that says "I'll check back" when nothing is watching is worse than one
    // that admits it cannot.
    const scheduled = ctx.followups?.schedule({
      kind: 'restore-qbit-throttle',
      senderHandle: ctx.senderHandle,
      dueAt: new Date(Date.now() + RESTORE_CHECK_DELAY_MS),
      reason: 'throttled qBittorrent because the host was contended and it was the cause',
      observed: verdict.detail,
    });

    const promise = scheduled
      ? ` I will check back in about ${Math.round(RESTORE_CHECK_DELAY_MS / 60_000)} minutes and take it ` +
        'off if the box is quiet and nobody is watching.'
      : ' ⚠️ I could NOT schedule a follow-up, so this throttle will stay on until someone removes it — ' +
        'run restore_qbit_speed when live TV is done.';

    const applied =
      `qBittorrent throttled to ${(SHED_DOWN_BYTES_PER_SEC / 1024).toFixed(0)} KB/s down / ` +
      `${(SHED_UP_BYTES_PER_SEC / 1024).toFixed(0)} KB/s up (alternate speed limits). ` +
      `Nothing in the playback path was touched.${promise}`;

    if (recovery.verdict === 'improved') {
      return ok(`FIXED. ${recovery.detail}\n\n${applied}`);
    }
    if (recovery.verdict === 'partially-improved') {
      // Deliberately NOT ok(): the symptom is still present, and a viewer whose
      // stream is still stuttering has not been fixed. But it is reported as a
      // real improvement rather than a failure, because calling a nine-fold
      // latency drop "did not help" would steer the next action toward a
      // restart — the one action this tool exists to avoid.
      return fail(
        `PARTIALLY FIXED. ${recovery.detail}\n\n${applied}\n` +
          'Something else is loading the host as well. Do NOT restart anything in the live-TV path on ' +
          'the strength of this; the person reporting the problem is watching right now.',
      );
    }
    if (recovery.verdict === 'not-improved') {
      // Deliberately NOT auto-reverted. A second automatic write on top of a
      // first one that did not work is how thrash starts, and the throttle is
      // harmless while it stands. Say so plainly and leave the choice.
      return fail(
        `APPLIED, BUT IT DID NOT HELP. ${recovery.detail}\n\n${applied}\n` +
          'So host contention from qBittorrent was not the whole story. I have left the throttle in ' +
          'place rather than thrashing the setting; run restore_qbit_speed if you want it back.',
      );
    }
    return fail(
      `APPLIED, BUT UNVERIFIED. ${recovery.detail}\n\n${applied}\n` +
        'I could not re-measure the symptom, so I do NOT know whether this helped. Unverified is not fixed.',
    );
  },
};

/** The inverse. Also an enumerated SAFE-tier action, not an invention. */
export const restoreQbitSpeed: Tool = {
  name: 'restore_qbit_speed',
  description:
    'Undo shed_host_load: switch qBittorrent back to its normal speed limits. Safe at any time. Use this ' +
    'once live TV is no longer being watched, or if the throttle did not help.',
  minRole: 'owner',
  writes: true,
  parameters: { type: 'object', properties: {}, required: [] },
  async run(_args, ctx) {
    if (ctx.config.readOnly) {
      return fail(
        `${ctx.config.displayName} is running read-only (JEDD_ALLOW_WRITES is not set). Nothing was changed.`,
      );
    }
    // ⚠️ Do not cancel a throttle that is not ours.
    //
    // qBittorrent's own scheduler can put the box into alternate mode, and this
    // tool clearing it would silently undo a limit somebody set on purpose —
    // the mirror image of the clobber the shed path refuses to commit. Ours is
    // identifiable: alternate mode ON with exactly our two shed constants.
    const current = await runOnHp(
      ctx.config.adminSshHost,
      `curl -s --max-time 8 ${ctx.config.qbittorrent.baseUrl}/api/v2/app/preferences`,
      20_000,
      ctx.exec,
    );
    const limits = parseAltLimits(current.stdout, current.exitCode);
    if (!limits.known) {
      return fail(
        `NOT RESTORED. Could not read qBittorrent's preferences (${limits.detail}), so I cannot tell ` +
          'whether the throttle in force is mine to remove.',
      );
    }
    const isOurs = limits.altDown === SHED_DOWN_BYTES_PER_SEC && limits.altUp === SHED_UP_BYTES_PER_SEC;
    const isClear = limits.altDown === 0 && limits.altUp === 0;
    if (!isOurs && !isClear) {
      return fail(
        `NOT RESTORED. qBittorrent's alternate limits are down ${limits.altDown}, up ${limits.altUp} B/s, ` +
          `which are not the values I would have set (down ${SHED_DOWN_BYTES_PER_SEC}, up ` +
          `${SHED_UP_BYTES_PER_SEC}). Someone else configured this throttle, and removing it is not mine to do.`,
      );
    }

    const mode = await setSpeedLimitsMode(ctx, 0);
    if (!mode.ok) {
      return fail(`NOT RESTORED. ${mode.detail} qBittorrent may still be throttled.`);
    }

    // 🔴 GIVE THE BORROWED SETTINGS BACK. Flipping the mode is not enough.
    //
    // The shed writes qBittorrent's alternate limits, and leaving them written
    // makes the fix SINGLE-USE: the next stutter report hits the
    // "already configured, someone chose these deliberately" refusal — which is
    // both a dead end and a lie, because Jedd chose them. It also leaves a cap
    // on the box that nobody set, waiting to surprise whoever enables
    // qBittorrent's scheduler. Borrowing a setting means putting it back.
    const zero = await runOnHp(
      ctx.config.adminSshHost,
      `curl -s --max-time 10 -o /dev/null -w "%{http_code}" -X POST --data-urlencode ` +
        `'json={"alt_dl_limit":0,"alt_up_limit":0}' ` +
        `${ctx.config.qbittorrent.baseUrl}/api/v2/app/setPreferences`,
      20_000,
      ctx.exec,
    );
    if (zero.exitCode !== 0 || zero.stdout.trim() !== '200') {
      return fail(
        `qBittorrent is back on its normal speed limits, but clearing the borrowed alternate limits ` +
          `failed (exit=${zero.exitCode}, http=${zero.stdout.trim() || 'none'}). The throttle is OFF, but ` +
          'those values are still set, so shed_host_load will refuse next time until they are cleared.',
      );
    }
    // Read the mode back rather than trusting the write's own 200. This is a
    // weaker independence than the fix's symptom check — there is no symptom to
    // measure for "went back to normal" — but it is still a separate call.
    const check = await runOnHp(
      ctx.config.adminSshHost,
      `curl -s --max-time 8 ${ctx.config.qbittorrent.baseUrl}/api/v2/transfer/speedLimitsMode`,
      20_000,
      ctx.exec,
    );
    const value = check.stdout.trim();
    if (check.exitCode !== 0 || value !== '0') {
      return fail(
        `The restore was accepted but reading the mode back gave "${value || '(empty)'}" (exit=${check.exitCode}) ` +
          'instead of 0. Whether qBittorrent is back to normal is UNKNOWN.',
      );
    }
    return ok(
      'qBittorrent is back on its normal speed limits: alternate mode off (verified by reading it back) ' +
        'and the borrowed alternate limits cleared to 0, so the fix can be applied again if needed.',
    );
  },
};

/** Set the speed-limits mode idempotently. `1` = alternate (throttled), `0` = normal. */
async function setSpeedLimitsMode(ctx: ToolContext, mode: 0 | 1): Promise<{ ok: boolean; detail: string }> {
  const out = await runOnHp(
    ctx.config.adminSshHost,
    `curl -s --max-time 10 -o /dev/null -w "%{http_code}" -X POST -d "mode=${mode}" ` +
      `${ctx.config.qbittorrent.baseUrl}/api/v2/transfer/setSpeedLimitsMode`,
    20_000,
    ctx.exec,
  );
  const code = out.stdout.trim();
  return out.exitCode === 0 && code === '200'
    ? { ok: true, detail: 'accepted' }
    : { ok: false, detail: `exit=${out.exitCode}, http=${code || 'none'}` };
}

/** Read the alternate limits out of `/app/preferences`. Unreadable is UNKNOWN. */
export function parseAltLimits(
  stdout: string,
  exitCode: number,
): { known: boolean; altDown: number; altUp: number; detail: string } {
  if (exitCode !== 0) return { known: false, altDown: 0, altUp: 0, detail: `exit ${exitCode}` };
  let body: unknown;
  try {
    body = JSON.parse(stdout.trim());
  } catch {
    return { known: false, altDown: 0, altUp: 0, detail: 'preferences were not JSON' };
  }
  const rec = body as Record<string, unknown>;
  const down = rec['alt_dl_limit'];
  const up = rec['alt_up_limit'];
  if (typeof down !== 'number' || typeof up !== 'number') {
    return { known: false, altDown: 0, altUp: 0, detail: 'no numeric alt_dl_limit/alt_up_limit' };
  }
  return { known: true, altDown: down, altUp: up, detail: 'read' };
}
