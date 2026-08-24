import type { Config } from './config.js';

export type Role = 'owner' | 'guest';

/**
 * Normalise a messaging handle so that `+1 (801) 839-6586`, `15555550100` and
 * `5555550100` compare equal, without letting an arbitrary string coincidentally
 * match the owner.
 *
 * Phone-shaped handles collapse to their last 10 digits. Anything else (an
 * email, an iMessage alias) is lowercased and trimmed only.
 */
export function normaliseHandle(handle: string): string {
  const trimmed = handle.trim().toLowerCase();
  const digits = trimmed.replace(/\D/g, '');
  // Treat as a phone number only if the handle is essentially all digits.
  const nonDigits = trimmed.replace(/[\d\s()+.-]/g, '');
  if (nonDigits === '' && digits.length >= 10) return digits.slice(-10);
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
