import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SONARR_API_KEY ??= 'test';
process.env.RADARR_API_KEY ??= 'test';
process.env.SONARR_ROOT_FOLDER ??= '/tv';
process.env.RADARR_ROOT_FOLDER ??= '/movies';
process.env.BLUEBUBBLES_PASSWORD ??= 'test';

const { shouldExpireJob } = await import('./scheduler.js');

const H = 60 * 60 * 1000;

// --- shouldExpireJob: stuck-import jobs must NOT expire early, but a hard 72h cap still applies ---

test('normal job expires after 24h', () => {
  assert.equal(shouldExpireJob(25 * H, 3, false), true);
});

test('normal job expires after 15 checks', () => {
  assert.equal(shouldExpireJob(2 * H, 15, false), true);
});

test('normal job keeps going before 24h / 15 checks', () => {
  assert.equal(shouldExpireJob(2 * H, 5, false), false);
});

test('STUCK-IMPORT job does NOT expire at the normal 24h boundary', () => {
  assert.equal(shouldExpireJob(30 * H, 20, true), false);
});

test('STUCK-IMPORT job does NOT expire on the 15-check rule', () => {
  assert.equal(shouldExpireJob(5 * H, 50, true), false);
});

test('STUCK-IMPORT job DOES expire at the hard 72h cap', () => {
  assert.equal(shouldExpireJob(73 * H, 100, true), true);
});

test('hard 72h cap applies to normal jobs too', () => {
  assert.equal(shouldExpireJob(73 * H, 1, false), true);
});
