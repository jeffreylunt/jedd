import { appearsInOwnTurns } from '../kindle.js';
import { QUOTA_MAX, type InviteLedger } from '../invite-ledger.js';
import type { JfagoClient } from '../jfago.js';
import { fail, ok, type Tool, type ToolContext } from './types.js';

/**
 * Invite someone to Jellyfin.
 *
 * ── 🔴 THE FAILURE PATH OWNS THE CREDENTIAL ──────────────────────────────────
 *
 * The link IS the message, so the invite must exist before the risky operation.
 * **The ordering is forced, which means the failure branch has to DESTROY the
 * credential rather than contain it.**
 *
 * V1 minted before the send and never revoked. Its fix changed **who sees the
 * link** — withheld from non-owners — while the invite stayed live for 24 hours.
 * **A withheld link is still a link; a deleted one is not.** And `deleteInvite`
 * already existed in V1's client with zero callers on this path.
 *
 * ── ⚠️ WE WILL SOMETIMES REVOKE A CREDENTIAL THAT ARRIVED ────────────────────
 *
 * BlueBubbles reports `error 22` for messages that DID arrive, so a false
 * "failed" will occasionally kill a working invite. **That direction is chosen
 * deliberately: a dead link is a support question, a live undelivered one is an
 * exposure.** If someone reports an invite link that does not work, check
 * whether the send was reported failed and the invite revoked before looking
 * anywhere else.
 */

/** How an invite is delivered. Injected, so the live gate stays shut until opened. */
export type InviteSender = (to: string, text: string) => Promise<{ delivered: boolean | null; detail: string }>;

export interface InviteDeps {
  jfago: JfagoClient;
  ledger: InviteLedger;
  send: InviteSender;
  now?: () => Date;
}

export function makeInviteTool(deps: InviteDeps): Tool {
  return {
    name: 'invite_to_jellyfin',
    description:
      'Send someone an invite to create a Jellyfin account. Pass the phone number EXACTLY as the ' +
      'person you are talking to typed it — if they have not given you one, ask. Never invent or ' +
      'reconstruct a number. The invite is single-use and the account it creates is permanent, so ' +
      'do not offer this to someone who has not asked for it.',
    minRole: 'guest',
    writes: true,
    parameters: {
      type: 'object',
      properties: {
        recipient: {
          type: 'string',
          description: 'The phone number, exactly as this person typed it.',
        },
      },
      required: ['recipient'],
    },
    async run(args, ctx: ToolContext) {
      const now = deps.now?.() ?? new Date();
      const recipient = typeof args['recipient'] === 'string' ? args['recipient'].trim() : '';
      if (!recipient) return fail('No recipient supplied.');
      if (ctx.config.readOnly) return fail('Writes are disabled, so no invite was created.');

      /**
       * 🔴 PROVENANCE, before anything is minted.
       *
       * Same rule and same reason as the Kindle address: **no property of a
       * phone number distinguishes a real one from a well-formed invention**, so
       * validation is structurally incapable and provenance is the only
       * available constraint.
       */
      const source = appearsInOwnTurns(recipient, ctx.userTurns ?? []);
      if (!source) {
        return fail(
          `REFUSED — "${recipient}" does not appear in anything this person typed, so no invite was ` +
            'created. Ask them to send the number themselves. Do not reconstruct it from anything else.',
        );
      }

      const by = ctx.senderHandle;

      // Dedupe BEFORE quota: a repeat within ten minutes is the same request.
      if (deps.ledger.recentlyInvited(recipient, now)) {
        return fail(
          `ALREADY_INVITED — ${recipient} was invited within the last few minutes. Nothing new was ` +
            'created. Give it a moment and check with them before trying again.',
        );
      }

      // Owner exempt: Jeff has jfa-go's admin surface anyway, so a limit there
      // buys no safety and only creates a mystery refusal mid-onboarding.
      if (ctx.role !== 'owner') {
        const used = deps.ledger.usedQuota(by, now);
        if (used >= QUOTA_MAX) {
          return fail(
            `RATE_LIMITED — this person has already sent ${used} invites in the last 24 hours, which ` +
              'is the limit. Nothing was created. Ask Jeff if they need more.',
          );
        }
      }

      // ── mint ─────────────────────────────────────────────────────────────
      const label = `jedd-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const minted = await deps.jfago.mint(label);

      if (minted.state === 'failed') {
        deps.ledger.record({ at: now.toISOString(), by, recipient, label, outcome: 'failed', detail: minted.detail });
        return fail(`FAILED — ${minted.detail} No invite exists.`);
      }
      if (minted.state === 'orphaned') {
        // A live credential we cannot name. The one outcome a human must see.
        deps.ledger.record({ at: now.toISOString(), by, recipient, label, outcome: 'orphaned', detail: minted.detail });
        return fail(`ORPHANED — ${minted.detail}`);
      }

      // ── send ─────────────────────────────────────────────────────────────
      const text =
        `You've been invited to Jeff's Jellyfin. Set up your account here: ${minted.invite.link}\n` +
        `This link works once and expires in 24 hours.`;
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

      /**
       * 🔴 `null` IS NOT `false`.
       *
       * `null` means no verdict yet — the row exists from the moment it is sent
       * and only acquires delivery on ACK. Treating it as failure would revoke a
       * working invite for every message in its first few hundred milliseconds.
       * Only an explicit `false` triggers revocation.
       */
      if (delivered === false) {
        const revoke = await deps.jfago.revoke(minted.invite.code);
        deps.ledger.record({
          at: now.toISOString(), by, recipient, label,
          outcome: revoke.revoked ? 'revoked' : 'orphaned',
          detail: `${sendDetail} | ${revoke.detail}`,
        });
        return fail(
          revoke.revoked
            ? `DELIVERY_FAILED — the text to ${recipient} did not go through, so the invite has been ` +
              `REVOKED and no longer works. Nothing was leaked. Tell them it did not send and offer ` +
              `to try a different number. Do NOT repeat any link.`
            : `🔴 DELIVERY_FAILED AND REVOKE FAILED — the text did not go through AND the invite ` +
              `could not be revoked, so a live single-use invite exists. ${revoke.detail} ` +
              `Tell them something went wrong and that Jeff needs to look at it.`,
        );
      }

      // Confirmed enough to charge for: sent without an explicit failure.
      deps.ledger.record({
        at: now.toISOString(), by, recipient, label, outcome: 'confirmed',
        detail: delivered === true ? 'delivered' : 'accepted, no delivery verdict',
      });
      return ok(
        `SENT — the invite went to ${recipient}` +
          (delivered === true ? ' and was delivered.' : '; delivery is not yet confirmed.') +
          ' It works once and expires in 24 hours. ⚠️ Once they use it their account is permanent — ' +
          'it cannot be undone by expiring the invite.',
      );
    },
  };
}
