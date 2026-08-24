import type { Config } from './config.js';

export type Role = 'owner' | 'guest';

/**
 * Normalise a messaging handle for comparison.
 *
 * 🔴 THIS DELIBERATELY DOES NOT COMPARE BY SUFFIX.
 *
 * The first version collapsed phone-shaped handles to their **last 10 digits**,
 * which made `+448015550123`, `008015550123` and `9998015550123` all resolve to
 * the owner — a complete authentication bypass for anyone who can pick their own
 * handle. Its unit test used a one-digit-different number, which shares no
 * suffix, so the test was structurally incapable of detecting the bug.
 *
 * The rule now: strip formatting punctuation, normalise a leading `+`, and treat
 * a bare 10-digit US number as equivalent to the same number with a `1` country
 * code. Nothing else is equated. Two handles match only if they are the same
 * handle.
 */
export function normaliseHandle(handle: string): string {
  const trimmed = handle.trim().toLowerCase();
  if (!trimmed) return '';

  // Phone-shaped only if it is digits plus formatting punctuation.
  if (/^\+?[\d\s()./-]+$/.test(trimmed)) {
    let digits = trimmed.replace(/\D/g, '');
    if (!digits) return '';
    // A bare 10-digit US number is the same number as `1` + those 10 digits.
    // This is an EXACT widening of one known case, not a suffix match.
    if (digits.length === 10) digits = `1${digits}`;
    return `tel:${digits}`;
  }

  return trimmed;
}

/**
 * THE permission decision. One owner; everybody else is a guest.
 *
 * Fails closed: an empty, malformed or unrecognised handle is a guest. There is
 * no path through this function that promotes an unknown sender.
 */
export function roleFor(senderHandle: string, config: Config): Role {
  if (!senderHandle) return 'guest';
  const sender = normaliseHandle(senderHandle);
  if (!sender) return 'guest';
  const owner = normaliseHandle(config.ownerHandle);
  if (!owner) return 'guest';
  return sender === owner ? 'owner' : 'guest';
}

export function roleSatisfies(actual: Role, required: Role): boolean {
  if (required === 'guest') return true;
  return actual === 'owner';
}
