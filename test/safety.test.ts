import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertSafeToRestart, isNeverRestartable, parseSessions } from '../src/safety.js';

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
  const verdict = assertSafeToRestart('dispatcharr', {
    containerIsUp: false,
    playback: unknown,
    readOnly: false,
  });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /UNKNOWN/);
});

test('CARVE-OUT: a DOWN jellyfin may be restarted despite unreadable /Sessions', () => {
  // /Sessions is served BY Jellyfin, so when Jellyfin is the thing that is down,
  // an unreadable /Sessions is a consequence of the outage rather than missing
  // information — a Jellyfin that is not running has no viewers. This is Jeff's
  // documented "completely down, no viewers possible, fix it" carve-out. Note
  // containerIsUp comes from docker ps, independently of the dead endpoint.
  const verdict = assertSafeToRestart('jellyfin', {
    containerIsUp: false,
    playback: parseSessions('connection refused'),
    readOnly: false,
  });
  assert.equal(verdict.allowed, true);
  assert.match(verdict.reason, /completely down/);
});

test('the carve-out is narrow: it does NOT extend to other containers', () => {
  // The failing control for the case above. If the carve-out were written as
  // "down + unknown -> allow" without pinning the container, this would pass and
  // dispatcharr would be restartable on no evidence at all.
  for (const container of ['dispatcharr', 'sonarr', 'radarr']) {
    const verdict = assertSafeToRestart(container, {
      containerIsUp: false,
      playback: parseSessions('connection refused'),
      readOnly: false,
    });
    assert.equal(verdict.allowed, false, `${container} must still refuse on UNKNOWN`);
  }
});

test('a protected container that is UP is never restarted', () => {
  for (const container of ['jellyfin', 'dispatcharr']) {
    const verdict = assertSafeToRestart(container, {
      containerIsUp: true,
      playback: idle,
      readOnly: false,
    });
    assert.equal(verdict.allowed, false, `${container} is up and must not be restarted`);
    assert.match(verdict.reason, /currently UP/);
  }
});

test('🔴 gluetun is NEVER restartable, under any combination of inputs', () => {
  // Previously enforced by an untested startsWith() in one call site: delete that
  // line and nothing went red. It now lives inside the decision function, so it
  // holds for every caller. Exhaustive over the inputs that reach it.
  for (const container of ['gluetun', 'gluetun-torrents']) {
    for (const containerIsUp of [true, false]) {
      for (const playback of [idle, watching, parseSessions('unreadable')]) {
        const verdict = assertSafeToRestart(container, {
          containerIsUp,
          playback,
          readOnly: false,
        });
        assert.equal(
          verdict.allowed,
          false,
          `${container} up=${containerIsUp} must never be restartable`,
        );
        assert.match(verdict.reason, /VPN|never/i);
      }
    }
  }
});

test('isNeverRestartable does not over-match unrelated containers', () => {
  // Failing control for the rule above: if it matched too broadly, the exhaustive
  // test would still pass while ordinary containers became unrestartable.
  assert.equal(isNeverRestartable('gluetun'), true);
  assert.equal(isNeverRestartable('gluetun-torrents'), true);
  assert.equal(isNeverRestartable('sonarr'), false);
  assert.equal(isNeverRestartable('jellyfin'), false);
  assert.equal(isNeverRestartable('glue'), false);
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
