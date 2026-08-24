import type { Config } from '../src/config.js';

/**
 * A complete Config for tests, overridable per case.
 *
 * 🔴 THE SSH HOSTS MUST NEVER NAME A REAL MACHINE.
 *
 * `.invalid` is reserved by RFC 2606 and can never resolve. This is not tidiness:
 * these hosts said `hp` and `hp-readonly` until a test that threaded its exec
 * stub through `ctx.exec` was combined with a tool that had lost that threading
 * — and the tool fell back to the real `execFile`, ssh'd to the real homelab, and
 * **restarted sonarr for real**. The stub was correct; the seam had a hole; and
 * the config decided whether that hole pointed at production or at nothing.
 *
 * A test's blast radius should not depend on every tool remembering to honour a
 * test seam. Point the config at nowhere, and the worst a missed seam can do is
 * fail to resolve.
 */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ownerHandle: '+18015550123',
    shellSshHost: 'shell-host.invalid',
    adminSshHost: 'admin-host.invalid',
    shellIdentityShared: false,
    allowSharedSshIdentity: false,
    llm: { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'test-model' },
    jellyfin: { baseUrl: 'http://jellyfin.test/jellyfin', apiKey: 'test-key' },
    bluebubbles: {
      baseUrl: 'http://bluebubbles.invalid:1234',
      password: 'test-pw',
      expectedIdentity: 'test@invalid',
      host: '127.0.0.1',
      port: 0,
      path: '/webhook',
      publicUrl: 'http://127.0.0.1:0/webhook',
    },
    sonarr: { baseUrl: 'http://sonarr.invalid:8989/sonarr/api/v3', apiKey: 'test-key' },
    radarr: { baseUrl: 'http://radarr.invalid:7878/radarr/api/v3', apiKey: 'test-key' },
    dispatcharr: { baseUrl: 'http://dispatcharr.test:9191' },
    qbittorrent: { baseUrl: 'http://qbittorrent.invalid:8080' },
    readOnly: true,
    ...overrides,
  };
}
