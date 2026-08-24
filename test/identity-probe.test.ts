import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExecImpl } from '../src/hp.js';
import { proveShellIdentityIsSafe } from '../src/identity-probe.js';
import { testConfig } from './helpers.js';

/**
 * The boot check that RUNS.
 *
 * 🔴 The defect being replaced: the boundary was decided by comparing two ssh
 * ALIASES for inequality. `HP_SHELL_SSH_HOST=jeff@hp` against
 * `HP_ADMIN_SSH_HOST=hp` is two different strings and one account. Every test
 * here that matters uses aliases that DIFFER, because a probe that only catches
 * identical strings catches nothing the old check did not.
 */

const SHELL = 'shell-host.invalid';
const ADMIN = 'admin-host.invalid';

/** Script `id` and `docker ps` per host. */
function probeSpy(
  answer: (host: string, command: string) => { stdout?: string; stderr?: string; exitCode?: number },
) {
  const calls: { host: string; command: string }[] = [];
  const exec: ExecImpl = (_f, args, _o, cb) => {
    const host = args[4] ?? '';
    const command = args[5] ?? '';
    calls.push({ host, command });
    const r = answer(host, command);
    const error = r.exitCode ? Object.assign(new Error('failed'), { code: r.exitCode }) : null;
    setImmediate(() => cb(error, r.stdout ?? '', r.stderr ?? ''));
  };
  return { calls, exec };
}

const idOf = (uid: string, user: string, groups: string) => `${uid}\n${user}\n${groups}\n`;

/** A correctly split box: two accounts, shell refused by docker, admin allowed. */
function healthyBox(over: { shellId?: string; adminId?: string; shellDocker?: () => unknown; adminDocker?: () => unknown } = {}) {
  return probeSpy((host, command) => {
    if (command.startsWith('id ')) {
      return {
        stdout:
          host === SHELL
            ? over.shellId ?? idOf('1001', 'jedd-shell', 'jedd-shell')
            : over.adminId ?? idOf('1000', 'jeff', 'jeff adm sudo docker'),
      };
    }
    if (host === SHELL) {
      return (over.shellDocker?.() as never) ?? {
        exitCode: 1,
        stderr: 'permission denied while trying to connect to the docker API at unix:///var/run/docker.sock',
      };
    }
    return (over.adminDocker?.() as never) ?? { stdout: 'abc123\ndef456\n' };
  });
}

test('🔴 a correctly split box is PROVEN, and the proof names both accounts', async () => {
  const spy = healthyBox();
  const verdict = await proveShellIdentityIsSafe(testConfig({ shellSshHost: SHELL, adminSshHost: ADMIN }), spy.exec);
  assert.equal(verdict.safe, true);
  assert.match(verdict.reason, /PROVEN/);
  assert.match(verdict.reason, /jedd-shell \(uid 1001\)/);
  assert.match(verdict.reason, /jeff \(uid 1000\)/);
  assert.match(verdict.reason, /REFUSED by the docker socket/);
  // It really ran things, on both hosts.
  assert.ok(spy.calls.some((c) => c.host === SHELL && c.command.startsWith('id ')));
  assert.ok(spy.calls.some((c) => c.host === ADMIN && c.command.startsWith('id ')));
  assert.ok(spy.calls.some((c) => c.host === SHELL && c.command.includes('docker ps')));
  assert.ok(spy.calls.some((c) => c.host === ADMIN && c.command.includes('docker ps')));
});

test('🔴 THE DEFECT: two DIFFERENT aliases resolving to ONE account is refused', async () => {
  // `HP_SHELL_SSH_HOST=jeff@hp` with `HP_ADMIN_SSH_HOST=hp`. Different strings,
  // same uid. The old string comparison called this a live boundary.
  const spy = healthyBox({ shellId: idOf('1000', 'jeff', 'jeff adm sudo docker') });
  const verdict = await proveShellIdentityIsSafe(
    testConfig({ shellSshHost: 'jeff@hp', adminSshHost: 'hp' }),
    spy.exec,
  );
  assert.equal(verdict.safe, false);
  assert.match(verdict.reason, /THE SAME ACCOUNT/);
  assert.match(verdict.reason, /uid 1000/);
});

test('🔴 a shell identity in the docker group is refused, however it is spelled', async () => {
  const spy = healthyBox({ shellId: idOf('1001', 'jedd-shell', 'jedd-shell docker') });
  const verdict = await proveShellIdentityIsSafe(testConfig({ shellSshHost: SHELL, adminSshHost: ADMIN }), spy.exec);
  assert.equal(verdict.safe, false);
  assert.match(verdict.reason, /in docker/);
});

test('every privileged group is refused, not just docker', async () => {
  for (const group of ['sudo', 'wheel', 'root', 'adm', 'lxd']) {
    const spy = healthyBox({ shellId: idOf('1001', 'jedd-shell', `jedd-shell ${group}`) });
    const verdict = await proveShellIdentityIsSafe(testConfig({ shellSshHost: SHELL, adminSshHost: ADMIN }), spy.exec);
    assert.equal(verdict.safe, false, `${group} must disqualify the shell identity`);
  }
  // CONTROL: an ordinary supplementary group does NOT disqualify it, so the
  // check is about privilege rather than about refusing any group at all.
  const ok = healthyBox({ shellId: idOf('1001', 'jedd-shell', 'jedd-shell users video') });
  assert.equal(
    (await proveShellIdentityIsSafe(testConfig({ shellSshHost: SHELL, adminSshHost: ADMIN }), ok.exec)).safe,
    true,
  );
});

test('🔴 a root shell identity is refused even with no groups and a clean crossing', async () => {
  const spy = healthyBox({ shellId: idOf('0', 'root', 'root') });
  const verdict = await proveShellIdentityIsSafe(testConfig({ shellSshHost: SHELL, adminSshHost: ADMIN }), spy.exec);
  assert.equal(verdict.safe, false);
  assert.match(verdict.reason, /ROOT/);
});

test('🔴 BREACH: a shell identity that CAN reach docker is refused, groups notwithstanding', async () => {
  // No privileged group, but the socket lets it in anyway — an ACL, a sudo rule,
  // something nobody wrote down. This is the signal the structural checks cannot
  // see, and it is why the crossing exists.
  const spy = healthyBox({ shellDocker: () => ({ stdout: 'abc123\n' }) });
  const verdict = await proveShellIdentityIsSafe(testConfig({ shellSshHost: SHELL, adminSshHost: ADMIN }), spy.exec);
  assert.equal(verdict.safe, false);
  assert.match(verdict.reason, /BREACH/);
});

// ── failing closed when it cannot tell ───────────────────────────────────────

test('🔴 an unreachable host is UNPROVEN, and unproven means DISABLED', async () => {
  for (const broken of [SHELL, ADMIN]) {
    const spy = probeSpy((host, command) => {
      if (host === broken) return { exitCode: 255, stderr: 'ssh: connect: no route to host' };
      if (command.startsWith('id ')) return { stdout: idOf('1001', 'jedd-shell', 'jedd-shell') };
      return { stdout: 'abc\n' };
    });
    const verdict = await proveShellIdentityIsSafe(testConfig({ shellSshHost: SHELL, adminSshHost: ADMIN }), spy.exec);
    assert.equal(verdict.safe, false, `an unreachable ${broken} must disable the shell`);
    assert.match(verdict.reason, /UNPROVEN|DISABLED/);
  }
});

test('unparseable id output is UNPROVEN, never assumed fine', async () => {
  const spy = healthyBox({ shellId: 'bash: id: command not found\n' });
  const verdict = await proveShellIdentityIsSafe(testConfig({ shellSshHost: SHELL, adminSshHost: ADMIN }), spy.exec);
  assert.equal(verdict.safe, false);
});

test('🔴 an EMPTY shell host is refused, and is never DIALLED', async () => {
  // ⚠️ The obvious assertion — "safe is false" — passes for the wrong reason:
  // with the guard removed, `ssh ""` falls through to the admin branch of the
  // fixture, the uids match, and the uid check refuses it anyway. The property
  // that actually distinguishes the guard is that an empty host is never
  // contacted at all.
  const spy = healthyBox();
  const verdict = await proveShellIdentityIsSafe(testConfig({ shellSshHost: '', adminSshHost: ADMIN }), spy.exec);
  assert.equal(verdict.safe, false);
  assert.equal(
    spy.calls.some((c) => c.host === ''),
    false,
    `an empty ssh host must not be dialled: ${JSON.stringify(spy.calls)}`,
  );
  assert.match(verdict.reason, /empty/);
});

// ── the crossing's own control ───────────────────────────────────────────────

test('🔴 a docker daemon that is DOWN does not count as the shell being refused', async () => {
  // Without the control, "docker ps failed for the shell user" is equally
  // consistent with "docker is down", which would be a passing check that proved
  // nothing. The structural split still licenses the shell — a precondition that
  // blocks the correct action is a bug, and a dead daemon is exactly when an
  // unprivileged diagnostic shell is most wanted — but the reason must SAY the
  // crossing did not stand.
  const spy = healthyBox({
    shellDocker: () => ({ exitCode: 1, stderr: 'Cannot connect to the Docker daemon. Is the docker daemon running?' }),
    adminDocker: () => ({ exitCode: 1, stderr: 'Cannot connect to the Docker daemon.' }),
  });
  const verdict = await proveShellIdentityIsSafe(testConfig({ shellSshHost: SHELL, adminSshHost: ADMIN }), spy.exec);
  assert.equal(verdict.safe, true, 'the structural split stands on its own');
  assert.match(verdict.reason, /INCONCLUSIVE/);
  assert.doesNotMatch(verdict.reason, /^PROVEN/);
});

test('🔴 a refused shell with a FAILING control is not reported as proven', async () => {
  // The subject was genuinely refused, but the admin could not run docker either,
  // so the refusal is not yet distinguishable from an unavailable daemon.
  const spy = healthyBox({ adminDocker: () => ({ exitCode: 1, stderr: 'Cannot connect to the Docker daemon.' }) });
  const verdict = await proveShellIdentityIsSafe(testConfig({ shellSshHost: SHELL, adminSshHost: ADMIN }), spy.exec);
  assert.equal(verdict.safe, true);
  assert.match(verdict.reason, /CONTROL did not pass/);
  assert.doesNotMatch(verdict.reason, /^PROVEN/);
});

test('the evidence lists what actually ran, so the boot log is checkable', async () => {
  const spy = healthyBox();
  const verdict = await proveShellIdentityIsSafe(testConfig({ shellSshHost: SHELL, adminSshHost: ADMIN }), spy.exec);
  assert.ok(verdict.evidence.some((e) => e.includes('jedd-shell uid=1001')));
  assert.ok(verdict.evidence.some((e) => e.includes('jeff uid=1000')));
  assert.ok(verdict.evidence.some((e) => e.toLowerCase().includes('refused')));
});
