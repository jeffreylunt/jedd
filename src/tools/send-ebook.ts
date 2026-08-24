import { fetchFileFromHp } from '../media/fetch-file.js';
import { grabStatus, grabTorrent, toHostPath, type MountMap } from '../media/grab.js';
import { sendToKindle, type MailSender } from '../media/kindle-send.js';
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
  { containerPrefix: '/downloads', hostPrefix: '/home/jeff/gluetun/downloads' },
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

      // ── which book ───────────────────────────────────────────────────────
      const picked = ctx.choices.resolve(ctx.senderHandle, n);
      if (!picked.ok) return fail(`${picked.reason.toUpperCase()} — ${picked.detail}`);
      const infoHash = String(picked.option.value['infoHash'] ?? '');
      const title = String(picked.option.value['title'] ?? picked.option.label);

      // ── grab ─────────────────────────────────────────────────────────────
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

      // ── is it here yet? ──────────────────────────────────────────────────
      const status = await grabStatus({
        adminSshHost: ctx.config.adminSshHost,
        qbitBaseUrl: ctx.config.qbittorrent.baseUrl,
        infoHash,
        exec: ctx.exec,
      });
      if (status.state === 'unknown') return fail(`UNKNOWN — ${status.detail}`);
      if (status.state === 'missing') return fail(`FAILED — ${status.detail}`);
      if (status.state === 'downloading') {
        // Not an error. The turn is not finished, so say what will finish it.
        return ok(
          `DOWNLOADING — ${status.detail} Nothing has been sent yet. Tell them it is downloading ` +
            'and that you will send it once it lands.',
        );
      }

      // ── move the bytes, verified ─────────────────────────────────────────
      const hostPath = toHostPath(status.contentPath, deps.mounts ?? DEFAULT_MOUNTS);
      if (!hostPath) {
        return fail(
          `FAILED — qBittorrent reports "${status.contentPath}", which is a path inside its own ` +
            'container and maps to no known mount. This is a configuration problem, not a missing book.',
        );
      }
      const file = await fetchFileFromHp({
        adminSshHost: ctx.config.adminSshHost,
        hostPath,
        exec: ctx.exec,
      });
      if (file.state !== 'ok') {
        return fail(`${file.state.toUpperCase()} — ${file.detail}`);
      }

      // ── send ─────────────────────────────────────────────────────────────
      const sent = await sendToKindle(
        { config: ctx.config, toAddress: record.address, filename: file.name, bytes: file.bytes },
        deps.send,
      );
      if (sent.state === 'accepted') return ok(`SENT — ${sent.detail}`);
      return fail(`${sent.state.toUpperCase()} — ${sent.detail}`);
    },
  };
}
