/**
 * Defence-in-depth filter for the generic homelab shell.
 *
 * 🔴 READ THIS BEFORE TRUSTING IT: **THIS IS NOT THE SECURITY BOUNDARY.**
 *
 * A security review found `awk 'BEGIN{system("docker restart gluetun")}'` sailed
 * straight through an earlier version of this file. The lesson was not "add awk
 * to a denylist" — it was that **this whole approach inspects the TEXT of a
 * command and tries to predict its EFFECT**, which is exactly the prose-policing
 * that V2 exists to escape. Every allowlisted binary is a potential interpreter:
 * `awk` has `system()`, `sort` has `-o`, `find` has `-fprintf`, `journalctl` has
 * `--vacuum-time`. Enumerating them is the same losing game as enumerating
 * banned phrases, and an incomplete enumeration reads as a green light.
 *
 * **The actual boundary is the OS**: the free-form shell connects to hp as an
 * UNPRIVILEGED ssh identity with no docker group membership, so
 * `awk 'BEGIN{system("docker restart jellyfin")}'` fails at the kernel no matter
 * what this file believes. Structured tools that genuinely need docker use a
 * separate privileged identity and carry the safety preconditions. See
 * `src/config.ts` and `assertShellIdentityIsSafe`.
 *
 * This file remains as a second layer: it catches mistakes early and gives the
 * model a useful error instead of a permission-denied. **Never let it be the only
 * thing standing between a string and a side effect.**
 */

/** Leading tokens permitted. Anything absent is refused. */
const READ_COMMANDS = new Set([
  'basename', 'cat', 'cut', 'df', 'dirname', 'dig', 'docker', 'du',
  'echo', 'egrep', 'fgrep', 'file', 'find', 'free', 'grep', 'head', 'hostname',
  'id', 'jq', 'journalctl', 'ls', 'nproc', 'nslookup', 'printf', 'ps', 'readlink',
  'sort', 'ss', 'stat', 'systemctl', 'tail', 'tr', 'uname', 'uniq', 'uptime',
  'wc', 'which', 'curl',
]);

/**
 * Commands removed after the review, with the reason, so nobody helpfully adds
 * them back:
 *   awk  — `system("…")` and `print | "cmd"` execute arbitrary commands, and the
 *          global quote-stripping means the program body is never even scanned.
 *   date — `-s` sets the system clock.
 *   sed  — `-i` edits files in place, `w` writes them, `e` executes.
 */
const REMOVED_FOR_CAUSE: Record<string, string> = {
  awk: 'awk can execute arbitrary commands via system() and `print | "cmd"`',
  date: 'date -s sets the system clock',
  sed: 'sed can write files (-i, w) and execute commands (e)',
  perl: 'perl is a general-purpose interpreter',
  python3: 'python3 is a general-purpose interpreter',
  python: 'python is a general-purpose interpreter',
  xargs: 'xargs runs an arbitrary command per input line',
  env: 'env runs an arbitrary command',
  nice: 'nice runs an arbitrary command',
  timeout: 'timeout runs an arbitrary command',
  watch: 'watch runs an arbitrary command repeatedly',
};

/**
 * Per-command flags that turn a read into a write. Checked against BOTH
 * space-separated flags and short-flag clusters (`-so out` is `-s -o out`),
 * because the original curl check only looked at whole tokens and `-sd` sailed
 * through it.
 */
const FLAG_POLICY: Record<string, { long: string[]; short: string[]; reason: string }> = {
  curl: {
    long: [
      '--data', '--data-raw', '--data-binary', '--data-urlencode', '--form', '--form-string',
      '--upload-file', '--output', '--create-dirs', '--dump-header', '--trace', '--trace-ascii',
      '--cookie-jar', '--remote-name', '--remote-header-name',
    ],
    short: ['d', 'F', 'T', 'o', 'O', 'D', 'c', 'J'],
    reason: 'sends or writes data',
  },
  sort: { long: ['--output'], short: ['o'], reason: 'writes its output to a file' },
  journalctl: {
    long: ['--vacuum-time', '--vacuum-size', '--vacuum-files', '--rotate', '--flush', '--sync'],
    short: [],
    reason: 'deletes or rotates the journal',
  },
  find: {
    long: ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprintf', '-fprint', '-fprint0', '-fls'],
    short: [],
    reason: 'executes commands or writes files',
  },
  tee: { long: [], short: [], reason: 'tee always writes' },
  ss: { long: ['--kill'], short: ['K'], reason: 'kills sockets' },
  systemctl: { long: [], short: [], reason: '' },
  docker: { long: [], short: [], reason: '' },
};

/** `docker` is allowed, but only these subcommands. `exec` and `run` are arbitrary code. */
const DOCKER_SUBCOMMANDS = new Set([
  'ps', 'inspect', 'logs', 'stats', 'top', 'version', 'images', 'port', 'diff', 'info',
]);

const DOCKER_COMPOSE_SUBCOMMANDS = new Set(['ls', 'ps', 'config', 'version']);

/** `systemctl` may only be interrogated, never driven. */
const SYSTEMCTL_SUBCOMMANDS = new Set([
  'status', 'show', 'is-active', 'is-enabled', 'is-failed', 'list-units', 'cat',
]);

/**
 * Short flags that CONSUME the rest of their token (or the next token) as a
 * value. Scanning must stop at these — the characters after them are an
 * argument, not more flags.
 */
const VALUE_TAKING: Record<string, string> = {
  curl: 'XdFTODcHuAebmwKEUY',
  sort: 'okStT',
  journalctl: 'unptS',
  find: '',
  ss: 'fF',
};

export interface GateVerdict {
  allowed: boolean;
  reason: string;
}

const allow: GateVerdict = { allowed: true, reason: 'ok' };
const deny = (reason: string): GateVerdict => ({ allowed: false, reason });

/**
 * Split a command line into pipeline/list segments, respecting quotes so that
 * `grep "a|b" f` is one segment rather than two.
 *
 * Returns null when quoting is unbalanced — which is itself a refusal, since we
 * cannot then reason about what will run.
 */
export function splitSegments(command: string): string[] | null {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    const prev = i > 0 ? command[i - 1] : '';

    if (quote) {
      if (ch === quote && prev !== '\\') quote = null;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    // `&` inside a file-descriptor duplication (`2>&1`) is part of the token,
    // not a separator. Without this, `cmd 2>&1 | grep x` splits into a bogus
    // segment starting `1`, and a legitimate read is refused.
    if (ch === '&' && prev === '>') {
      current += ch;
      continue;
    }
    if (ch === '|' || ch === ';' || ch === '&' || ch === '\n') {
      // Consume a doubled operator (&& / ||) as one separator.
      if ((ch === '|' || ch === '&') && command[i + 1] === ch) i++;
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (quote) return null;
  segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Quote-aware word split of a single segment. */
export function tokenise(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    const prev = i > 0 ? segment[i - 1] : '';
    if (quote) {
      if (ch === quote && prev !== '\\') {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function checkSegment(segment: string): GateVerdict {
  const tokens = tokenise(segment);
  const head = tokens[0];
  if (!head) return deny('empty command segment');

  // An `FOO=bar cmd` prefix would let an env assignment masquerade as the verb.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
    return deny(`environment-variable prefixes are not allowed ("${head}")`);
  }
  if (head.includes('/')) {
    return deny(`commands must be bare names, not paths ("${head}")`);
  }
  if (!READ_COMMANDS.has(head)) {
    const cause = REMOVED_FOR_CAUSE[head];
    return deny(
      cause
        ? `"${head}" is not permitted: ${cause}. Use a plain read command instead.`
        : `"${head}" is not on the read-only command allowlist. ` +
            'This shell can read the homelab but cannot change it.',
    );
  }

  if (head === 'docker') {
    const sub = tokens[1];
    if (!sub) return deny('docker needs a subcommand');
    if (sub === 'compose') {
      const composeSub = tokens[2];
      if (!composeSub || !DOCKER_COMPOSE_SUBCOMMANDS.has(composeSub)) {
        return deny(
          `docker compose ${composeSub ?? '<none>'} is not permitted (read-only: ${[...DOCKER_COMPOSE_SUBCOMMANDS].join(', ')})`,
        );
      }
      return allow;
    }
    if (!DOCKER_SUBCOMMANDS.has(sub)) {
      return deny(
        `docker ${sub} is not permitted. Read-only docker subcommands are: ${[...DOCKER_SUBCOMMANDS].join(', ')}. ` +
          'Restarting a container is a separate tool with safety preconditions.',
      );
    }
    return allow;
  }

  if (head === 'systemctl') {
    const sub = tokens[1];
    if (!sub || !SYSTEMCTL_SUBCOMMANDS.has(sub)) {
      return deny(
        `systemctl ${sub ?? '<none>'} is not permitted (read-only: ${[...SYSTEMCTL_SUBCOMMANDS].join(', ')})`,
      );
    }
    return allow;
  }

  const flagVerdict = checkFlags(head, tokens);
  if (!flagVerdict.allowed) return flagVerdict;

  return allow;
}

/**
 * Check a segment's flags against FLAG_POLICY.
 *
 * Short flags are checked CHARACTER BY CHARACTER inside a cluster: `curl -so f`
 * is `-s -o f` and must be refused exactly as `curl -o f` is. The original
 * version compared whole tokens, so every clustered form was invisible to it —
 * and the test only ever exercised the space-separated shape, so it asserted the
 * bug's absence in the one form its author imagined.
 */
function checkFlags(head: string, tokens: string[]): GateVerdict {
  const policy = FLAG_POLICY[head];
  if (!policy || (!policy.long.length && !policy.short.length)) return allow;
  const valueTaking = VALUE_TAKING[head] ?? '';

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    const bare = token.split('=')[0]!;
    if (policy.long.includes(bare)) {
      return deny(`${head} ${bare} ${policy.reason}; this shell is read-only`);
    }
    if (head === 'curl' && (bare === '--request' || bare === '-X')) {
      const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : (tokens[i + 1] ?? '');
      const method = value.toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        return deny(`curl -X ${method || '<none>'} is not a read; this shell is read-only`);
      }
      continue;
    }
    if (!token.startsWith('-') || token.startsWith('--') || token.length < 2) continue;

    const cluster = token.slice(1);
    for (let j = 0; j < cluster.length; j++) {
      const ch = cluster[j]!;
      if (policy.short.includes(ch)) {
        return deny(`${head} -${ch} (in "${token}") ${policy.reason}; this shell is read-only`);
      }
      if (valueTaking.includes(ch)) {
        // 🔴 STOP SCANNING. Everything after a value-taking flag is that flag's
        // VALUE, not more flags. Without this, `curl -XGET` was refused because
        // the `T` of "GET" looked like curl's upload-file flag — a false refusal
        // that would have pushed the model into pointless retries.
        const inline = cluster.slice(j + 1);
        const value = inline || tokens[i + 1] || '';
        if (head === 'curl' && ch === 'X') {
          const method = value.toUpperCase();
          if (method !== 'GET' && method !== 'HEAD') {
            return deny(`curl -X ${method || '<none>'} is not a read; this shell is read-only`);
          }
        }
        break;
      }
    }
  }
  return allow;
}

/**
 * Adjudicate a whole command line.
 */
export function commandGate(command: string): GateVerdict {
  const trimmed = command.trim();
  if (!trimmed) return deny('empty command');
  if (trimmed.length > 4000) return deny('command is implausibly long; refused');

  // Command substitution would smuggle an unvalidated command past the gate.
  if (trimmed.includes('$(') || trimmed.includes('`') || trimmed.includes('<(')) {
    return deny('command substitution ($( ), backticks, <( )) is not allowed');
  }
  // Redirection to a FILE writes to the filesystem and is refused.
  //
  // File-descriptor duplication (`2>&1`) is not a write — it merges stderr into
  // stdout so a pipeline can see it, which is the documented idiom for stopping a
  // failed command from reading as an empty result. It is allowed, so it is
  // stripped before this check rather than caught by it.
  const withoutQuotes = trimmed.replace(/"[^"]*"|'[^']*'/g, '');
  const withoutFdDup = withoutQuotes.replace(/\d*>&\d+/g, '');
  if (withoutFdDup.includes('>')) {
    return deny(
      'output redirection to a file (>, >>) is not allowed on a read-only shell. ' +
        '`2>&1` is permitted; stderr and the exit code are returned to you separately anyway.',
    );
  }

  const segments = splitSegments(trimmed);
  if (segments === null) return deny('unbalanced quotes; refusing rather than guessing what would run');
  if (segments.length === 0) return deny('empty command');

  for (const segment of segments) {
    const verdict = checkSegment(segment);
    if (!verdict.allowed) return verdict;
  }
  return allow;
}
