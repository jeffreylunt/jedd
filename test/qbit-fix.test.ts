import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExecImpl } from '../src/hp.js';
import { PROBE_COUNT, diagnoseHostContention, restoreQbitSpeed, shedHostLoad } from '../src/tools/qbit.js';
import { CONTENTION_MS, MIN_LATENCY_SAMPLES } from '../src/safety.js';
import type { ToolContext } from '../src/tools/types.js';
import { testConfig } from './helpers.js';

/**
 * The fix tool, end to end, against scripted instrument readings.
 *
 * The three properties under test, in the order they can hurt someone:
 *  1. UNKNOWN never authorises the write — and the write must not merely be
 *     *reported* as skipped, it must not HAPPEN. Only the call log proves that.
 *  2. The after-check reads the SYMPTOM, not the mechanism. A test that let the
 *     tool ask qBittorrent whether qBittorrent complied would pass while
 *     verifying nothing.
 *  3. "Applied but did not help" and "applied but unverifiable" are reported as
 *     failures, never as a fix.
 */

interface Call {
  host: string;
  command: string;
}

/**
 * A stateful fake qBittorrent plus a recording ssh spy.
 *
 * ⚠️ Stateful on purpose. An earlier stateless version answered `app/preferences`
 * with the same body forever, so it could not represent "the write landed" or
 * "the write was silently ignored" — and those are now different code paths with
 * very different consequences. It also could not see that restore left the
 * borrowed limits behind, which made the fix single-use.
 */
function fakeQbit(opts: {
  latency: (nth: number) => string;
  transfer?: string;
  altDown?: number;
  altUp?: number;
  /** Simulate qBittorrent accepting a preferences write and ignoring it. */
  swallowWrites?: boolean;
  prefsBody?: string;
  prefsHttp?: string;
  modeHttp?: string;
  zeroHttp?: string;
} ) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const state = { altDown: opts.altDown ?? 0, altUp: opts.altUp ?? 0, mode: '0' };
  let latencyCalls = 0;

  const exec: ExecImpl = (_file, args, _options, callback) => {
    const host = args[4] ?? '';
    const command = args[5] ?? '';
    calls.push({ host, command });
    let stdout = '';
    let exitCode = 0;

    if (command.includes('time_total')) {
      latencyCalls += 1;
      stdout = opts.latency(latencyCalls);
    } else if (command.includes('transfer/info')) {
      stdout = opts.transfer ?? BUSY;
    } else if (command.includes('setPreferences')) {
      stdout = opts.prefsHttp ?? '200';
      const isZeroing = command.includes('"alt_dl_limit":0');
      if (isZeroing && opts.zeroHttp) stdout = opts.zeroHttp;
      if (stdout === '200' && !opts.swallowWrites) {
        const dl = /"alt_dl_limit":(\d+)/.exec(command);
        const up = /"alt_up_limit":(\d+)/.exec(command);
        if (dl) state.altDown = Number(dl[1]);
        if (up) state.altUp = Number(up[1]);
      }
    } else if (command.includes('app/preferences')) {
      stdout = opts.prefsBody ?? `{"alt_dl_limit":${state.altDown},"alt_up_limit":${state.altUp}}`;
    } else if (command.includes('setSpeedLimitsMode')) {
      stdout = opts.modeHttp ?? '200';
      if (stdout === '200') state.mode = /mode=1/.test(command) ? '1' : '0';
    } else if (command.includes('speedLimitsMode')) {
      stdout = state.mode;
    }
    if (exitCode === 0 && stdout === '' && command.includes('curl')) stdout = '';
    setImmediate(() => callback(null, stdout, ''));
  };
  return { calls, sleeps, state, exec };
}

/** Scripted ssh for the simpler cases: one responder, no state. */
function sshSpy(respond: (command: string) => { stdout?: string; exitCode?: number }) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const exec: ExecImpl = (_file, args, _options, callback) => {
    const host = args[4] ?? '';
    const command = args[5] ?? '';
    calls.push({ host, command });
    const r = respond(command);
    const error = r.exitCode && r.exitCode !== 0 ? Object.assign(new Error('failed'), { code: r.exitCode }) : null;
    setImmediate(() => callback(error, r.stdout ?? '', ''));
  };
  return { calls, sleeps, exec };
}

function ctxWith(spy: { exec: ExecImpl; sleeps: number[] }, overrides = {}): ToolContext {
  return {
    role: 'owner',
    senderHandle: '+18015550123',
    config: testConfig({ readOnly: false, adminSshHost: 'admin-host', shellSshHost: 'shell-host', ...overrides }),
    exec: spy.exec,
    // Records instead of waiting. The settle delay is 20 s in production.
    sleep: async (ms: number) => {
      spy.sleeps.push(ms);
    },
  };
}

/**
 * Probe output built FROM `PROBE_COUNT`, never from a hard-coded 7.
 *
 * A fixture that hard-codes the count cannot see a change to it: setting
 * PROBE_COUNT below MIN_LATENCY_SAMPLES makes every real measurement UNKNOWN
 * forever, and with a fixed-length fixture the suite stays green while the tool
 * is permanently unable to act.
 */
function probes(ms: number, count = PROBE_COUNT): string {
  return new Array(count).fill(`http=200 total=${(ms / 1000).toFixed(6)}`).join('\n');
}

const FAST = probes(1.1);
const SLOW = probes(310);
const BUSY = '{"connection_status":"connected","dl_info_speed":8388608,"up_info_speed":5242880}';
const IDLE = '{"connection_status":"connected","dl_info_speed":0,"up_info_speed":80581}';

/** The one state in which the fix is allowed to run. */
function contendedBox(after: string, opts: Partial<Parameters<typeof fakeQbit>[0]> = {}) {
  return fakeQbit({ latency: (n) => (n === 1 ? SLOW : after), ...opts });
}

/** Did this tool actually change anything on the box? */
function wrote(calls: Call[]): boolean {
  return calls.some((c) => c.command.includes('setPreferences') || c.command.includes('setSpeedLimitsMode'));
}

// ── the precondition ─────────────────────────────────────────────────────────

test('🔴 UNKNOWN never authorises the fix, and the write never HAPPENS', async () => {
  const blindnesses: { name: string; respond: (c: string) => { stdout?: string; exitCode?: number } }[] = [
    {
      name: 'the latency probe itself failed',
      respond: (c) => (c.includes('time_total') ? { exitCode: 255 } : { stdout: BUSY }),
    },
    {
      name: 'too few probes came back',
      respond: (c) => (c.includes('time_total') ? { stdout: 'http=200 total=0.31\nhttp=000 total=20.0' } : { stdout: BUSY }),
    },
    {
      name: "qBittorrent's API was unreachable",
      respond: (c) => (c.includes('time_total') ? { stdout: SLOW } : { exitCode: 7 }),
    },
    {
      name: 'qBittorrent returned non-JSON',
      respond: (c) => (c.includes('time_total') ? { stdout: SLOW } : { stdout: '<html>Unauthorized</html>' }),
    },
  ];

  for (const { name, respond } of blindnesses) {
    const spy = sshSpy(respond);
    const result = await shedHostLoad.run({}, ctxWith(spy));
    assert.equal(result.ok, false, `must refuse when ${name}`);
    assert.equal(wrote(spy.calls), false, `must not WRITE when ${name}: ${spy.calls.map((c) => c.command).join(' ;; ')}`);
  }
});

test('🔴 a healthy box is refused — and told it was MEASURED, not that we were blind', async () => {
  const spy = sshSpy((c) => (c.includes('time_total') ? { stdout: FAST } : { stdout: BUSY }));
  const result = await shedHostLoad.run({}, ctxWith(spy));
  assert.equal(result.ok, false);
  assert.equal(wrote(spy.calls), false);
  assert.match(result.content, /NOT contended/);
  assert.match(result.content, /measurement, not a failure to measure/);
});

test('🔴 contended but qBittorrent is idle: refuse, and say the fix would not help', async () => {
  // The most valuable refusal in the set. Most live-TV faults are not fixable by
  // shedding load, and applying a fix that cannot work is worse than saying so.
  const spy = sshSpy((c) => (c.includes('time_total') ? { stdout: SLOW } : { stdout: IDLE }));
  const result = await shedHostLoad.run({}, ctxWith(spy));
  assert.equal(result.ok, false);
  assert.equal(wrote(spy.calls), false);
  assert.match(result.content, /would not fix this|not the bottleneck|Something else/i);
});

test('🔴 CONTROL: the one authorised state DOES write, so the refusals above are real', async () => {
  const spy = contendedBox(FAST);
  const result = await shedHostLoad.run({}, ctxWith(spy));
  assert.equal(result.ok, true, result.content);
  assert.equal(wrote(spy.calls), true, 'the fix must actually write in the state that warrants it');
  assert.match(result.content, /^FIXED\./);
});

test('read-only mode refuses before touching anything', async () => {
  const spy = contendedBox(FAST);
  const result = await shedHostLoad.run({}, ctxWith(spy, { readOnly: true }));
  assert.equal(result.ok, false);
  assert.equal(spy.calls.length, 0, 'read-only must refuse before it even measures');
});

// ── not clobbering a setting someone chose ───────────────────────────────────

test('🔴 refuses rather than overwriting alternate limits somebody is already using', async () => {
  const spy = contendedBox(FAST, { altDown: 2_097_152, altUp: 1_048_576 });
  const result = await shedHostLoad.run({}, ctxWith(spy));
  assert.equal(result.ok, false);
  assert.equal(wrote(spy.calls), false, 'must not overwrite a deliberate setting');
  assert.match(result.content, /already configured/);
});

test('unreadable preferences is UNKNOWN, and UNKNOWN is not permission', async () => {
  const spy = contendedBox(FAST, { prefsBody: 'nope' });
  const result = await shedHostLoad.run({}, ctxWith(spy));
  assert.equal(result.ok, false);
  assert.equal(wrote(spy.calls), false);
  assert.match(result.content, /UNKNOWN is not permission/);
});

// ── the after-check ──────────────────────────────────────────────────────────

test('🔴 the after-check re-measures the SYMPTOM, not the mechanism', async () => {
  const spy = contendedBox(FAST);
  await shedHostLoad.run({}, ctxWith(spy));

  const latencyProbes = spy.calls.filter((c) => c.command.includes('time_total'));
  assert.equal(latencyProbes.length, 2, 'the symptom must be measured before AND after');

  // The last thing the tool does must be the independent measurement, not a
  // question to the thing it just changed.
  const last = spy.calls[spy.calls.length - 1]?.command ?? '';
  assert.match(last, /time_total/, `the final check was "${last}" — that is the mechanism, not the symptom`);
  assert.doesNotMatch(last, /speedLimitsMode|setPreferences/);
});

test('🔴 applied but the symptom persisted is a FAILURE, never a fix', async () => {
  const spy = contendedBox(SLOW);
  const result = await shedHostLoad.run({}, ctxWith(spy));
  assert.equal(result.ok, false);
  assert.equal(wrote(spy.calls), true, 'it did apply');
  assert.match(result.content, /DID NOT HELP/);
  assert.match(result.content, /restore_qbit_speed/);
});

test('🔴 applied but unverifiable is reported as UNVERIFIED, never as fixed', async () => {
  const spy = contendedBox('http=000 total=20.000000');
  const result = await shedHostLoad.run({}, ctxWith(spy));
  assert.equal(result.ok, false);
  assert.match(result.content, /UNVERIFIED/);
  assert.match(result.content, /Unverified is not fixed/);
});

test('a failed mode switch reports the throttle is NOT in force', async () => {
  const spy = contendedBox(FAST, { modeHttp: '403' });
  const result = await shedHostLoad.run({}, ctxWith(spy));
  assert.equal(result.ok, false);
  assert.match(result.content, /NOT in force/);
});

test('a failed preferences write changes nothing and says so', async () => {
  const spy = contendedBox(FAST, { prefsHttp: '500' });
  const result = await shedHostLoad.run({}, ctxWith(spy));
  assert.equal(result.ok, false);
  assert.match(result.content, /Nothing was changed/);
  assert.equal(
    spy.calls.some((c) => c.command.includes('setSpeedLimitsMode')),
    false,
    'must not switch modes after failing to write the limits it would switch to',
  );
});

// ── the fix has fixed argv ───────────────────────────────────────────────────

test('🔴 neither fix tool accepts ANY parameter — the model composes no command text', async () => {
  for (const tool of [shedHostLoad, restoreQbitSpeed, diagnoseHostContention]) {
    const props = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    assert.deepEqual(Object.keys(props), [], `${tool.name} must take no arguments at all`);
  }

  // And the shed values in the emitted command are code constants, so nothing a
  // caller passes can change what gets written.
  const spy = contendedBox(FAST);
  await shedHostLoad.run({ alt_dl_limit: 999, hashes: 'all; rm -rf /' }, ctxWith(spy));
  const write = spy.calls.find((c) => c.command.includes('setPreferences'))?.command ?? '';
  assert.match(write, /"alt_dl_limit":1048576,"alt_up_limit":262144/);
  assert.doesNotMatch(write, /999|rm -rf/);
});

// ── restore ──────────────────────────────────────────────────────────────────

test('restore reads the mode back rather than trusting its own write', async () => {
  const spy = fakeQbit({ latency: () => FAST, altDown: 1_048_576, altUp: 262_144 });
  const result = await restoreQbitSpeed.run({}, ctxWith(spy));
  assert.equal(result.ok, true, result.content);
  assert.equal(
    spy.calls.some((c) => c.command.includes('/transfer/speedLimitsMode') && !c.command.includes('set')),
    true,
    'restore must read the mode back',
  );
});

test('🔴 restore does not claim success when the read-back disagrees', async () => {
  // The mode write is accepted but the box still reports alternate mode on.
  const spy = sshSpy((c) => {
    if (c.includes('setSpeedLimitsMode') || c.includes('setPreferences')) return { stdout: '200' };
    // Ours to remove, so it gets past the ownership guard...
    if (c.includes('app/preferences')) return { stdout: '{"alt_dl_limit":1048576,"alt_up_limit":262144}' };
    // ...but the box still reports alternate mode ON afterwards.
    if (c.includes('speedLimitsMode')) return { stdout: '1' };
    return { stdout: '' };
  });
  const result = await restoreQbitSpeed.run({}, ctxWith(spy));
  assert.equal(result.ok, false);
  assert.match(result.content, /UNKNOWN/);
});

test('🔴 restore GIVES THE BORROWED SETTINGS BACK, so the fix is not single-use', async () => {
  // Without this, run 1 succeeds, restore reports success, and run 2 refuses
  // with "someone chose these deliberately" — about values Jedd itself wrote.
  const spy = contendedBox(FAST);
  const ctx = ctxWith(spy);

  const first = await shedHostLoad.run({}, ctx);
  assert.equal(first.ok, true, first.content);
  assert.equal(spy.state.altDown, 1_048_576);
  assert.equal(spy.state.mode, '1');

  const restored = await restoreQbitSpeed.run({}, ctx);
  assert.equal(restored.ok, true, restored.content);
  assert.equal(spy.state.mode, '0');
  assert.equal(spy.state.altDown, 0, 'the borrowed download limit must be handed back');
  assert.equal(spy.state.altUp, 0, 'the borrowed upload limit must be handed back');

  // And the fix must be applicable again.
  const again = await shedHostLoad.run({}, ctxWith(contendedBox(FAST)));
  assert.equal(again.ok, true, `the fix became single-use: ${again.content}`);
});

test('restore says so when it could not clear the borrowed limits', async () => {
  const spy = contendedBox(FAST, { altDown: 1_048_576, altUp: 262_144, zeroHttp: '500' });
  const result = await restoreQbitSpeed.run({}, ctxWith(spy));
  assert.equal(result.ok, false);
  assert.match(result.content, /still set|refuse next time/);
});

// ── the read-only diagnosis ──────────────────────────────────────────────────

test('diagnose_host_contention changes nothing, whatever it finds', async () => {
  for (const [latency, qbit] of [
    [SLOW, BUSY],
    [FAST, BUSY],
    [SLOW, IDLE],
  ]) {
    const spy = sshSpy((c) => (c.includes('time_total') ? { stdout: latency as string } : { stdout: qbit as string }));
    await diagnoseHostContention.run({}, ctxWith(spy));
    assert.equal(wrote(spy.calls), false, 'a diagnosis must never write');
  }
});

test('🔴 "could not measure" is a FAILED diagnosis, not a clean bill of health', async () => {
  const blind = sshSpy((c) => (c.includes('time_total') ? { exitCode: 255 } : { stdout: BUSY }));
  const unknown = await diagnoseHostContention.run({}, ctxWith(blind));
  assert.equal(unknown.ok, false, 'a blind probe must not be recorded as a successful check');

  // Control: a real measurement that finds nothing wrong IS a success.
  const healthy = sshSpy((c) => (c.includes('time_total') ? { stdout: FAST } : { stdout: BUSY }));
  const clear = await diagnoseHostContention.run({}, ctxWith(healthy));
  assert.equal(clear.ok, true);
  assert.match(clear.content, /verdict: clear/);
});

// ── the gaps an independent review found in the tests themselves ─────────────

test('🔴 CRITICAL: a preferences write that is ACCEPTED but IGNORED must not flip the mode', async () => {
  // POST /app/preferences returns 200 for any valid json= payload and reports
  // nothing per key, so a renamed key across a version bump is swallowed. If
  // that happened and the mode flipped anyway, qBittorrent's alternate limits
  // would still be 0 — which on this box means UNLIMITED — and the "fix" would
  // REMOVE the 5 MB/s upload cap on a box someone just reported as stuttering.
  const spy = contendedBox(FAST, { swallowWrites: true });
  const result = await shedHostLoad.run({}, ctxWith(spy));

  assert.equal(result.ok, false);
  assert.match(result.content, /reading them back gave/);
  assert.equal(
    spy.calls.some((c) => c.command.includes('setSpeedLimitsMode')),
    false,
    'the mode must NOT be flipped when the limits did not land — that would uncap qBittorrent',
  );
  assert.equal(spy.state.mode, '0');
});

test('🔴 every qBittorrent tool uses the ADMIN identity on EVERY ssh call it makes', async () => {
  // Ported from the docker-tool suite. Pointing one of these at the unprivileged
  // shell account would not fail loudly — it would return a permission error
  // that reads like a broken qBittorrent. An earlier version of this file
  // recorded only the command and discarded the host, and all six calls could be
  // flipped to the shell identity with the suite green.
  const cases: [string, () => { calls: Call[]; sleeps: number[]; exec: ExecImpl }][] = [
    ['shed_host_load', () => contendedBox(FAST)],
    ['restore_qbit_speed', () => fakeQbit({ latency: () => FAST, altDown: 1_048_576, altUp: 262_144 })],
    ['diagnose_host_contention', () => fakeQbit({ latency: () => SLOW })],
  ];
  const tools = { shed_host_load: shedHostLoad, restore_qbit_speed: restoreQbitSpeed, diagnose_host_contention: diagnoseHostContention };
  for (const [name, make] of cases) {
    const spy = make();
    await tools[name as keyof typeof tools].run({}, ctxWith(spy));
    assert.ok(spy.calls.length > 0, `${name} made no ssh call`);
    for (const call of spy.calls) {
      assert.equal(call.host, 'admin-host', `${name} used "${call.host}" for: ${call.command}`);
    }
  }
});

test('🔴 PROBE_COUNT must exceed MIN_LATENCY_SAMPLES or nothing can ever be measured', async () => {
  // The invariant was a comment. Setting PROBE_COUNT to 4 makes every real
  // measurement permanently UNKNOWN — the tool can never fix anything again —
  // and a fixture that hard-codes 7 lines keeps the suite green throughout.
  assert.ok(
    PROBE_COUNT > MIN_LATENCY_SAMPLES,
    `PROBE_COUNT (${PROBE_COUNT}) must exceed MIN_LATENCY_SAMPLES (${MIN_LATENCY_SAMPLES})`,
  );

  // And the command actually asks for that many.
  const spy = contendedBox(FAST);
  await shedHostLoad.run({}, ctxWith(spy));
  const probe = spy.calls.find((c) => c.command.includes('time_total'))?.command ?? '';
  assert.match(probe, new RegExp(`seq 1 ${PROBE_COUNT}`));
});

test('🔴 the tool WAITS for the shed to take effect before re-measuring', async () => {
  // Without a settle, the after-check measures the box as it was before the
  // throttle could bite, and the independence of the after-check buys nothing.
  const spy = contendedBox(FAST);
  await shedHostLoad.run({}, ctxWith(spy));
  assert.equal(spy.sleeps.length, 1, `expected exactly one settle, got ${JSON.stringify(spy.sleeps)}`);
  assert.ok(spy.sleeps[0]! >= 10_000, `settle was ${spy.sleeps[0]} ms — too short for a throttle to bite`);

  // And it happens BETWEEN the mode flip and the second measurement, which is
  // the only ordering that makes it meaningful.
  const modeAt = spy.calls.findIndex((c) => c.command.includes('setSpeedLimitsMode'));
  const probeIndexes = spy.calls.map((c, i) => (c.command.includes('time_total') ? i : -1)).filter((i) => i >= 0);
  assert.ok(modeAt >= 0 && (probeIndexes[1] as number) > modeAt, 'the after-probe must follow the mode flip');
});

test('🔴 the CONTENTION_MS boundary is pinned from both sides', async () => {
  // Every other fixture is 1 ms or 310 ms, so both `<` -> `<=` mutations
  // survived. A correct-but-unpinned boundary is one careless edit from wrong.
  const atThreshold = sshSpy((c) => (c.includes('time_total') ? { stdout: probes(CONTENTION_MS) } : { stdout: BUSY }));
  const at = await diagnoseHostContention.run({}, ctxWith(atThreshold));
  assert.match(at.content, /verdict: shed-warranted/, 'exactly at the threshold counts as contended');

  const under = sshSpy((c) =>
    c.includes('time_total') ? { stdout: probes(CONTENTION_MS - 0.01) } : { stdout: BUSY },
  );
  const below = await diagnoseHostContention.run({}, ctxWith(under));
  assert.match(below.content, /verdict: clear/, 'a hair under the threshold is clear');
});

test('🔴 a BURSTY box is contended even though the median looks perfect', async () => {
  // The symptom being reported is intermittent, and the median is exactly the
  // statistic that erases it. Four fast probes and three stalls: median ~1 ms.
  const bursty = `${probes(1.1, 4)}\nhttp=200 total=0.380000\nhttp=200 total=0.420000\nhttp=200 total=0.450000`;
  const spy = sshSpy((c) => (c.includes('time_total') ? { stdout: bursty } : { stdout: BUSY }));
  const result = await diagnoseHostContention.run({}, ctxWith(spy));
  assert.match(result.content, /verdict: shed-warranted/);
  assert.match(result.content, /intermittent stalls/);

  // CONTROL: ONE stall is noise, not a burst — otherwise this fires constantly.
  const oneStall = `${probes(1.1, 6)}\nhttp=200 total=0.380000`;
  const control = sshSpy((c) => (c.includes('time_total') ? { stdout: oneStall } : { stdout: BUSY }));
  const clear = await diagnoseHostContention.run({}, ctxWith(control));
  assert.match(clear.content, /verdict: clear/);
});

test('🔴 a large-but-insufficient improvement is not called a failure', async () => {
  // 500 ms -> 55 ms was reported as "the load shed did NOT resolve the symptom".
  // A nine-fold improvement described as a failure steers the next action toward
  // a restart, which is the one thing this tool exists to avoid.
  const spy = fakeQbit({ latency: (n) => (n === 1 ? probes(500) : probes(55)) });
  const result = await shedHostLoad.run({}, ctxWith(spy));
  assert.equal(result.ok, false, 'the symptom is still present, so this is not a success');
  assert.match(result.content, /PARTIALLY FIXED/);
  assert.match(result.content, /real improvement/);
  assert.doesNotMatch(result.content, /did NOT resolve/);
});

test('the alt-limit clobber guard checks BOTH limits independently', async () => {
  // A human who capped only their upload is the realistic shape, and the
  // both-non-zero fixture could not tell `||` from `&&`.
  for (const [down, up] of [
    [0, 1_048_576],
    [2_097_152, 0],
  ]) {
    const spy = contendedBox(FAST, { altDown: down, altUp: up });
    const result = await shedHostLoad.run({}, ctxWith(spy));
    assert.equal(result.ok, false, `must refuse with alt limits ${down}/${up}`);
    assert.match(result.content, /already configured/);
  }
});

test('preferences with the right keys and the wrong types is UNKNOWN, not permission', async () => {
  const spy = contendedBox(FAST, { prefsBody: '{"alt_dl_limit":"0","alt_up_limit":null}' });
  const result = await shedHostLoad.run({}, ctxWith(spy));
  assert.equal(result.ok, false);
  assert.equal(wrote(spy.calls), false);
  assert.match(result.content, /UNKNOWN is not permission/);
});
