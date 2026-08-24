import { CATEGORY, ProwlarrClient, rankReleases, type FetchImpl, type Release } from '../media/prowlarr.js';
import { fail, ok, type Tool } from './types.js';

/**
 * The PRODUCERS for `add_audiobook` and `send_ebook`.
 *
 * ── 🔴 THE REGRESSION THIS CLOSES, AND WHY IT WAS INVISIBLE ─────────────────
 *
 * Jeff, live: *"Can you get the ready player one audiobook?"* Jedd: *"I've got a
 * tool to start an audiobook download, but it needs a pick from an audiobook
 * search — and I don't have an audiobook search tool."*
 *
 * `add_audiobook` was registered, booted, and sat in the live tool line, and it
 * was **uncallable**: it resolves a numbered pick and nothing produced one.
 * `send_ebook` was in the identical state — and `send_ebook` had been *verified
 * live end to end, a real book reached a real Kindle*, through a script that
 * constructed it directly. **"It works" and "it can be reached" were both true,
 * of different objects.**
 *
 * `ProwlarrClient` and `rankReleases` were already written, complete, with the
 * three-state discipline — and had **no caller anywhere in the repo**. This file
 * is the caller. See `assertChoiceProducersExist` in `index.ts` for the
 * invariant that now makes this class of gap refuse to boot.
 *
 * ── ONE FACTORY, TWO TOOLS ──────────────────────────────────────────────────
 *
 * Audiobooks and ebooks differ by a Prowlarr category id and which tool takes
 * the pick afterwards. They are two named tools rather than one with an enum
 * **because the model must route to a different consumer** — `add_audiobook`
 * versus `send_ebook` — and a name that says which medium it searched is the
 * thing that makes that obvious.
 */
function makeReleaseSearch(medium: 'audiobook' | 'ebook', fetchImpl?: FetchImpl): Tool {
  const isAudio = medium === 'audiobook';
  const consumer = isAudio ? 'add_audiobook' : 'send_ebook';
  return {
    name: isAudio ? 'search_audiobook' : 'search_ebook',
    description: isAudio
      ? 'Search for an AUDIOBOOK — a book to LISTEN to. Returns a numbered list of releases. ' +
        `PRESENT the numbered options and ask which one they want, then call ${consumer} with their ` +
        'number. Do NOT say anything is downloading yet — nothing is, until they pick. Set ' +
        'graphic_audio true ONLY if they explicitly asked for a GraphicAudio dramatisation.'
      : 'Search for an EBOOK — a book to READ, delivered to their Kindle. Returns a numbered list ' +
        `of releases. PRESENT the numbered options and ask which one they want, then call ${consumer} ` +
        'with their number. Do NOT say anything is being sent yet. Use search_audiobook instead if ' +
        'they want to LISTEN.',
    minRole: 'guest',
    /**
     * ⚠️ A READ. It searches indexers and stores a list; nothing is grabbed and
     * nothing is sent until the consumer runs. Marking it a write would remove
     * the producer in read-only mode and take the whole flow down with it —
     * which is the same shape as the bug this file exists to fix.
     */
    writes: false,
    presentsChoiceKinds: ['release'],
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: isAudio
            ? 'Title and author if known, e.g. "Project Hail Mary Andy Weir". Do NOT include the word "audiobook".'
            : 'Title and author if known, e.g. "Project Hail Mary Andy Weir". Do NOT include the word "book".',
        },
        ...(isAudio
          ? {
              graphic_audio: {
                type: 'boolean',
                description:
                  'True ONLY if they explicitly asked for a GraphicAudio dramatisation. If they said ' +
                  'they did not want one, or did not mention it, leave it false.',
              },
            }
          : {}),
      },
      required: ['query'],
    },
    async run(args, ctx) {
      const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
      if (!query) return fail(`No search terms. Ask which ${medium} they want.`);
      if (!ctx.config.prowlarr.apiKey) {
        return fail(`Prowlarr is not configured here, so I cannot search. This is not "no ${medium}s exist".`);
      }
      /**
       * 🔴 NO STORE, NO LIST. Unlike `catalogue_search`, this flow has no other
       * route: `${consumer}` takes ONLY a pick. Presenting numbered options that
       * nothing can resolve would offer a flow that cannot complete.
       */
      if (!ctx.choices) {
        return fail(
          'There is nowhere to record a numbered list, so a pick could not be resolved afterwards. ' +
            'Nothing was searched for them to choose from.',
        );
      }

      const client = new ProwlarrClient({ ...ctx.config.prowlarr, fetchImpl });
      const found = await client.search(query, isAudio ? CATEGORY.audiobook : CATEGORY.ebook);

      // 🔴 An unreachable indexer is UNKNOWN. The client words this itself, and
      // the wording is the point: a failure to LOOK is not a finding of absence.
      if (found.state === 'unknown') return fail(`UNKNOWN — ${found.detail}`);
      if (found.state === 'none') return ok(`NONE — ${found.detail}`);

      const wantsGraphic = args['graphic_audio'] === true;
      const before = found.releases.length;
      const releases = isAudio ? found.releases.filter((r) => isGraphicAudio(r) === wantsGraphic) : found.releases;

      /**
       * 🔴 A FILTER THAT REMOVED EVERYTHING IS NOT "NOTHING EXISTS".
       *
       * Same two-zeros rule as everywhere else, one layer further in: releases
       * were found and OUR filter discarded them all. Reporting "none found"
       * would be a false negative we manufactured, and the useful answer is the
       * one that names the filter — they can just say yes to a dramatisation.
       */
      if (releases.length === 0) {
        return ok(
          `FILTERED OUT — found ${before} ${medium} release(s) for "${query}", but ` +
            (wantsGraphic
              ? 'NONE of them are GraphicAudio dramatisations. Say so and ask whether an ordinary ' +
                'reading is fine.'
              : 'EVERY one is a GraphicAudio dramatisation. Say so and ask whether they want one.'),
        );
      }

      const top = rankReleases(releases).slice(0, 5);
      ctx.choices.present({
        senderHandle: ctx.senderHandle,
        subject: query,
        // 🔴 The kind the consumer declares it needs. See types.ts.
        kind: 'release',
        options: top.map((r, i) => ({
          n: i + 1,
          label: describe(r),
          // Exactly the shape `add_audiobook` and `send_ebook` already read.
          value: { infoHash: r.infoHash, title: r.title, ...(r.magnetUri ? { magnetUri: r.magnetUri } : {}) },
        })),
      });

      const notes: string[] = [];
      if (top.length < releases.length) notes.push(`showing the top ${top.length} of ${releases.length}`);
      if (isAudio && before > releases.length) {
        notes.push(`${before - releases.length} GraphicAudio release(s) left out`);
      }
      // Found-but-unfetchable is reported: "nothing found" and "found things we
      // cannot fetch" are different answers.
      if (found.discarded) notes.push(`${found.discarded} more had no infoHash and cannot be fetched`);
      const suffix = notes.length ? ` (${notes.join('; ')})` : '';

      const lines = top.map((r, i) => `  ${i + 1}. ${describe(r)}`).join('\n');
      return ok(
        `${top.length} ${medium} release(s) for "${query}"${suffix}:\n${lines}\n` +
          `(present these as a numbered list and ask which one; then call ${consumer} with their ` +
          'number. Nothing is downloading yet.)',
      );
    },
  };
}

export function makeSearchAudiobook(fetchImpl?: FetchImpl): Tool {
  return makeReleaseSearch('audiobook', fetchImpl);
}

export function makeSearchEbook(fetchImpl?: FetchImpl): Tool {
  return makeReleaseSearch('ebook', fetchImpl);
}

/**
 * GraphicAudio dramatisations are a full cast production, not a reading — much
 * larger, and not what someone asking for "the audiobook" usually means. Matched
 * loosely because release names spell it every way: `GraphicAudio`,
 * `Graphic Audio`, `GRAPHIC-AUDIO`.
 */
function isGraphicAudio(r: Release): boolean {
  return /graphic[\s._-]*audio/i.test(r.title);
}

function describe(r: Release): string {
  return `${r.title} — ${humanSize(r.sizeBytes)}, ${r.seeders} seeder(s), ${r.indexer}`;
}

function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'size unknown';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}
