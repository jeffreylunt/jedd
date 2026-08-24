import { runOnHp } from '../hp.js';
import {
  CONTENTION_MS,
  MIN_LATENCY_SAMPLES,
  hostContentionVerdict,
  parseLatencySamples,
  parseQbitTransfer,
  recoveryVerdict,
  type LatencyReading,
} from '../safety.js';
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
const SHED_DOWN_BYTES_PER_SEC = 1024 * 1024;
const SHED_UP_BYTES_PER_SEC = 256 * 1024;

/** How long to let the shed take effect before re-measuring the symptom. */
const SETTLE_MS = 20_000;

/** Number of latency probes per measurement. Must exceed MIN_LATENCY_SAMPLES. */
const PROBE_COUNT = 7;

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
async function measureLatency(ctx: ToolContext): Promise<LatencyReading> {
  const url = `${ctx.config.jellyfin.baseUrl}/System/Info/Public`;
  const outcome = await runOnHp(
    ctx.config.adminSshHost,
    `for i in $(seq 1 ${PROBE_COUNT}); do curl -s -o /dev/null --max-time 20 ` +
      `-w "http=%{http_code} total=%{time_total}\\n" ${url}; done`,
    60_000,
    ctx.exec,
  );
  return parseLatencySamples(outcome.stdout, outcome.exitCode);
}

/** Read qBittorrent's current throughput. */
async function measureQbit(ctx: ToolContext) {
  const outcome = await runOnHp(
    ctx.config.adminSshHost,
    `curl -s --max-time 8 ${ctx.config.qbittorrent.baseUrl}/api/v2/transfer/info`,
    20_000,
    ctx.exec,
  );
  return parseQbitTransfer(outcome.stdout, outcome.exitCode);
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
  parameters: { type: 'object', properties: {}, required: [] },
  async run(_args, ctx) {
    const latency = await measureLatency(ctx);
    const qbit = await measureQbit(ctx);
    const verdict = hostContentionVerdict(latency, qbit);
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
  parameters: { type: 'object', properties: {}, required: [] },
  async run(_args, ctx) {
    if (ctx.config.readOnly) {
      return fail('Jedd is running read-only (JEDD_ALLOW_WRITES is not set). Nothing was changed.');
    }

    // ── PRECONDITION ────────────────────────────────────────────────────────
    const before = await measureLatency(ctx);
    const qbit = await measureQbit(ctx);
    const verdict = hostContentionVerdict(before, qbit);
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
    const applied =
      `qBittorrent throttled to ${(SHED_DOWN_BYTES_PER_SEC / 1024).toFixed(0)} KB/s down / ` +
      `${(SHED_UP_BYTES_PER_SEC / 1024).toFixed(0)} KB/s up (alternate speed limits). ` +
      'Nothing in the playback path was touched. Undo with restore_qbit_speed.';

    if (recovery.verdict === 'improved') {
      return ok(`FIXED. ${recovery.detail}\n\n${applied}`);
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
  parameters: { type: 'object', properties: {}, required: [] },
  async run(_args, ctx) {
    if (ctx.config.readOnly) {
      return fail('Jedd is running read-only (JEDD_ALLOW_WRITES is not set). Nothing was changed.');
    }
    const mode = await setSpeedLimitsMode(ctx, 0);
    if (!mode.ok) {
      return fail(`NOT RESTORED. ${mode.detail} qBittorrent may still be throttled.`);
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
    return ok('qBittorrent is back on its normal speed limits (alternate mode off, verified by reading it back).');
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

export { CONTENTION_MS, MIN_LATENCY_SAMPLES };
