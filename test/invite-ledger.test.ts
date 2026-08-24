import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEDUPE_MS, InviteLedger, QUOTA_MAX, QUOTA_WINDOW_MS } from '../src/invite-ledger.js';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'jedd-inv-')), 'l.jsonl');
const JEFF = '+15555550100';
const GUEST = '+13854346068';
const now = new Date('2026-08-24T20:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

const rec = (o: Partial<Parameters<InviteLedger['record']>[0]> = {}) => ({
  at: now.toISOString(), by: GUEST, recipient: '+15550001', label: 'l', outcome: 'confirmed' as const, ...o,
});

// ── 🔴 do not charge a user for our failure ─────────────────────────────────

test('🔴 only CONFIRMED invites consume quota', async () => {
  const l = new InviteLedger(tmp());
  l.record(rec({ outcome: 'confirmed' }));
  l.record(rec({ outcome: 'failed' }));
  l.record(rec({ outcome: 'revoked' }));
  l.record(rec({ outcome: 'orphaned' }));
  assert.equal(l.usedQuota(GUEST, now), 1, 'a send that never landed must not cost them a slot');
});

test('🔴 but the uncharged attempts ARE counted, so spam is visible', async () => {
  // Counting what you did not charge for: if retry-spam becomes real it shows up
  // instead of being invisible. Never gated on.
  const l = new InviteLedger(tmp());
  for (let i = 0; i < 5; i++) l.record(rec({ outcome: 'failed' }));
  assert.equal(l.usedQuota(GUEST, now), 0, 'still costs them nothing');
  assert.equal(l.uncharged(GUEST, now), 5, 'and is nonetheless visible');
});

test('quota is per-sender and windowed', async () => {
  const l = new InviteLedger(tmp());
  l.record(rec({ by: JEFF }));
  l.record(rec({ at: ago(QUOTA_WINDOW_MS + 1000) }));
  assert.equal(l.usedQuota(GUEST, now), 0, 'another sender and an expired one both excluded');
  assert.equal(l.usedQuota(JEFF, now), 1);
  for (let i = 0; i < QUOTA_MAX; i++) l.record(rec());
  assert.equal(l.usedQuota(GUEST, now), QUOTA_MAX);
});

// ── dedupe counts ANY outcome ────────────────────────────────────────────────

test('🔴 per-recipient dedupe counts FAILED attempts too', async () => {
  // NOT because re-minting would create a second live credential -- after a
  // successful revoke there is none. It holds for the ORPHANED and
  // REVOKE-FAILED cases, where we do not know whether a credential survived, and
  // branching on the revoke outcome buys precision we cannot reliably compute.
  const l = new InviteLedger(tmp());
  l.record(rec({ recipient: '+15550009', outcome: 'failed' }));
  assert.equal(l.recentlyInvited('+15550009', now), true);
});

test('the dedupe window expires', async () => {
  const l = new InviteLedger(tmp());
  l.record(rec({ recipient: '+15550009', at: ago(DEDUPE_MS + 1000) }));
  assert.equal(l.recentlyInvited('+15550009', now), false);
});

// ── audit ────────────────────────────────────────────────────────────────────

test('every outcome is auditable and survives a restart', async () => {
  // Open invites make "who let this account in?" a question the log must answer.
  const path = tmp();
  const l = new InviteLedger(path);
  l.record(rec({ by: GUEST, recipient: '+15550002', outcome: 'confirmed' }));
  l.record(rec({ by: JEFF, recipient: '+15550003', outcome: 'orphaned', detail: 'code unreadable' }));
  const reloaded = new InviteLedger(path).all();
  assert.equal(reloaded.length, 2);
  assert.equal(reloaded[1]?.outcome, 'orphaned');
  assert.equal(reloaded[1]?.by, JEFF, 'WHO minted it must survive');
  assert.match(reloaded[1]?.detail ?? '', /unreadable/);
});
