import { resolveOfKind } from '../choices.js';
import { grabTorrent } from '../media/grab.js';
import { fail, ok, type Tool } from './types.js';

/**
 * Grab an audiobook.
 *
 * ── 🔴 THIS TOOL DELIBERATELY DOES NOT DELIVER ANYTHING ──────────────────────
 *
 * A **host cron outside V2** moves finished audiobooks into Audiobookshelf:
 *
 *   `*<!>/5 * * * * /usr/bin/python3 /home/user/audiobook-mover.py`
 *   (written with a marker because a literal cron expression closes this comment)
 *
 * Verified running (log entries every five minutes) and it does the SAME
 * container→host prefix translation V2 does, then moves into
 * `/home/user/audiobookshelf/books` and **refuses to clobber a non-empty
 * destination**.
 *
 * ⚠️ **So V2 inherits a dependency it does not own.** Our only job is to put the
 * file where the mover looks — category `audiobooks`, save path
 * `/downloads/audiobooks`. If that cron stops, downloads still complete and
 * **nothing ever reaches Audiobookshelf**, with no error anywhere in V2. That is
 * the failure mode to remember when someone reports a book that never appeared.
 *
 * Which is why this reports the MECHANISM — handed to the download client — and
 * never claims the book is in Audiobookshelf, which we do not do and cannot see
 * from here.
 */
export const addAudiobook: Tool = {
  name: 'add_audiobook',
  // Reaches the homelab over ssh; absent entirely when none is configured.
  needsHomelabSsh: true,
  description:
    'Start downloading the audiobook the person CHOSE from the numbered list search_audiobook ' +
    'returned. Pass the number they picked. Do not call this until they have actually said which ' +
    'one — a book search returns different works, not different copies of one book.',
  minRole: 'guest',
  writes: true,
  consumesChoiceKind: 'audiobook-release',
  /**
   * 🔴 `choice` IS REQUIRED, AND ITS ABSENCE IS A REFUSAL — NOT A DEFAULT.
   *
   * It defaulted to option 1 while `search_audiobook` auto-picked and returned
   * one release, which was coherent: the pick had already been made, and the
   * number only existed for *"no, the other one"*.
   *
   * The search asks now, and a default of 1 would make that ask **advisory**.
   * The model could show five works, the person could say nothing at all, and a
   * no-argument call would grab whatever ranked top on seeders — the exact
   * behaviour the ask exists to stop, arriving through the argument the ask
   * forgot to close. A prompt that says "wait for their answer" and a schema
   * that acts without one disagree, and the schema is the half that runs.
   */
  parameters: {
    type: 'object',
    properties: {
      choice: {
        type: 'number',
        description: 'The number THEY picked from the list. Required — never guess it, never assume 1.',
      },
    },
    required: ['choice'],
  },
  async run(args, ctx) {
    if (args['choice'] === undefined) {
      return fail(
        'NO PICK — nothing was downloaded. A book search returns different works, so there is no ' +
          '"best" one to fall back on. Show them the numbered list and ask which book they meant.',
      );
    }
    const n = Number(args['choice']);
    if (!Number.isFinite(n)) return fail('That is not an option number.');
    if (ctx.config.readOnly) return fail('Writes are disabled, so nothing was grabbed.');
    if (!ctx.choices) return fail('No option store is available.');

    const picked = resolveOfKind(ctx.choices, ctx.senderHandle, n, 'audiobook-release');
    if (!picked.ok) return fail(`${picked.reason.toUpperCase()} — ${picked.detail}`);

    const infoHash = String(picked.option.value['infoHash'] ?? '');
    const title = String(picked.option.value['title'] ?? picked.option.label);
    const magnetUri = typeof picked.option.value['magnetUri'] === 'string'
      ? picked.option.value['magnetUri']
      : undefined;

    const grab = await grabTorrent({
      adminSshHost: ctx.config.adminSshHost,
      qbitBaseUrl: ctx.config.qbittorrent.baseUrl,
      infoHash,
      magnetUri,
      title,
      // 🔴 Both matter. The category is what the mover watches; the save path is
      // what actually places the file, because a category alone does not.
      category: ctx.config.audiobook.category,
      savePath: ctx.config.audiobook.savePath,
      exec: ctx.exec,
    });

    switch (grab.state) {
      case 'started':
        return ok(
          `STARTED — ${grab.detail} Once it finishes, a job on the server moves it into ` +
            'Audiobookshelf, usually within about five minutes. Tell them it is downloading — do ' +
            'NOT tell them it is in Audiobookshelf, because that step is not ours and we cannot see it.',
        );
      case 'already-have':
        return ok(`ALREADY_HAVE — ${grab.detail}`);
      case 'unknown':
        return fail(`UNKNOWN — ${grab.detail}`);
      case 'failed':
        return fail(`FAILED — ${grab.detail}`);
    }
  },
};
