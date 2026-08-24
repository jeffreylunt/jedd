/**
 * Deny-by-default gate for the generic homelab shell.
 *
 * The point is not to out-argue a clever prompt. It is that the dangerous verbs
 * are simply NOT REACHABLE through this tool, so there is nothing to talk
 * around. Restarting a container is not a shell command Jedd can phrase — it is
 * a separate tool with its own preconditions (see safety.ts).
 *
 * Every pipeline segment is validated independently, because `docker ps | rm -rf`
 * has a perfectly innocent leading token.
 */

/** Leading tokens permitted in read-only mode. Anything absent is refused. */
const READ_COMMANDS = new Set([
  'awk', 'basename', 'cat', 'cut', 'date', 'df', 'dirname', 'dig', 'docker', 'du',
  'echo', 'egrep', 'fgrep', 'file', 'find', 'free', 'grep', 'head', 'hostname',
  'id', 'jq', 'journalctl', 'ls', 'nproc', 'nslookup', 'printf', 'ps', 'readlink',
  'sort', 'ss', 'stat', 'systemctl', 'tail', 'tr', 'uname', 'uniq', 'uptime',
  'wc', 'which', 'curl',
]);

/** `docker` is allowed, but only these subcommands. `exec` and `run` are arbitrary code. */
const DOCKER_SUBCOMMANDS = new Set([
  'ps', 'inspect', 'logs', 'stats', 'top', 'version', 'images', 'port', 'diff', 'info',
]);

const DOCKER_COMPOSE_SUBCOMMANDS = new Set(['ls', 'ps', 'config', 'version']);

/** `systemctl` may only be interrogated, never driven. */
const SYSTEMCTL_SUBCOMMANDS = new Set([
  'status', 'show', 'is-active', 'is-enabled', 'is-failed', 'list-units', 'cat',
]);

/** curl flags that turn a read into a write. */
const CURL_WRITE_FLAGS = [
  '-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '-F', '--form',
  '-T', '--upload-file', '-o', '--output', '--create-dirs',
];

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
    return deny(
      `"${head}" is not on the read-only command allowlist. ` +
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

  if (head === 'curl') {
    for (const token of tokens.slice(1)) {
      const flag = token.split('=')[0]!;
      if (CURL_WRITE_FLAGS.includes(flag)) {
        return deny(`curl ${flag} sends or writes data; this shell is read-only`);
      }
      if (flag === '-X' || flag === '--request') {
        const idx = tokens.indexOf(token);
        const method = (tokens[idx + 1] ?? '').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') {
          return deny(`curl -X ${method || '<none>'} is not a read; this shell is read-only`);
        }
      }
    }
    return allow;
  }

  if (head === 'find') {
    if (tokens.includes('-delete') || tokens.includes('-exec') || tokens.includes('-execdir')) {
      return deny('find -exec/-delete can run arbitrary commands; not permitted');
    }
    return allow;
  }

  if (head === 'awk' || head === 'journalctl' || head === 'ps') {
    // awk can write files via `> "f"` inside its program text; journalctl and ps
    // are read-only by nature. Redirection is already rejected globally below.
    return allow;
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
