import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SONARR_API_KEY ??= 'test';
process.env.RADARR_API_KEY ??= 'test';
process.env.SONARR_ROOT_FOLDER ??= '/tv';
process.env.RADARR_ROOT_FOLDER ??= '/movies';
process.env.BLUEBUBBLES_PASSWORD ??= 'test';

const { decideStatusUpdate } = await import('./local-status.js');
import type { DownloadJob } from './config.js';
import type { StatusObservation } from './local-status.js';

function job(overrides: Partial<DownloadJob> = {}): DownloadJob {
  return {
    id: 'test', type: 'movie', title: 'Oppenheimer', arrId: 360,
    requestedBy: '+15551234567', requestedAt: new Date().toISOString(),
    qualityProfileId: 6, status: 'downloading',
    nextCheckAt: new Date().toISOString(), checkCount: 1,
    ...overrides,
  };
}

function obs(overrides: Partial<StatusObservation> = {}): StatusObservation {
  return {
    hasFile: false, fullyDownloaded: false, queueActive: false,
    progressPct: null, monitored: true, importStuck: false,
    ...overrides,
  };
}

test('DONE when the file is fully downloaded', () => {
  const d = decideStatusUpdate(job(), obs({ fullyDownloaded: true, hasFile: true }), true);
  assert.equal(d.action, 'done');
  assert.match(d.message!, /ready to watch/);
});

test('DONE for a TV job uses episodes-ready wording', () => {
  const d = decideStatusUpdate(job({ type: 'tv', title: 'Mickey and the Roadster Racers' }), obs({ hasFile: true, fullyDownloaded: true }), true);
  assert.equal(d.action, 'done');
  assert.match(d.message!, /episodes ready/);
});

test('PROGRESS on first measurable progress (no prior report)', () => {
  const d = decideStatusUpdate(job(), obs({ queueActive: true, progressPct: 40 }), true);
  assert.equal(d.action, 'progress');
  assert.match(d.message!, /about 40% done/);
  assert.equal(d.newProgress, 40);
});

test('SKIP when progress moved less than the report step', () => {
  const d = decideStatusUpdate(job({ lastProgress: 40 }), obs({ queueActive: true, progressPct: 50 }), true);
  assert.equal(d.action, 'skip');
  assert.equal(d.newProgress, 50); // still persists the latest figure
});

test('PROGRESS again once it moves past the report step', () => {
  const d = decideStatusUpdate(job({ lastProgress: 40 }), obs({ queueActive: true, progressPct: 70 }), true);
  assert.equal(d.action, 'progress');
  assert.match(d.message!, /about 70% done/);
});

test('RESEARCH on silent search failure (empty queue, monitored, research allowed)', () => {
  const d = decideStatusUpdate(job(), obs({ queueActive: false, monitored: true }), true);
  assert.equal(d.action, 'research');
  assert.match(d.message!, /re-running it/);
});

test('SKIP when empty queue but research already attempted (not first check)', () => {
  const d = decideStatusUpdate(job(), obs({ queueActive: false, monitored: true }), false);
  assert.equal(d.action, 'skip');
  assert.equal(d.message, undefined);
});

test('SKIP when queued but no measurable progress and history exists', () => {
  const d = decideStatusUpdate(job(), obs({ queueActive: true, progressPct: null }), true);
  assert.equal(d.action, 'skip');
});

test('completion takes precedence over a stale low progress reading', () => {
  const d = decideStatusUpdate(job({ lastProgress: 30 }), obs({ hasFile: true, fullyDownloaded: true, queueActive: true, progressPct: 95 }), true);
  assert.equal(d.action, 'done');
});

// --- Stuck-at-import (improvement (a), 2026-05-22): downloaded but Radarr can't import ---

test('STUCK-IMPORT: notify once on entering the state (downloaded, not imported)', () => {
  const d = decideStatusUpdate(job(), obs({ queueActive: true, importStuck: true, progressPct: null }), false);
  assert.equal(d.action, 'import_stuck');
  assert.match(d.message!, /trouble importing|having trouble|keeping an eye/i);
  assert.equal(d.notifiedStuckImport, true);
});

test('STUCK-IMPORT: SKIP silently on subsequent checks (no spam) once already notified', () => {
  const d = decideStatusUpdate(job({ notifiedStuckImport: true }), obs({ queueActive: true, importStuck: true, progressPct: null }), false);
  assert.equal(d.action, 'skip');
  assert.equal(d.message, undefined);
  // stays flagged so it never re-notifies
  assert.equal(d.notifiedStuckImport, true);
});

test('STUCK-IMPORT then DONE: once the file imports, report ready (clears stuck state)', () => {
  const d = decideStatusUpdate(job({ notifiedStuckImport: true }), obs({ hasFile: true, fullyDownloaded: true }), true);
  assert.equal(d.action, 'done');
  assert.match(d.message!, /ready to watch/);
});

test('STUCK-IMPORT takes precedence over the silent-search-failure research branch', () => {
  // importStuck implies queueActive, so research (empty-queue) must not fire.
  const d = decideStatusUpdate(job(), obs({ queueActive: true, importStuck: true }), true);
  assert.equal(d.action, 'import_stuck');
});

test('actively downloading (has progress) is NOT treated as stuck-import', () => {
  const d = decideStatusUpdate(job(), obs({ queueActive: true, importStuck: false, progressPct: 55 }), true);
  assert.equal(d.action, 'progress');
});
