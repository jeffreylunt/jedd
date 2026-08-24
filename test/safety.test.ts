import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertSafeToRestart,
  blastRadiusFor,
  isNeverRestartable,
  parseContainerState,
  parseSessions,
  tunnelVerdict,
} from '../src/safety.js';

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

test('the carve-out is narrow: it does NOT extend to other live-TV-tier containers', () => {
  // The failing control for the case above. If the carve-out were written as
  // "down + unknown -> allow" without pinning the container, this would pass and
  // dispatcharr would be restartable on no evidence at all.
  //
  // Only LIVE-TV-tier containers belong here: sonarr/radarr are SAFE tier and are
  // allowed for a different and correct reason, so including them would make this
  // test fail for a reason that has nothing to do with the carve-out.
  for (const container of ['dispatcharr', 'some-unclassified-service']) {
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

test('SAFE tier restarts are allowed even mid-stream', () => {
  // Deliberate loosening from the flat-protected-set version. These containers
  // serve no video, and the stale-netns fix is documented safe mid-match — so
  // gating on idle would block the correct action exactly when it is needed.
  for (const container of ['sonarr', 'radarr', 'prowlarr', 'flaresolverr', 'qbittorrent']) {
    for (const playback of [idle, watching, parseSessions('boom')]) {
      const verdict = assertSafeToRestart(container, {
        containerIsUp: true,
        playback,
        readOnly: false,
      });
      assert.equal(verdict.allowed, true, `${container} should be restartable in the SAFE tier`);
    }
  }
});

test('🔴 an UNCLASSIFIED container defaults to the MOST RESTRICTIVE tier', () => {
  // The flat "protected" set had this exactly backwards: anything not on the
  // list was treated as unprotected, so a container nobody had considered got
  // the permissive path *because* nobody had considered it.
  for (const container of ['some-new-service', 'audiobookshelf', 'jfa-go', 'inadyn']) {
    assert.equal(blastRadiusFor(container), 'live-tv', `${container} must default to live-tv`);
    // Up + idle would have been ALLOWED under the old flat rule.
    const verdict = assertSafeToRestart(container, {
      containerIsUp: true,
      playback: idle,
      readOnly: false,
    });
    assert.equal(verdict.allowed, false, `${container} must not be restartable while up`);
  }
});

test('blastRadiusFor classifies the known tiers', () => {
  for (const c of ['sonarr', 'radarr', 'prowlarr', 'flaresolverr', 'janitorr', 'qbittorrent']) {
    assert.equal(blastRadiusFor(c), 'safe', `${c} is SAFE tier`);
  }
  for (const c of ['jellyfin', 'dispatcharr', 'gluetun', 'gluetun-torrents']) {
    assert.equal(blastRadiusFor(c), 'live-tv', `${c} is LIVE-TV tier`);
  }
});

test('the live-TV tier still requires completely-down and no viewer', () => {
  // Failing control for the SAFE-tier loosening: if the loosening had leaked
  // into the live-TV path, these would pass.
  assert.equal(
    assertSafeToRestart('dispatcharr', { containerIsUp: true, playback: idle, readOnly: false })
      .allowed,
    false,
  );
  assert.equal(
    assertSafeToRestart('dispatcharr', { containerIsUp: false, playback: watching, readOnly: false })
      .allowed,
    false,
  );
});

test('parseContainerState reads docker ps output correctly', () => {
  assert.deepEqual(parseContainerState('jellyfin|Up 5 days (healthy)', 0), {
    known: true,
    isUp: true,
    status: 'Up 5 days (healthy)',
  });
  assert.deepEqual(parseContainerState('jellyfin|Exited (0) 2 minutes ago', 0), {
    known: true,
    isUp: false,
    status: 'Exited (0) 2 minutes ago',
  });
  for (const status of ['Created', 'Restarting (1) 3 seconds ago', 'Dead', 'Paused']) {
    assert.equal(parseContainerState(`x|${status}`, 0).isUp, false, `${status} is not up`);
  }
});

test('🔴 an unreadable docker ps is UNKNOWN, never "down"', () => {
  // Collapsing these is how "I could not tell" becomes "it is down" — and "it is
  // down" is precisely the input that unlocks a restart.
  for (const [stdout, exit] of [
    ['', 0],
    ['   ', 0],
    ['anything', 1],
    ['jellyfin', 0],
    ['jellyfin|', 0],
  ] as [string, number][]) {
    const state = parseContainerState(stdout, exit);
    assert.equal(state.known, false, `stdout=${JSON.stringify(stdout)} exit=${exit} must be UNKNOWN`);
    assert.equal(state.isUp, false);
  }
});

test('a failed /Sessions fetch must map to UNKNOWN, not to idle', () => {
  // This mirrors what restart_container does when jellyfinGet fails. If that
  // mapping ever became `{known: true, activeSessions: []}` the viewer gate would
  // silently pass on every Jellyfin outage.
  const onFetchFailure = { known: false, activeSessions: [], detail: '/Sessions unreadable' };
  const verdict = assertSafeToRestart('dispatcharr', {
    containerIsUp: false,
    playback: onFetchFailure,
    readOnly: false,
  });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /UNKNOWN/);
});

test('🔴 tunnelVerdict: matching exit IPs means LEAKING', () => {
  // The container is reaching the internet on the home connection. Jeff's rule is
  // that VPN protection is non-negotiable, so this is the one failure that matters.
  const v = tunnelVerdict({ exitCode: 0, ip: '136.38.228.79' }, { exitCode: 0, ip: '136.38.228.79' });
  assert.equal(v.verdict, 'leaking');
});

test('tunnelVerdict: differing exit IPs means PROTECTED', () => {
  // Real values measured on hp 2026-08-24: sonarr exits via the SLC VPN endpoint,
  // the host via the home WAN.
  const v = tunnelVerdict({ exitCode: 0, ip: '194.62.107.209\n' }, { exitCode: 0, ip: '136.38.228.79\n' });
  assert.equal(v.verdict, 'protected');
});

test('🔴 tunnelVerdict: an unreadable probe is UNKNOWN, never protected', () => {
  const cases: [{ exitCode: number; ip: string }, { exitCode: number; ip: string }][] = [
    [{ exitCode: 1, ip: '' }, { exitCode: 0, ip: '136.38.228.79' }],
    [{ exitCode: 0, ip: '' }, { exitCode: 0, ip: '136.38.228.79' }],
    [{ exitCode: 0, ip: '194.62.107.209' }, { exitCode: 1, ip: '' }],
    [{ exitCode: 0, ip: '194.62.107.209' }, { exitCode: 0, ip: '' }],
    // bare `ifconfig.me` returns HTML; it must not be mistaken for an address
    [{ exitCode: 0, ip: '<!DOCTYPE html><html>' }, { exitCode: 0, ip: '136.38.228.79' }],
  ];
  for (const [container, host] of cases) {
    const v = tunnelVerdict(container, host);
    assert.equal(v.verdict, 'unknown', `${JSON.stringify([container, host])} must be UNKNOWN`);
    assert.notEqual(v.verdict, 'protected');
  }
});

test('tunnelVerdict pins no provider prefix', () => {
  // Pinning `191.96.` false-alarmed when gluetun moved to the SLC exit. Any two
  // different addresses must read as protected, whatever the provider.
  for (const ip of ['191.96.106.220', '194.62.107.209', '5.6.7.8']) {
    assert.equal(
      tunnelVerdict({ exitCode: 0, ip }, { exitCode: 0, ip: '136.38.228.79' }).verdict,
      'protected',
      `${ip} should read as protected`,
    );
  }
});
