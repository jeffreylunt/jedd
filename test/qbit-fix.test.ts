import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExecImpl } from '../src/hp.js';
import { diagnoseHostContention, restoreQbitSpeed, shedHostLoad } from '../src/tools/qbit.js';
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
  command: string;
}

/** Scripted ssh, recording every command a tool sent. */
function sshSpy(respond: (command: string) => { stdout?: string; exitCode?: number }): {
  calls: Call[];
  exec: ExecImpl;
} {
  const calls: Call[] = [];
  const exec: ExecImpl = (_file, args, _options, callback) => {
    const command = args[5] ?? '';
    calls.push({ command });
    const r = respond(command);
    const error = r.exitCode && r.exitCode !== 0 ? Object.assign(new Error('failed'), { code: r.exitCode }) : null;
    setImmediate(() => callback(error, r.stdout ?? '', ''));
  };
  return { calls, exec };
}

function ctxWith(spy: { exec: ExecImpl }, overrides = {}): ToolContext {
  return {
    role: 'owner',
    senderHandle: '+18015550123',
    config: testConfig({ readOnly: false, ...overrides }),
    exec: spy.exec,
    // No real waiting. The settle delay is 20 s in production.
    sleep: async () => {},
  };
}

const FAST = new Array(7).fill('http=200 total=0.001100').join('\n');
const SLOW = new Array(7).fill('http=200 total=0.310000').join('\n');
const BUSY = '{"connection_status":"connected","dl_info_speed":8388608,"up_info_speed":5242880}';
const IDLE = '{"connection_status":"connected","dl_info_speed":0,"up_info_speed":80581}';
const ALT_UNUSED = '{"alt_dl_limit":0,"alt_up_limit":0,"dl_limit":0,"up_limit":5242880}';

/**
 * A box that is contended, qBit-caused, with the alternate limits free — the one
 * state in which the fix is allowed to run. `afterLatency` scripts what the
 * symptom looks like once the shed has settled.
 */
function contendedBox(afterLatency: string, opts: { prefs?: string; modeHttp?: string; prefsHttp?: string } = {}) {
  let latencyCalls = 0;
  return sshSpy((command) => {
    if (command.includes('time_total')) {
      latencyCalls += 1;
      return { stdout: latencyCalls === 1 ? SLOW : afterLatency };
    }
    if (command.includes('transfer/info')) return { stdout: BUSY };
    if (command.includes('app/preferences')) return { stdout: opts.prefs ?? ALT_UNUSED };
    if (command.includes('setPreferences')) return { stdout: opts.prefsHttp ?? '200' };
    if (command.includes('setSpeedLimitsMode')) return { stdout: opts.modeHttp ?? '200' };
    if (command.includes('speedLimitsMode')) return { stdout: '0' };
    return { stdout: '' };
  });
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
  const spy = contendedBox(FAST, { prefs: '{"alt_dl_limit":2097152,"alt_up_limit":1048576}' });
  const result = await shedHostLoad.run({}, ctxWith(spy));
  assert.equal(result.ok, false);
  assert.equal(wrote(spy.calls), false, 'must not overwrite a deliberate setting');
  assert.match(result.content, /already configured/);
});

test('unreadable preferences is UNKNOWN, and UNKNOWN is not permission', async () => {
  const spy = contendedBox(FAST, { prefs: 'nope' });
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
  const spy = sshSpy((c) => (c.includes('setSpeedLimitsMode') ? { stdout: '200' } : { stdout: '0' }));
  const result = await restoreQbitSpeed.run({}, ctxWith(spy));
  assert.equal(result.ok, true);
  assert.equal(
    spy.calls.some((c) => c.command.includes('/transfer/speedLimitsMode') && !c.command.includes('set')),
    true,
    'restore must read the mode back',
  );
});

test('🔴 restore does not claim success when the read-back disagrees', async () => {
  const spy = sshSpy((c) => (c.includes('setSpeedLimitsMode') ? { stdout: '200' } : { stdout: '1' }));
  const result = await restoreQbitSpeed.run({}, ctxWith(spy));
  assert.equal(result.ok, false);
  assert.match(result.content, /UNKNOWN/);
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
