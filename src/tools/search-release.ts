import { CATEGORY, ProwlarrClient, rankReleases, type FetchImpl, type Release } from '../media/prowlarr.js';
import type { IrcEbooks } from '../media/irc-ebooks.js';
import type { IrcResult } from '../media/irc-protocol.js';
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
/**
 * ── 🔴 IRC IS A SECOND SOURCE INSIDE THIS TOOL, NOT A SECOND TOOL ───────────
 *
 * Two reasons, and the structural one is the stronger:
 *
 * 1. **The registry punishes the split.** `assertChoiceProducersExist` and
 *    `assertNamedProducersExist` (see `index.ts`) throw at boot if a consumer's
 *    choice kind has no producer, or if a description names a tool that is not
 *    registered. A separate `search_ebook_irc` would either need its own
 *    consumer or would re-declare `presentsChoiceKinds: ['release']` — the same
 *    producer twice under a different name, with the model now forced to choose
 *    between two tools that do the same job.
 * 2. Tool selection was measured at **0/5 at production registry size** on
 *    2026-08-26. Adding names makes that worse.
 *
 * So both sources return ONE numbered list, and the pick carries its own
 * provenance in `value.source`. The model never decides which fetcher runs —
 * `send_ebook` switches on the stored value, in code.
 */
function makeReleaseSearch(medium: 'audiobook' | 'ebook', fetchImpl?: FetchImpl, irc?: IrcEbooks): Tool {
  const isAudio = medium === 'audiobook';
  const consumer = isAudio ? 'add_audiobook' : 'send_ebook';
  return {
    name: isAudio ? 'search_audiobook' : 'search_ebook',
    /**
     * ⚠️ ONLY THE AUDIOBOOK HALF NEEDS PROWLARR. `search_ebook` has a SECOND
     * source — IRC — so gating it on Prowlarr would remove a tool that still
     * works for anyone running IRC_EBOOKS and no indexer. Same factory, and
     * deliberately not the same dependency.
     */
    needsServices: isAudio ? ['prowlarr'] : [],
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

      const hasIrc = !isAudio && !!irc;
      if (!ctx.config.prowlarr.apiKey && !hasIrc) {
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

      /**
       * 🔴 BOTH SOURCES ARE QUERIED BEFORE ANY "NOTHING FOUND" IS REPORTED.
       *
       * An earlier version of this merge returned Prowlarr's `none` immediately
       * and only then asked IRC — which would have answered *"no books"* for
       * exactly the case this feature exists to serve. Measured 2026-08-26:
       * Prowlarr 7 results for a title where IRC had 27. **A source that was
       * never asked cannot be evidence of absence.**
       */
      /**
       * ⚠️ THE TWO SOURCES RUN CONCURRENTLY, NOT ONE AFTER THE OTHER.
       *
       * Awaiting IRC first made every ebook search pay IRC's latency before
       * Prowlarr was even asked — up to the connect timeout plus the search
       * timeout, inside a guest-facing turn, even when Prowlarr would have
       * answered in milliseconds. Same reasoning as never blocking a turn on a
       * DCC transfer, with only the number changed.
       */
      const [ircFound, found] = await Promise.all([
        hasIrc
          ? irc!.search(query)
          : Promise.resolve({ state: 'none' as const, detail: 'IRC is not enabled here.' }),
        ctx.config.prowlarr.apiKey
          ? new ProwlarrClient({ ...ctx.config.prowlarr, fetchImpl }).search(
              query,
              isAudio ? CATEGORY.audiobook : CATEGORY.ebook,
            )
          : Promise.resolve({ state: 'none' as const, detail: 'Prowlarr is not configured here.' } as const),
      ]);

      let ircOffers: Offer[] = [];
      let ircNote = '';
      if (hasIrc) {
        if (ircFound.state === 'ok') {
          ircOffers = ircFound.results.map(ircOffer);
          if (ircFound.detail) ircNote = `IRC ${ircFound.detail}`;
        } else {
          // 'none' and 'unknown' are both reported, never treated as "no books".
          ircNote = `IRC: ${ircFound.detail}`;
        }
      }

      // 🔴 An unreachable indexer is UNKNOWN — a failure to LOOK is not a finding
      // of absence. But with IRC offers in hand it is a PARTIAL result, not a
      // dead end, so it degrades to a note instead of taking the whole tool down.
      let prowlarrNote = '';
      if (found.state === 'unknown') {
        if (ircOffers.length === 0) return fail(`UNKNOWN — ${found.detail}`);
        prowlarrNote = `the torrent indexers could not be reached (${found.detail})`;
      }
      /**
       * 🔴 AN ABSENCE REPORT MUST NAME WHAT WAS NOT REACHED.
       *
       * Reporting "NONE" while IRC was unreachable states a finding of absence
       * on the strength of one source — the same two-zeros error this file
       * guards everywhere else, just moved up a level. The note travels with the
       * NONE so the model can say "and I could not reach the other source",
       * rather than implying the book does not exist.
       */
      if (found.state === 'none' && ircOffers.length === 0) {
        return ok(`NONE — ${found.detail}${ircNote ? ` (${ircNote})` : ''}`);
      }

      const wantsGraphic = args['graphic_audio'] === true;
      const all = found.state === 'results' ? found.releases : [];
      const before = all.length;
      const releases = isAudio ? all.filter((r) => isGraphicAudio(r) === wantsGraphic) : all;

      /**
       * 🔴 A FILTER THAT REMOVED EVERYTHING IS NOT "NOTHING EXISTS".
       *
       * Same two-zeros rule as everywhere else, one layer further in: releases
       * were found and OUR filter discarded them all. Reporting "none found"
       * would be a false negative we manufactured, and the useful answer is the
       * one that names the filter — they can just say yes to a dramatisation.
       */
      if (releases.length === 0 && ircOffers.length === 0) {
        return ok(
          `${ircNote ? `[${ircNote}] ` : ''}` +
            `FILTERED OUT — found ${before} ${medium} release(s) for "${query}", but ` +
            (wantsGraphic
              ? 'NONE of them are GraphicAudio dramatisations. Say so and ask whether an ordinary ' +
                'reading is fine.'
              : 'EVERY one is a GraphicAudio dramatisation. Say so and ask whether they want one.'),
        );
      }

      const torrentOffers: Offer[] = rankReleases(releases)
        .slice(0, 5)
        .map((r) => ({
          label: describe(r),
          isEpub: /\.epub\b/i.test(r.title),
          value: { source: 'prowlarr', infoHash: r.infoHash, title: r.title, ...(r.magnetUri ? { magnetUri: r.magnetUri } : {}) },
        }));

      const top = interleave(torrentOffers, ircOffers).slice(0, 5);

      ctx.choices.present({
        senderHandle: ctx.senderHandle,
        subject: query,
        // 🔴 The kind the consumer declares it needs. See types.ts.
        kind: 'release',
        options: top.map((o, i) => ({ n: i + 1, label: o.label, value: o.value })),
      });

      const notes: string[] = [];
      const totalFound = releases.length + ircOffers.length;
      if (top.length < totalFound) notes.push(`showing the top ${top.length} of ${totalFound}`);
      if (isAudio && before > releases.length) {
        notes.push(`${before - releases.length} GraphicAudio release(s) left out`);
      }
      // Found-but-unfetchable is reported: "nothing found" and "found things we
      // cannot fetch" are different answers.
      if (found.state === 'results' && found.discarded) {
        notes.push(`${found.discarded} more had no infoHash and cannot be fetched`);
      }
      if (prowlarrNote) notes.push(prowlarrNote);
      if (ircNote) notes.push(ircNote);
      const suffix = notes.length ? ` (${notes.join('; ')})` : '';

      const lines = top.map((o, i) => `  ${i + 1}. ${o.label}`).join('\n');
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

export function makeSearchEbook(fetchImpl?: FetchImpl, irc?: IrcEbooks): Tool {
  return makeReleaseSearch('ebook', fetchImpl, irc);
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

interface Offer {
  label: string;
  isEpub: boolean;
  value: Record<string, unknown>;
}

function ircOffer(r: IrcResult): Offer {
  const size = r.sizeBytes === undefined ? 'size unknown' : humanSize(r.sizeBytes);
  return {
    // The origin is visible to a human, so a pick is never ambiguous about where
    // it came from — and "via IRC" reads differently from a seeder count.
    label: `${r.title} — ${size}, via IRC (${r.bot})`,
    isEpub: r.ext === '.epub',
    // 🔴 The command is stored VERBATIM. It is what the bot expects to see back,
    // and reconstructing it from the label would be the classic way to break it.
    value: { source: 'irc', command: r.command, bot: r.bot, title: r.title },
  };
}

/**
 * One list, both sources represented, EPUBs first.
 *
 * Alternating rather than concatenating matters: Prowlarr's ebook coverage is
 * thin (7 results where IRC had 27, measured 2026-08-26), and appending IRC
 * after five torrent rows would push every IRC result off the end of a
 * five-item list — a merge in name only.
 */
function interleave(a: Offer[], b: Offer[]): Offer[] {
  const rank = (o: Offer) => (o.isEpub ? 0 : 1);
  const as = [...a].sort((x, y) => rank(x) - rank(y));
  const bs = [...b].sort((x, y) => rank(x) - rank(y));
  const out: Offer[] = [];
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    if (as[i]) out.push(as[i]!);
    if (bs[i]) out.push(bs[i]!);
  }
  // EPUBs ahead of everything else, order within each group preserved.
  return out.sort((x, y) => rank(x) - rank(y));
}
