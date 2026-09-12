import { randomBytes } from 'node:crypto';
import type { AbsClient } from '../audiobookshelf.js';
import { appearsInOwnTurns } from '../kindle.js';
import { QUOTA_MAX, type InviteLedger } from '../invite-ledger.js';
import { fail, ok, type Tool, type ToolContext } from './types.js';
import type { InviteSender } from './invite.js';

/**
 * Create an Audiobookshelf login and text the credentials.
 *
 * Unlike Jellyfin (jfa-go invite link), ABS has no redemption flow — username +
 * password must be set at create time and delivered in the message. Same
 * discipline as `invite_to_jellyfin`: on explicit delivery failure, destroy the
 * credential (`DELETE /api/users/:id`). A dead account is a support question; a
 * live password in an undelivered text is an exposure.
 */

export interface AbsInviteDeps {
  abs: AbsClient;
  ledger: InviteLedger;
  send: InviteSender;
  now?: () => Date;
}

export function makeAbsInviteTool(deps: AbsInviteDeps): Tool {
  return {
    name: 'invite_to_audiobookshelf',
    description:
      'Create an Audiobookshelf account and text the login details to someone. Pass `username` ' +
      '(what they asked to be called) and `recipient` (phone) EXACTLY as they typed them — if ' +
      'either is missing, ask. Never invent a username or number. The account can use Books and ' +
      'Podcasts (accessAllLibraries). Do not offer this unless they asked for Audiobookshelf access.',
    minRole: 'guest',
    writes: true,
    needsServices: ['audiobookshelf'],
    parameters: {
      type: 'object',
      properties: {
        username: {
          type: 'string',
          description: 'The username they asked for, exactly as they typed it.',
        },
        recipient: {
          type: 'string',
          description: 'The phone number to text the login to, exactly as they typed it.',
        },
      },
      required: ['username', 'recipient'],
    },
    async run(args, ctx: ToolContext) {
      const now = deps.now?.() ?? new Date();
      const username = typeof args['username'] === 'string' ? args['username'].trim() : '';
      const recipient = typeof args['recipient'] === 'string' ? args['recipient'].trim() : '';
      if (ctx.config.readOnly) return fail('Writes are disabled, so no Audiobookshelf account was created.');

      // Provenance before "required field" refusals — an invented recipient must
      // never look like a missing-argument error (see kindle.test.ts invariant).
      if (recipient && !appearsInOwnTurns(recipient, ctx.userTurns ?? [])) {
        return fail(
          `REFUSED — "${recipient}" does not appear in anything this person typed, so no account was ` +
            'created. Ask them to send the number themselves. Do not reconstruct it.',
        );
      }
      if (username && !appearsInOwnTurns(username, ctx.userTurns ?? [])) {
        return fail(
          `REFUSED — "${username}" does not appear in anything this person typed, so no account was ` +
            'created. Ask them to send the username themselves.',
        );
      }
      if (!username) return fail('No username supplied.');
      if (!recipient) return fail('No recipient supplied.');

      if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) {
        return fail(
          'REFUSED — username must be 3–32 characters of letters, digits, dot, underscore or hyphen. ' +
            'Nothing was created.',
        );
      }

      const by = ctx.senderHandle;
      if (deps.ledger.recentlyInvited(`abs:${recipient}`, now)) {
        return fail(
          `ALREADY_INVITED — ${recipient} already received an Audiobookshelf invite within the last few ` +
            'minutes. Nothing new was created.',
        );
      }
      if (deps.ledger.recentlyInvited(`abs-user:${username}`, now)) {
        return fail(
          `ALREADY_INVITED — username "${username}" was used in an Audiobookshelf invite very recently. ` +
            'Nothing new was created.',
        );
      }

      if (ctx.role !== 'owner') {
        const used = deps.ledger.usedQuota(by, now);
        if (used >= QUOTA_MAX) {
          return fail(
            `RATE_LIMITED — this person has already sent ${used} invites in the last 24 hours, which ` +
              'is the limit. Nothing was created. Tell them to ask the owner if they need more.',
          );
        }
      }

      const password = generatePassword();
      const created = await deps.abs.createUser(username, password);
      if (created.state === 'failed') {
        deps.ledger.record({
          at: now.toISOString(),
          by,
          recipient: `abs:${recipient}`,
          label: `abs:${username}`,
          outcome: 'failed',
          detail: created.detail,
        });
        return fail(`FAILED — ${created.detail} No account exists.`);
      }

      const verified = await deps.abs.getUser(created.user.id);
      if (verified.state === 'failed' || !verified.user.isActive) {
        await deps.abs.deleteUser(created.user.id);
        deps.ledger.record({
          at: now.toISOString(),
          by,
          recipient: `abs:${recipient}`,
          label: `abs:${username}`,
          outcome: 'failed',
          detail: verified.state === 'failed' ? verified.detail : 'verify showed inactive',
        });
        return fail(
          'FAILED — the account could not be verified active after create, so it was removed. ' +
            'No credentials were sent.',
        );
      }

      const text =
        `Your Audiobookshelf account is ready.\n` +
        `Open: ${deps.abs.publicUrl}\n` +
        `Username: ${verified.user.username}\n` +
        `Password: ${password}\n` +
        `Change the password after you log in. This message is the only copy Jedd keeps in chat.`;

      let delivered: boolean | null = null;
      let sendDetail = '';
      try {
        const r = await deps.send(recipient, text);
        delivered = r.delivered;
        sendDetail = r.detail;
      } catch (e) {
        delivered = false;
        sendDetail = (e as Error).message;
      }

      if (delivered === false) {
        const revoke = await deps.abs.deleteUser(verified.user.id);
        deps.ledger.record({
          at: now.toISOString(),
          by,
          recipient: `abs:${recipient}`,
          label: `abs:${username}`,
          outcome: revoke.state === 'deleted' ? 'revoked' : 'orphaned',
          detail: `${sendDetail} | ${revoke.detail}`,
        });
        return fail(
          revoke.state === 'deleted'
            ? `DELIVERY_FAILED — the text to ${recipient} did not go through, so the Audiobookshelf ` +
              `account has been DELETED and the password no longer works. Nothing was leaked. Tell ` +
              `them it did not send. Do NOT repeat any password.`
            : `🔴 DELIVERY_FAILED AND DELETE FAILED — the text did not go through AND the account ` +
              `could not be deleted, so a live login may exist. ${revoke.detail} Tell them something ` +
              `went wrong and that the owner needs to look at it.`,
        );
      }

      deps.ledger.record({
        at: now.toISOString(),
        by,
        recipient: `abs:${recipient}`,
        label: `abs:${username}`,
        outcome: 'confirmed',
        detail: delivered === true ? 'delivered' : 'accepted, no delivery verdict',
      });
      // Also stamp username dedupe key
      deps.ledger.record({
        at: now.toISOString(),
        by,
        recipient: `abs-user:${username}`,
        label: `abs:${username}`,
        outcome: 'confirmed',
        detail: 'username dedupe marker',
      });

      return ok(
        `SENT — Audiobookshelf login for "${verified.user.username}" went to ${recipient}` +
          (delivered === true ? ' and was delivered.' : '; delivery is not yet confirmed.') +
          ' They can use Books and Podcasts. ⚠️ The account is permanent until an admin deletes it.',
      );
    },
  };
}

function generatePassword(): string {
  // Readable enough to type on a phone, no ambiguous chars.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(16);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}
