import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Who invited whom, and how often.
 *
 * ── 🔴 WRITTEN ON THE CONFIRMED PATH ONLY ────────────────────────────────────
 *
 * A record written on ATTEMPT would let a send that never landed consume the
 * requester's quota and suppress the retry they are entitled to. **Do not charge
 * a user for our failure.** And with revocation in place the security argument
 * for charging is gone entirely: a failed attempt now leaves no live credential,
 * so what remains is noise rather than exposure.
 *
 * ── ⚠️ BUT COUNT WHAT YOU DID NOT CHARGE FOR ─────────────────────────────────
 *
 * Failures are RECORDED and never gated on. If retry-spam ever becomes real it
 * will be **visible** rather than invisible; if it never does, the cost was one
 * counter. Same move as counting discarded Prowlarr releases so *"found things
 * we can't fetch"* stays distinguishable from *"found nothing"*.
 *
 * No rate limit is pre-built for it: the per-recipient dedupe covers the
 * same-recipient case, varying-recipient spam produces noise not exposure, and
 * if it ever bites that is a rate-limit fix at a different layer.
 */

export interface InviteRecord {
  at: string;
  /** WHO minted it. Open invites make "who let this account in?" a real question. */
  by: string;
  recipient: string;
  label: string;
  /** 'confirmed' counts against quota. Everything else is recorded, not charged. */
  outcome: 'confirmed' | 'failed' | 'revoked' | 'orphaned';
  detail?: string;
}

export const QUOTA_MAX = 3;
export const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEDUPE_MS = 10 * 60 * 1000;

export class InviteLedger {
  private readonly records: InviteRecord[] = [];

  constructor(private readonly path: string) {
    this.load();
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      return;
    }
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        this.records.push(JSON.parse(t) as InviteRecord);
      } catch {
        continue;
      }
    }
  }

  record(rec: InviteRecord): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(rec)}\n`, 'utf8');
    this.records.push(rec);
  }

  /** Confirmed invites by this sender inside the window. Failures do not count. */
  usedQuota(by: string, now = new Date()): number {
    const cutoff = now.getTime() - QUOTA_WINDOW_MS;
    return this.records.filter(
      (r) => r.by === by && r.outcome === 'confirmed' && Date.parse(r.at) >= cutoff,
    ).length;
  }

  /** Attempts that were NOT charged. Recorded so spam is visible, never gated on. */
  uncharged(by: string, now = new Date()): number {
    const cutoff = now.getTime() - QUOTA_WINDOW_MS;
    return this.records.filter(
      (r) => r.by === by && r.outcome !== 'confirmed' && Date.parse(r.at) >= cutoff,
    ).length;
  }

  /**
   * The most recent attempt for this recipient inside the dedupe window, if any.
   *
   * 🔴 Returns the RECORD, not a boolean — because the outcome is what the caller
   * must branch on.
   *
   * "Any recent attempt" was the wrong shape the moment a failure path needed a
   * recovery path: after a successful revoke there is no live credential, so a
   * re-mint creates one, not two, and a revoked attempt is exactly the case where
   * "send it again" is the right thing and the window was standing in the way
   * (2026-09-20: a false-negative send failure revoked a working invite, then
   * the window refused to mint a replacement for two minutes while the recipient
   * sat on a dead link). The ORPHANED and REVOKE-FAILED cases still block, but
   * at the call site, where the outcome is visible.
   */
  recentRecord(recipient: string, now = new Date()): InviteRecord | undefined {
    const cutoff = now.getTime() - DEDUPE_MS;
    let newest: InviteRecord | undefined;
    for (const r of this.records) {
      if (r.recipient !== recipient) continue;
      const t = Date.parse(r.at);
      if (t < cutoff) continue;
      if (!newest || t >= Date.parse(newest.at)) newest = r;
    }
    return newest;
  }

  /** True if this recipient was attempted inside the dedupe window. */
  recentlyInvited(recipient: string, now = new Date()): boolean {
    return this.recentRecord(recipient, now) !== undefined;
  }

  all(): InviteRecord[] {
    return [...this.records];
  }
}
