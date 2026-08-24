import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Where a person's Kindle address lives.
 *
 * ── 🔴 THE DEFECT THIS EXISTS TO MAKE IMPOSSIBLE ─────────────────────────────
 *
 * V1's model **fabricated a Kindle address and a stranger received someone's
 * book.** `save_kindle_email` accepted a model-supplied string, and the string
 * it supplied — `jeff_27e778@kindle.com` — was Jeff's own real address
 * (`jeffreylunt_27e778@kindle.com`) with the middle of the local part removed.
 * It was persisted for a **different** user, ~1h43m after Jeff typed his.
 *
 * The `_27e778` suffix is an exact match on a random token, so coincidence is
 * ruled out: **the string reached the model's context from somewhere.**
 *
 * ── WHY THIS IS NOT SOLVED BY A GUARD ────────────────────────────────────────
 *
 * A validator on the address would have passed it. It is a syntactically perfect
 * `@kindle.com` address. **There is no property of the STRING that distinguishes
 * a real address from a plausible fabrication**, so anything that inspects the
 * string is the wrong shape of answer.
 *
 * The answer is PROVENANCE: a value may enter this store only if it appears
 * **verbatim in that sender's own messages**. Not the assistant's prose, not
 * another sender's history, not inferred. `jeff_27e778@kindle.com` was never
 * typed by anyone, so it could not have been stored.
 *
 * And the delivery tool takes **no address parameter at all** — the model cannot
 * supply what the schema does not accept.
 */

export interface KindleRecord {
  senderHandle: string;
  address: string;
  at: string;
  /** The user message the address was taken from. Kept so provenance is auditable. */
  sourceText: string;
}

/**
 * ⚠️ The local part is stored VERBATIM and only the domain is lowercased.
 *
 * V1 lowercased the whole address in front of the user, which both corrupted it
 * and forced a re-onboarding. Comparison is case-insensitive; storage is not.
 */
export function normaliseKindleAddress(raw: string): string | null {
  const trimmed = raw.trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return null;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1).toLowerCase();
  if (!/^[A-Za-z0-9._%+-]+$/.test(local)) return null;
  // Only @kindle.com. An Amazon LOGIN address is the common mistake and it is
  // not a delivery address; sending there silently does nothing.
  if (domain !== 'kindle.com') return null;
  return `${local}@${domain}`;
}

/**
 * Did this exact address appear in something the sender themselves typed?
 *
 * 🔴 This is a check on an INPUT's provenance, not on the model's wording. It
 * makes a fabricated address unstorable rather than detecting it afterwards.
 */
export function appearsInOwnTurns(address: string, userTurns: string[]): string | null {
  const needle = address.toLowerCase();
  for (const turn of userTurns) {
    if (turn.toLowerCase().includes(needle)) return turn;
  }
  return null;
}

export class KindleRegistry {
  private readonly byHandle = new Map<string, KindleRecord>();

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
        const rec = JSON.parse(t) as KindleRecord;
        if (rec.senderHandle && rec.address) this.byHandle.set(rec.senderHandle, rec);
      } catch {
        continue;
      }
    }
  }

  get(senderHandle: string): KindleRecord | undefined {
    return this.byHandle.get(senderHandle);
  }

  /**
   * Store an address for a sender.
   *
   * Refuses unless the address appears verbatim in that sender's OWN turns.
   * Returns the reason on refusal so the caller can say what it needs.
   */
  save(
    senderHandle: string,
    rawAddress: string,
    userTurns: string[],
    at = new Date(),
  ): { ok: true; record: KindleRecord } | { ok: false; reason: string } {
    const address = normaliseKindleAddress(rawAddress);
    if (!address) {
      return {
        ok: false,
        reason:
          `"${rawAddress}" is not a Kindle delivery address. It must end in @kindle.com — an Amazon ` +
          'login email is a different thing and sending there does nothing.',
      };
    }
    const source = appearsInOwnTurns(address, userTurns);
    if (!source) {
      return {
        ok: false,
        reason:
          `REFUSED: "${address}" does not appear in anything this person typed, so it cannot be ` +
          'stored. Ask them to send their Kindle address themselves. (V1 once invented an address ' +
          "that looked exactly like a real one and a stranger received someone's book.)",
      };
    }
    const record: KindleRecord = { senderHandle, address, at: at.toISOString(), sourceText: source };
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, 'utf8');
    this.byHandle.set(senderHandle, record);
    return { ok: true, record };
  }
}
