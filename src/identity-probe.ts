import type { Config } from './config.js';
import { runOnHp, type ExecImpl } from './hp.js';

/**
 * Prove the ssh identity split by RUNNING something, not by reading config.
 *
 * ── THE DEFECT THIS REPLACES ─────────────────────────────────────────────────
 *
 * `assertShellIdentityIsSafe()` decided the security boundary existed by
 * comparing two ssh **aliases for inequality**. That is a check on how two
 * strings are spelled, and the boundary is a fact about two OS accounts:
 *
 *   HP_ADMIN_SSH_HOST=hp   HP_SHELL_SSH_HOST=jeff@hp     ← reads as SPLIT, is ONE account
 *   HP_ADMIN_SSH_HOST=hp   HP_SHELL_SSH_HOST=10.0.0.10 ← same
 *   HP_ADMIN_SSH_HOST=hp   HP_SHELL_SSH_HOST=            ← empty string, also "different"
 *
 * The only real evidence the boundary existed was a crossing run by hand once,
 * and nothing re-ran it. **A boundary nothing re-checks is a boundary you are
 * trusting on faith.**
 *
 * ── WHAT THIS COSTS, AND WHY IT IS SHAPED THIS WAY ───────────────────────────
 *
 * Three ssh round trips at boot, ~1-2 s total. Deliberately NOT an exhaustive
 * re-run of the manual crossing (raw socket, python, curl --unix-socket, sudo,
 * reading /etc/shadow): that is a security AUDIT, it belongs in a test and in
 * the knowledge base, and nobody would tolerate it on every boot. This is the
 * bounded true check — two structural facts and one crossing — chosen because a
 * bounded check that actually runs beats an exhaustive one that does not.
 *
 * ── 🔴 THE TWO CLAIMS ARE SEPARATED ON PURPOSE ───────────────────────────────
 *
 * 1. **STRUCTURAL — required.** Both identities resolve, their uids DIFFER, the
 *    shell identity is not root, and it holds no privileged group. This is what
 *    licenses registering `hp_shell`, and it needs nothing but `id`.
 *
 * 2. **CROSSING — confirming.** `docker ps` as the shell identity must be
 *    REFUSED, and as the admin identity must SUCCEED. The second half is the
 *    inverting control: without it, "docker ps failed for the shell user" is
 *    equally consistent with "the docker daemon is down", which would be a
 *    passing check that proves nothing.
 *
 * They are separated because of a lesson this project already paid for: **a
 * precondition that blocks the correct action is not caution, it is a bug.**
 * When the docker daemon is down, the crossing cannot be run — and that is
 * precisely when an unprivileged diagnostic shell is most useful. So an
 * inconclusive CONTROL does not veto structural evidence that stands on its own.
 *
 * A positive breach signal is different and always refuses: if the shell
 * identity can actually reach docker, nothing else matters.
 */

/** Groups that make an account privileged enough to defeat the boundary. */
const PRIVILEGED_GROUPS = new Set(['docker', 'sudo', 'wheel', 'root', 'adm', 'lxd']);

export interface IdentityVerdict {
  safe: boolean;
  reason: string;
  /** Everything the probe actually observed, for the boot log. */
  evidence: string[];
}

interface Identity {
  known: boolean;
  uid: string;
  user: string;
  groups: string[];
  detail: string;
}

/** Read `id` for one ssh identity. Anything unexpected is UNKNOWN, never "fine". */
async function readIdentity(host: string, exec?: ExecImpl): Promise<Identity> {
  const blank = (detail: string): Identity => ({ known: false, uid: '', user: '', groups: [], detail });
  if (!host.trim()) return blank('the ssh host is empty');
  const out = await runOnHp(host, 'id -u; id -un; id -nG', 15_000, exec);
  if (out.exitCode !== 0) {
    return blank(`ssh to "${host}" failed (exit=${out.exitCode}, ${out.stderr.trim() || 'no stderr'})`);
  }
  const [uid, user, groups] = out.stdout.trim().split('\n');
  if (!uid || !/^\d+$/.test(uid.trim()) || !user?.trim()) {
    return blank(`"${host}" did not return a usable id (got "${out.stdout.trim().slice(0, 80)}")`);
  }
  return {
    known: true,
    uid: uid.trim(),
    user: user.trim(),
    groups: (groups ?? '').trim().split(/\s+/).filter(Boolean),
    detail: `${user.trim()} uid=${uid.trim()} groups=${(groups ?? '').trim() || '(none)'}`,
  };
}

/** Can this identity reach the docker socket? Three-state; UNKNOWN is not "no". */
async function canReachDocker(
  host: string,
  exec?: ExecImpl,
): Promise<{ known: boolean; reachable: boolean; detail: string }> {
  const out = await runOnHp(host, 'docker ps --quiet', 15_000, exec);
  if (out.exitCode === 0) {
    return { known: true, reachable: true, detail: `"${host}" ran docker ps successfully` };
  }
  const stderr = out.stderr.toLowerCase();
  // Distinguish "the kernel said no" from "docker is broken". Only the first is
  // evidence about the BOUNDARY; the second is evidence about the daemon.
  if (stderr.includes('permission denied') || stderr.includes('connect: permission denied')) {
    return { known: true, reachable: false, detail: `"${host}" was REFUSED by the docker socket` };
  }
  return {
    known: false,
    reachable: false,
    detail: `"${host}" could not run docker ps, but not because of permissions (exit=${out.exitCode}, ${
      out.stderr.trim().slice(0, 120) || 'no stderr'
    })`,
  };
}

/**
 * The boot check. Returns a verdict; the caller must not register `hp_shell`
 * unless `safe` is true.
 */
export async function proveShellIdentityIsSafe(
  config: Config,
  exec?: ExecImpl,
): Promise<IdentityVerdict> {
  const evidence: string[] = [];
  const refuse = (reason: string): IdentityVerdict => ({ safe: false, reason, evidence });

  // ── 1. STRUCTURAL ─────────────────────────────────────────────────────────
  const [shell, admin] = await Promise.all([
    readIdentity(config.shellSshHost, exec),
    readIdentity(config.adminSshHost, exec),
  ]);
  evidence.push(`shell "${config.shellSshHost}": ${shell.detail}`);
  evidence.push(`admin "${config.adminSshHost}": ${admin.detail}`);

  if (!shell.known || !admin.known) {
    // Fail CLOSED. An unprovable boundary is not a boundary.
    return refuse(
      `Could not establish who the ssh identities are, so the split is UNPROVEN: ` +
        `${!shell.known ? shell.detail : admin.detail}. hp_shell is DISABLED.`,
    );
  }

  if (shell.uid === admin.uid) {
    return refuse(
      `🔴 THE TWO SSH IDENTITIES ARE THE SAME ACCOUNT. "${config.shellSshHost}" and ` +
        `"${config.adminSshHost}" are spelled differently but both resolve to ${shell.user} ` +
        `(uid ${shell.uid}). There is no boundary. hp_shell is DISABLED.`,
    );
  }

  if (shell.uid === '0') {
    return refuse(`🔴 The shell identity "${config.shellSshHost}" is ROOT. hp_shell is DISABLED.`);
  }

  const privileged = shell.groups.filter((g) => PRIVILEGED_GROUPS.has(g));
  if (privileged.length > 0) {
    return refuse(
      `🔴 The shell identity ${shell.user} is in ${privileged.join(', ')}. Membership of any of these ` +
        'is root-equivalent or close to it, so the shell would not be unprivileged. hp_shell is DISABLED.',
    );
  }

  // ── 2. CROSSING ───────────────────────────────────────────────────────────
  const subject = await canReachDocker(config.shellSshHost, exec);
  evidence.push(`crossing: ${subject.detail}`);

  if (subject.known && subject.reachable) {
    // The one signal that overrides everything, including the dev override.
    return refuse(
      `🔴 BREACH: the shell identity ${shell.user} CAN reach the docker socket, despite holding no ` +
        'privileged group. Something else is granting it access (a socket ACL, a sudo rule, an ' +
        'unexpected supplementary group). hp_shell is DISABLED.',
    );
  }

  if (!subject.known) {
    // Could not run the crossing at all. The structural evidence stands on its
    // own, so this does not veto — but it is reported, not glossed.
    return {
      safe: true,
      reason:
        `shell runs as ${shell.user} (uid ${shell.uid}), docker actions as ${admin.user} ` +
        `(uid ${admin.uid}); no privileged groups. ⚠️ The docker crossing was INCONCLUSIVE ` +
        `(${subject.detail}) — the structural split is proven, the refusal is not.`,
      evidence,
    };
  }

  // The subject was refused. Now the control: the same command must SUCCEED as
  // admin, or "refused" is equally consistent with a dead docker daemon.
  const control = await canReachDocker(config.adminSshHost, exec);
  evidence.push(`control: ${control.detail}`);

  if (!control.known || !control.reachable) {
    return {
      safe: true,
      reason:
        `shell runs as ${shell.user} (uid ${shell.uid}), docker actions as ${admin.user} ` +
        `(uid ${admin.uid}); no privileged groups; the shell was refused by the docker socket. ` +
        `⚠️ But the CONTROL did not pass (${control.detail}), so that refusal is not yet ` +
        'distinguishable from docker being unavailable. The structural split is what licenses this.',
      evidence,
    };
  }

  return {
    safe: true,
    reason:
      `PROVEN: shell runs as ${shell.user} (uid ${shell.uid}) and was REFUSED by the docker socket; ` +
      `admin runs as ${admin.user} (uid ${admin.uid}) and ran docker ps successfully. Different ` +
      'accounts, no privileged groups, and the refusal is real rather than a dead daemon.',
    evidence,
  };
}
