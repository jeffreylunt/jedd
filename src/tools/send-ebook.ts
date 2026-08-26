import { deliverEbook } from '../media/ebook-deliver.js';
import { grabTorrent, type MountMap } from '../media/grab.js';
import type { IrcEbooks } from '../media/irc-ebooks.js';
import type { MailSender } from '../media/kindle-send.js';
import { fail, ok, type Tool, type ToolContext } from './types.js';

/**
 * Grab a book and send it to the person's Kindle.
 *
 * ── 🔴 THE ADDRESS IS NOT A PARAMETER, AT ANY LAYER ──────────────────────────
 *
 * The schema below takes a CHOICE NUMBER. The address is resolved from
 * `ctx.senderHandle` against the verified store, and the store only accepts a
 * value that appeared verbatim in that person's own messages. **There is no
 * path by which a model-supplied string becomes a recipient.**
 *
 * ── WHY THIS SHIPPED ONLY NOW ────────────────────────────────────────────────
 *
 * Eight modules had to work first. A tool that implies a capability it lacks is
 * the `request_media` mistake, and it would have been worse here: the user would
 * be told a book was on its way.
 */

/** Where qBittorrent's paths map to on hp. Container view → host view. */
export const DEFAULT_MOUNTS: MountMap[] = [
  // ⚠️ A real path on a real machine, so it is configuration. Empty rather than
  // guessed: a wrong host prefix produces a file-not-found, not a wrong file.
  { containerPrefix: '/downloads', hostPrefix: process.env.EBOOK_HOST_DOWNLOAD_PREFIX ?? '' },
];

export interface SendEbookDeps {
  send: MailSender;
  mounts?: MountMap[];
  /**
   * 🔴 LIVE-TEST SAFETY, STRUCTURAL RATHER THAN REMEMBERED.
   *
   * When set, the tool refuses to send to anyone but this handle. A first live
   * test that emails a real book to a real third party is not a test — it is an
   * outward-facing action on someone who did not ask for it.
   *
   * It is a constructor argument rather than a config flag so the restricted
   * build is a DIFFERENT OBJECT, not the same object in a different mood.
   */
  onlySendTo?: string;
  /** The IRC source, when this deployment has one. */
  irc?: IrcEbooks;
}

export function makeSendEbook(deps: SendEbookDeps): Tool {
  return {
    name: 'send_ebook',
    description:
      'Grab a book that was found by an ebook search and send it to the person\'s Kindle. Pass the ' +
      'number they chose from the list you showed them. You do not supply an address — theirs is ' +
      'already stored, and if it is not, ask them for it and save it first.',
    minRole: 'guest',
    writes: true,
    consumesChoiceKind: 'release',
    parameters: {
      type: 'object',
      properties: {
        choice: { type: 'number', description: 'The option number they picked.' },
      },
      required: ['choice'],
    },
    async run(args, ctx: ToolContext) {
      const n = Number(args['choice']);
      if (!Number.isFinite(n)) return fail('A choice number is required.');
      if (ctx.config.readOnly) return fail('Writes are disabled, so nothing was grabbed or sent.');
      if (!ctx.choices) return fail('No option store is available.');
      if (!ctx.kindle) return fail('No address store is available.');

      // ── who it goes to, decided before anything is done ──────────────────
      const record = ctx.kindle.get(ctx.senderHandle);
      if (!record) {
        return fail(
          'NO ADDRESS — nothing was grabbed. Ask them for their @kindle.com address and save it ' +
            'first; do not guess one.',
        );
      }
      if (deps.onlySendTo && ctx.senderHandle !== deps.onlySendTo) {
        return fail(
          `RESTRICTED — this build only sends to ${deps.onlySendTo}. Nothing was grabbed or sent.`,
        );
      }

      // ── which book, and FROM WHERE ───────────────────────────────────────
      const picked = ctx.choices.resolve(ctx.senderHandle, n);
      if (!picked.ok) return fail(`${picked.reason.toUpperCase()} — ${picked.detail}`);
      const value = picked.option.value;
      const title = String(value['title'] ?? picked.option.label);

      /**
       * 🔴 ABSENT `source` MEANS PROWLARR, EXPLICITLY.
       *
       * `choices.jsonl` is durable and every option written before IRC existed
       * has no `source` key at all. A pending list that survives a restart would
       * otherwise arrive here with `undefined` and match neither branch — the
       * first pick after this deploy would break. Defaulting is a MIGRATION,
       * not a convenience, which is why it is spelled out rather than relying on
       * a falsy check somewhere below.
       */
      const source = value['source'] === 'irc' ? 'irc' : 'prowlarr';

      /**
       * 🔴 `.mobi` IS REFUSED BEFORE ANYTHING IS FETCHED, AND NAMES A WAY OUT.
       *
       * Amazon has rejected `.mobi` since 2022 and does it SILENTLY — the send
       * looks fine here and the book never arrives. Declining beats a bounce
       * nobody can see. `ebook-validate.ts` catches this again on the bytes;
       * this earlier check exists so the person is told *now*, and told which
       * numbered option to pick instead, rather than after a pointless download.
       */
      if (/\.mobi\b/i.test(title)) {
        const alt = picked.choice.options.find((o) => /\.epub\b/i.test(String(o.value['title'] ?? o.label)));
        return fail(
          `REFUSED — "${title}" is a .mobi. Amazon stopped accepting that format in 2022 and ` +
            'rejects it silently, so it would look sent and never arrive. Nothing was fetched. ' +
            (alt
              ? `Option ${alt.n} is an EPUB — offer them that one instead.`
              : 'None of the other options is an EPUB; offer to search again.'),
        );
      }

      // ── start the fetch ──────────────────────────────────────────────────
      if (source === 'prowlarr') {
        const infoHash = String(value['infoHash'] ?? '');
        const grab = await grabTorrent({
          adminSshHost: ctx.config.adminSshHost,
          qbitBaseUrl: ctx.config.qbittorrent.baseUrl,
          infoHash,
          title,
          category: 'ebooks',
          exec: ctx.exec,
        });
        if (grab.state === 'failed') return fail(`FAILED — ${grab.detail}`);
        if (grab.state === 'unknown') return fail(`UNKNOWN — ${grab.detail}`);
      }

      const subject = {
        source,
        title,
        ...(source === 'prowlarr'
          ? { infoHash: String(value['infoHash'] ?? '') }
          : { command: String(value['command'] ?? ''), bot: String(value['bot'] ?? '') }),
      } as const;

      /**
       * One attempt now, in case the torrent is already on disk — the fast path
       * that was there before and is worth keeping. IRC never blocks a turn:
       * a bot can queue a request for ten minutes or more.
       */
      const attempt = await deliverEbook(
        subject,
        ctx.senderHandle,
        {
          config: ctx.config,
          kindle: ctx.kindle,
          mail: deps.send,
          ...(ctx.exec ? { exec: ctx.exec } : {}),
          ...(deps.irc ? { irc: deps.irc } : {}),
          mounts: deps.mounts ?? DEFAULT_MOUNTS,
        },
        { mayBlock: false },
      );

      if (attempt.state === 'delivered') return ok(`SENT — ${attempt.detail}`);
      if (attempt.state === 'failed') return fail(`FAILED — ${attempt.detail}`);

      /**
       * 🔴 NOT HERE YET — AND THIS IS WHERE THE OLD BUG LIVED.
       *
       * This branch used to return *"DOWNLOADING — ... you will send it once it
       * lands"* and schedule NOTHING. No code path anywhere ever delivered the
       * book or told the person otherwise. That is the Peppa Pig defect in the
       * ebook flow: the grab succeeding is not the outcome, the person learning
       * what happened is.
       *
       * A follow-up is scheduled HERE, and the wording below is contingent on it
       * actually being scheduled — if there is no store, the tool says plainly
       * that it cannot come back, rather than promising on behalf of a mechanism
       * it does not have.
       */
      if (!ctx.followups) {
        return ok(
          `STARTED — ${attempt.detail} I have NOT sent anything, and I cannot check back on my ` +
            'own here. Tell them to ask again in a few minutes.',
        );
      }

      const already = ctx.followups.pendingEbook(ctx.senderHandle, title);
      if (!already) {
        ctx.followups.schedule({
          kind: 'ebook-deliver',
          senderHandle: ctx.senderHandle,
          // Due immediately: the runner's next tick starts the real work. For
          // IRC that tick is where the request is actually sent.
          dueAt: new Date(),
          reason: `started fetching "${title}" for them`,
          observed: attempt.detail,
          ebook: subject,
        });
      }

      return ok(
        `STARTED — ${attempt.detail} NOTHING HAS BEEN SENT YET. Tell them it is on the way and ` +
          'that you will message them when it actually lands — do not say it has been sent.',
      );
    },
  };
}
