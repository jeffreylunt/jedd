import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertSafeToRestart, parseSessions } from '../src/safety.js';

const idle = parseSessions([
  { UserName: 'jeff', Client: 'Jellyfin Web' },
  { UserName: 'dan', Client: 'Tizen' },
]);
const watching = parseSessions([
  { UserName: 'dan', NowPlayingItem: { Name: 'Dune' }, PlayState: { IsPaused: false } },
]);

test('parseSessions distinguishes idle from playing', () => {
  assert.equal(idle.known, true);
  assert.deepEqual(idle.activeSessions, []);
  assert.equal(watching.known, true);
  assert.equal(watching.activeSessions.length, 1);
  assert.match(watching.activeSessions[0]!, /dan — Dune/);
});

test('a PAUSED stream still counts as someone mid-something', () => {
  const paused = parseSessions([
    { UserName: 'dan', NowPlayingItem: { Name: 'Dune' }, PlayState: { IsPaused: true } },
  ]);
  assert.equal(paused.activeSessions.length, 1);
  assert.match(paused.activeSessions[0]!, /paused/);
});

test('an unparseable /Sessions payload is UNKNOWN, not idle', () => {
  for (const bad of [null, undefined, {}, 'nope', 42, [null], ['string']]) {
    const check = parseSessions(bad);
    assert.equal(check.known, false, `should be UNKNOWN for ${JSON.stringify(bad)}`);
  }
});

test('UNKNOWN playback refuses a restart even when the container is down', () => {
  const unknown = parseSessions('gateway timeout');
  const verdict = assertSafeToRestart('jellyfin', {
    containerIsUp: false,
    playback: unknown,
    readOnly: false,
  });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /UNKNOWN/);
});

test('a protected container that is UP is never restarted', () => {
  for (const container of ['jellyfin', 'dispatcharr', 'gluetun']) {
    const verdict = assertSafeToRestart(container, {
      containerIsUp: true,
      playback: idle,
      readOnly: false,
    });
    assert.equal(verdict.allowed, false, `${container} is up and must not be restarted`);
    assert.match(verdict.reason, /currently UP/);
  }
});

test('a protected container that is DOWN with nobody watching may be restarted', () => {
  const verdict = assertSafeToRestart('jellyfin', {
    containerIsUp: false,
    playback: idle,
    readOnly: false,
  });
  assert.equal(verdict.allowed, true);
});

test('active playback blocks a restart even of a down protected container', () => {
  const verdict = assertSafeToRestart('dispatcharr', {
    containerIsUp: false,
    playback: watching,
    readOnly: false,
  });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /watching/);
});

test('read-only mode refuses every restart, including the otherwise-safe one', () => {
  // The failing control for the case above: identical inputs, readOnly flipped.
  const verdict = assertSafeToRestart('jellyfin', {
    containerIsUp: false,
    playback: idle,
    readOnly: true,
  });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /read-only/);
});

test('an unprotected container still requires known-idle playback', () => {
  assert.equal(
    assertSafeToRestart('sonarr', { containerIsUp: true, playback: idle, readOnly: false }).allowed,
    true,
  );
  assert.equal(
    assertSafeToRestart('sonarr', { containerIsUp: true, playback: watching, readOnly: false })
      .allowed,
    false,
  );
  assert.equal(
    assertSafeToRestart('sonarr', {
      containerIsUp: true,
      playback: parseSessions('boom'),
      readOnly: false,
    }).allowed,
    false,
  );
});
