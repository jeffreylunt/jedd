import 'dotenv/config';

/**
 * All configuration in one place, read once at boot.
 *
 * `ownerHandle` is the ONLY thing that grants administrative capability. It is
 * a boot-time constant, never something a message can change.
 */
export interface Config {
  /** Messaging handle of the single homelab owner. Everyone else is a guest. */
  ownerHandle: string;
  /**
   * 🔴 TWO ssh identities, and the separation IS the security boundary.
   *
   * `shellSshHost` is used by the free-form `hp_shell` tool and must be an
   * UNPRIVILEGED account with NO docker group membership. Then an interpreter
   * smuggled past the string filter — `awk 'BEGIN{system("docker restart …")}'`
   * — fails at the OS layer regardless of what the filter believed.
   *
   * `adminSshHost` is used only by structured tools that genuinely need docker,
   * and those carry the safety preconditions the shell cannot reach.
   *
   * If these are the same account, the boundary does not exist. That case is
   * refused at startup unless explicitly overridden — see `shellIdentityShared`.
   */
  shellSshHost: string;
  adminSshHost: string;
  /** True when the two identities are the same account, i.e. no OS-level boundary. */
  shellIdentityShared: boolean;
  /** Dev-only escape hatch permitting the shared-identity case. Never set in a deploy. */
  allowSharedSshIdentity: boolean;
  llm: {
    provider: 'ollama' | 'anthropic';
    baseUrl: string;
    model: string;
    apiKey?: string;
  };
  jellyfin: {
    /** Base URL *including* the /jellyfin path prefix — the bare host 302s. */
    baseUrl: string;
    apiKey: string;
  };
  dispatcharr: {
    baseUrl: string;
    username?: string;
    password?: string;
  };
  /**
   * Read-only mode: every tool that would mutate the homelab refuses.
   * Defaults to TRUE — a misconfigured deploy is read-only, never write-enabled.
   *
   * ⚠️ This is the AUTHORISATION-independent kill switch. It is not the same axis
   * as owner-vs-guest: the owner is authorised to use write tools, and this flag
   * decides whether write tools do anything at all. Neither satisfies the other.
   */
  readOnly: boolean;
  /**
   * Path to the fetchable runbook. When unset, `read_runbook` is not registered —
   * an absent tool is better than one that always errors.
   */
  runbookPath?: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export function loadConfig(): Config {
  const provider = (process.env.LLM_PROVIDER ?? 'ollama') as 'ollama' | 'anthropic';
  const adminSshHost = process.env.HP_ADMIN_SSH_HOST ?? 'hp';
  // Defaults to the admin host so a missing variable is CONSPICUOUS (it trips the
  // shared-identity refusal) rather than silently pointing somewhere unexpected.
  const shellSshHost = process.env.HP_SHELL_SSH_HOST ?? adminSshHost;
  return {
    ownerHandle: required('OWNER_HANDLE'),
    shellSshHost,
    adminSshHost,
    shellIdentityShared: shellSshHost === adminSshHost,
    allowSharedSshIdentity: process.env.JEDD_ALLOW_SHARED_SSH_IDENTITY === 'true',
    llm: {
      provider,
      baseUrl:
        process.env.LLM_BASE_URL ??
        (provider === 'anthropic' ? 'https://api.anthropic.com' : 'http://localhost:11434'),
      model: process.env.LLM_MODEL ?? 'qwen3.8:27b-mlx',
      apiKey: process.env.LLM_API_KEY,
    },
    jellyfin: {
      baseUrl: process.env.JELLYFIN_URL ?? 'http://localhost:8096/jellyfin',
      apiKey: process.env.JELLYFIN_API_KEY ?? '',
    },
    dispatcharr: {
      baseUrl: process.env.DISPATCHARR_URL ?? 'http://localhost:9191',
      username: process.env.DISPATCHARR_USER,
      password: process.env.DISPATCHARR_PASSWORD,
    },
    // Opt IN to writes, explicitly. Absence of the flag means read-only.
    readOnly: process.env.JEDD_ALLOW_WRITES !== 'true',
    runbookPath: process.env.RUNBOOK_PATH,
  };
}

/**
 * Is the free-form shell safe to offer at all?
 *
 * Returns a reason when it is not. The caller must then NOT register `hp_shell`
 * — an absent tool cannot be argued for, and this is the one place where the
 * string filter is known to be insufficient on its own.
 */
export function assertShellIdentityIsSafe(config: Config): { safe: boolean; reason: string } {
  if (!config.shellIdentityShared) {
    return {
      safe: true,
      reason: `shell runs as "${config.shellSshHost}", docker actions as "${config.adminSshHost}"`,
    };
  }
  if (config.allowSharedSshIdentity) {
    return {
      safe: true,
      reason:
        `⚠️ UNSAFE: hp_shell and docker actions share the ssh identity "${config.adminSshHost}". ` +
        'The command filter is the ONLY thing preventing arbitrary container control, and a filter ' +
        'over command text is known to be defeatable. Permitted only because ' +
        'JEDD_ALLOW_SHARED_SSH_IDENTITY=true. NEVER set this in a deploy.',
    };
  }
  return {
    safe: false,
    reason:
      `hp_shell is DISABLED: HP_SHELL_SSH_HOST is unset or equal to HP_ADMIN_SSH_HOST ` +
      `("${config.adminSshHost}"), so the shell would run with docker privileges. Provision an ` +
      'unprivileged ssh account on hp with no docker group membership and set HP_SHELL_SSH_HOST ' +
      'to it. To run anyway during development, set JEDD_ALLOW_SHARED_SSH_IDENTITY=true.',
  };
}
