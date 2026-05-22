import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts reads env at import time and is a singleton. To exercise different access-control
// configurations we set the relevant env vars, then import config in an isolated child via a
// fresh query-string import so each scenario gets its own module instance.
const baseEnv = {
  SONARR_API_KEY: 'test', RADARR_API_KEY: 'test',
  SONARR_ROOT_FOLDER: '/tv', RADARR_ROOT_FOLDER: '/movies',
  BLUEBUBBLES_PASSWORD: 'test',
};

async function loadConfig(extra: Record<string, string>) {
  for (const [k, v] of Object.entries({ ...baseEnv, ...extra })) process.env[k] = v;
  // Clear the access vars not provided so a prior scenario doesn't leak in.
  for (const k of ['OWNER_PHONE', 'ALLOWED_SENDERS', 'ALLOW_ALL_SENDERS']) {
    if (!(k in extra)) delete process.env[k];
  }
  const mod = await import(`./config.js?case=${Math.random()}`);
  return mod;
}

test('DEFAULT DENY: empty allowlist + flag off = nobody allowed (except owner)', async () => {
  const { isAllowed, isOwner } = await loadConfig({ OWNER_PHONE: '+18015551111' });
  assert.equal(isOwner('+18015551111'), true);
  assert.equal(isAllowed('+18015551111'), true, 'owner is allowed');
  assert.equal(isAllowed('+18015559999'), false, 'an unlisted number is DENIED by default');
  assert.equal(isAllowed('+10000000000'), false, 'any random number is denied');
});

test('allowlisted sender is allowed; non-listed is denied', async () => {
  const { isAllowed } = await loadConfig({
    OWNER_PHONE: '+18015551111',
    ALLOWED_SENDERS: '8015552222,18015553333',
  });
  assert.equal(isAllowed('+18015552222'), true, 'listed (10-digit normalized) allowed');
  assert.equal(isAllowed('+18015553333'), true, 'listed (11-digit) allowed');
  assert.equal(isAllowed('+18015551111'), true, 'owner allowed');
  assert.equal(isAllowed('+18015559999'), false, 'not-listed denied');
});

test('ALLOW_ALL_SENDERS=true lets anyone through', async () => {
  const { isAllowed } = await loadConfig({ OWNER_PHONE: '+18015551111', ALLOW_ALL_SENDERS: 'true' });
  assert.equal(isAllowed('+18015559999'), true);
  assert.equal(isAllowed('+10000000000'), true);
  assert.equal(isAllowed('+18015551111'), true);
});

test('ALLOW_ALL_SENDERS accepts true/1/yes, rejects other values', async () => {
  for (const v of ['true', '1', 'yes', 'TRUE', 'Yes']) {
    const { isAllowed } = await loadConfig({ ALLOW_ALL_SENDERS: v });
    assert.equal(isAllowed('+18015559999'), true, `"${v}" should open the bot`);
  }
  for (const v of ['false', '0', 'no', '']) {
    const { isAllowed } = await loadConfig({ ALLOW_ALL_SENDERS: v });
    assert.equal(isAllowed('+18015559999'), false, `"${v}" should keep default-deny`);
  }
});

test('no OWNER_PHONE + empty allowlist + flag off = deny everyone (incl. empty sender)', async () => {
  const { isAllowed, isOwner } = await loadConfig({});
  assert.equal(isOwner('+18015551111'), false, 'no owner configured');
  assert.equal(isAllowed('+18015551111'), false, 'deny-all when nothing configured');
});
