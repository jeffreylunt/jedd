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
  /** ssh destination for the homelab box. Every shell command runs HERE, never locally. */
  hpSshHost: string;
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
   */
  readOnly: boolean;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export function loadConfig(): Config {
  const provider = (process.env.LLM_PROVIDER ?? 'ollama') as 'ollama' | 'anthropic';
  return {
    ownerHandle: required('OWNER_HANDLE'),
    hpSshHost: process.env.HP_SSH_HOST ?? 'hp',
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
  };
}
