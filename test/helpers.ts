import type { Config } from '../src/config.js';

/** A complete Config for tests, overridable per case. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ownerHandle: '+18015550123',
    shellSshHost: 'hp-readonly',
    adminSshHost: 'hp',
    shellIdentityShared: false,
    allowSharedSshIdentity: false,
    llm: { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'test-model' },
    jellyfin: { baseUrl: 'http://jellyfin.test/jellyfin', apiKey: 'test-key' },
    dispatcharr: { baseUrl: 'http://dispatcharr.test:9191' },
    readOnly: true,
    ...overrides,
  };
}
