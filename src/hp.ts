import { execFile } from 'node:child_process';

export interface ShellOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Run a command on the homelab box over ssh.
 *
 * `ssh` is invoked with execFile, so the command string is passed as a single
 * argv element and the LOCAL shell never interprets it. Everything runs on hp;
 * there is no code path here that executes anything on this machine.
 *
 * stdout, stderr and the exit code are ALWAYS returned together. A command that
 * failed loudly must never reach the model looking like a command that returned
 * nothing — that is the single most common false-green in this homelab's
 * history (see knowledge/docker-netns-inspect-lies.md).
 */
/** The execFile-shaped call runOnHp makes. Injectable so the error path is testable. */
export type ExecImpl = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
  callback: (error: unknown, stdout: string, stderr: string) => void,
) => void;

export function runOnHp(
  host: string,
  command: string,
  timeoutMs = 30_000,
  exec: ExecImpl = execFile as unknown as ExecImpl,
): Promise<ShellOutcome> {
  return new Promise((resolve) => {
    exec(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, command],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const err = error as (Error & { code?: number; killed?: boolean }) | null;
        resolve({
          // An error with no numeric code still means FAILURE. Defaulting to 0
          // here would turn every ssh transport failure into a clean success
          // with empty output — the exact false-green this module exists to stop.
          exitCode: typeof err?.code === 'number' ? err.code : err ? 1 : 0,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          timedOut: Boolean(err?.killed),
        });
      },
    );
  });
}

/** Truncate long tool output so one `docker logs` cannot eat the context window. */
export function clip(text: string, maxChars = 6000): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, maxChars * 0.6);
  const tail = text.slice(-maxChars * 0.4);
  const dropped = text.length - head.length - tail.length;
  return `${head}\n… [${dropped} characters omitted from the middle] …\n${tail}`;
}

/**
 * Render an outcome for the model. The exit code is stated first and always,
 * and empty streams are labelled as empty rather than omitted.
 */
export function renderOutcome(outcome: ShellOutcome): string {
  const parts = [`exit_code=${outcome.exitCode}${outcome.timedOut ? ' (TIMED OUT)' : ''}`];
  parts.push(`stdout:\n${outcome.stdout.trim() ? clip(outcome.stdout) : '(empty)'}`);
  parts.push(`stderr:\n${outcome.stderr.trim() ? clip(outcome.stderr, 2000) : '(empty)'}`);
  return parts.join('\n\n');
}
