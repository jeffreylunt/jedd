import { byScore, describeSwarm, swarmHealth, swarmRank } from '../media/pick-release.js';
import {
  CATEGORY,
  GRAPHIC_AUDIO,
  ProwlarrClient,
  rankAudiobooks,
  rankReleases,
  type FetchImpl,
  type Release,
} from '../media/prowlarr.js';
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
      ? 'Search for an AUDIOBOOK — a book to LISTEN to. It returns a NUMBERED LIST, because a book ' +
        'search matches on free text and the results are usually DIFFERENT WORKS — a study guide, a ' +
        'boxed set, the actual novel. Show them the list and ASK WHICH BOOK THEY MEANT. When they ' +
        `answer, call ${consumer} with that number. Do NOT say anything is downloading yet — ` +
        'nothing is until that runs. Set graphic_audio true ONLY if they explicitly asked for a ' +
        'GraphicAudio dramatisation.'
      : 'Search for an EBOOK — a book to READ, delivered to their Kindle. It returns a NUMBERED ' +
        'LIST, because a book search matches on free text and the results are usually DIFFERENT ' +
        'WORKS — a study guide, a boxed set, the actual novel. Show them the list and ASK WHICH ' +
        `BOOK THEY MEANT. When they answer, call ${consumer} with that number. Do NOT say anything ` +
        'is being sent yet. Use search_audiobook instead if they want to LISTEN.',
    minRole: 'guest',
    /**
     * ⚠️ A READ. It searches indexers and stores a list; nothing is grabbed and
     * nothing is sent until the consumer runs. Marking it a write would remove
     * the producer in read-only mode and take the whole flow down with it —
     * which is the same shape as the bug this file exists to fix.
     */
    writes: false,
    /**
     * 🔴 TWO KINDS, NOT ONE, AND THE SPLIT IS A SAFETY GUARD.
     *
     * Both media used to present `release`. `add_audiobook` reads an `infoHash`
     * off whatever it resolves and hands it to qBittorrent under the AUDIOBOOK
     * category — with no shape check of any kind — so a pending EBOOK list was
     * fully resolvable by it, and a `.epub` landed in `/downloads/audiobooks`
     * where the host cron feeds it to Audiobookshelf. It reported STARTED.
     *
     * `sonarr-release` was already split from `release` for exactly this reason
     * and said so in `fill-gaps.ts`; this is the same argument, one level in.
     */
    presentsChoiceKinds: [isAudio ? 'audiobook-release' : 'ebook-release'],
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

      // 🔴 See the same note in `fill-gaps.ts`: the pending list dies when a new
      // search STARTS, because the consumer now defaults to option 1 and every
      // early return below would otherwise leave a stale one grabbable.
      ctx.choices.clear(ctx.senderHandle);

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

      /**
       * 🔴 A DEAD TORRENT IS NEVER A CANDIDATE NOW THAT NOBODY IS ASKED.
       *
       * While a person picked from a list, a 0-seeder release at the bottom was
       * merely a bad option they would not take. A comparator that picks
       * silently can take it, and the Fringe pool is what that costs: 60 hours,
       * zero bytes. So it is FILTERED, and counted rather than dropped quietly —
       * "found nothing" and "found only things that will never finish" are
       * different answers. IRC offers are unaffected: a DCC transfer has no
       * swarm to be dead.
       */
      const alive = releases.filter((r) => swarmHealth(r.seeders) !== 'dead');
      const deadCount = releases.length - alive.length;

      /**
       * 🔴 THE AUDIOBOOK RANKER IS THE ONE WITH A QUALITY KEY UNDER THE BAND.
       *
       * `rankReleases` orders on the band and then on seeders, which — with no
       * third key — is the same ORDER as sorting on seeders alone. That makes
       * its band decorative on its own, and a decorative rule is one nobody
       * notices deleting. `rankAudiobooks` puts `unabridged` UNDER the band, so
       * an abridged copy that people are actually seeding beats an unabridged
       * one that nobody is — which is the whole rule, stated where it bites.
       *
       * ⚠️ It had NO caller in the repo until now: written, tested, unused. That
       * is the same shape as `add_audiobook` shipping with no producer.
       *
       * Ebooks keep `rankReleases` because their quality key is FORMAT, and
       * `interleave` below applies it across both sources at once.
       */
      const torrentOffers: Offer[] = (isAudio ? rankAudiobooks(alive, { wantGraphicAudio: wantsGraphic }) : rankReleases(alive))
        .slice(0, 5)
        .map((r) => ({
          label: describe(r),
          band: swarmRank(r.seeders),
          format: isAudio ? 0 : formatScore(r.title),
          seeders: r.seeders,
          value: { source: 'prowlarr', infoHash: r.infoHash, title: r.title, ...(r.magnetUri ? { magnetUri: r.magnetUri } : {}) },
        }));

      const top = mergeSources(torrentOffers, ircOffers).slice(0, 5);

      // Everything was found and everything we can fetch is dead. Same two-zeros
      // rule as the filters above: say which, do not report absence.
      if (top.length === 0) {
        return ok(
          `ALL DEAD — found ${releases.length} ${medium} release(s) for "${query}" and every one has ` +
            'NO seeders, so none of them would ever finish. Nothing was chosen. Say so; do not say ' +
            'nothing was found.',
        );
      }

      ctx.choices.present({
        senderHandle: ctx.senderHandle,
        subject: query,
        // 🔴 The kind the consumer declares it needs. See types.ts and the
        // note on presentsChoiceKinds above.
        kind: isAudio ? 'audiobook-release' : 'ebook-release',
        options: top.map((o, i) => ({ n: i + 1, label: o.label, value: o.value })),
      });

      const notes: string[] = [];
      if (deadCount) notes.push(`${deadCount} with no seeders left out (they would never finish)`);
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

      /**
       * ── 🔴 THE BOOK PATHS ASK. THE EPISODE PATH DOES NOT. ──────────────────
       *
       * Jeff's rule — *"don't give users a choice of which torrent to choose,
       * just choose the best one"* — is a rule about choosing between COPIES OF
       * ONE THING, and it is right wherever that is what the candidates are.
       *
       * `search_episode` is safe by construction: it takes a title, a season and
       * an episode, resolves them against Sonarr to ONE `episodeId`, and asks
       * Sonarr for the releases OF THAT EPISODE. Every candidate is an encoding
       * of the same work, so ranking answers **"which copy"** and swarm health
       * is exactly the right instrument.
       *
       * These two tools take FREE TEXT. Prowlarr and the IRC bots return
       * whatever loosely matches it, so the candidates are **different works**
       * and ranking is being asked **"which thing"** — a question a seeder count
       * cannot answer and was never asked to.
       *
       * ⚠️ MEASURED, LIVE, 2026-08-27. *"The Hobbit J.R.R. Tolkien"* ranked:
       * (1) a Corey Olsen **study guide**, 24 seeders — AUTO-PICKED; (2) a
       * 1937-2017 booklet, 10; (3) **the actual novel**, 8; (4) a four-book
       * collection, 8; (5) LotR+Hobbit, 6. **The ranking was correct.** The
       * top-ranked release was not the book, and no reordering fixes that,
       * because the defect is in the question.
       *
       * The only thing that caught it was the model noticing and refusing to
       * send the study guide — enforcement by a reader, which is what
       * `search_episode`'s old *"do NOT grab 4K"* description was before it
       * became a filter in code. So the list is RETURNED, and the consumer
       * below refuses to act without a number.
       *
       * ⚠️ THIS IS THE INTERIM SHAPE, and it is worse than the fix it stands in
       * for: it hands back a list that mixes "which work" and "which copy" into
       * one question. The fix is to resolve the WORK first — the two-stage shape
       * `add_movie`/`add_series` already have with `tmdbId`/`tvdbId` — and then
       * auto-pick on swarm health among that work's releases only, which is
       * Jeff's rule restored exactly. Do not delete this note when the list goes
       * away; delete it when the work is pinned before the ranking.
       */
      const lines = top.map((o, i) => `  ${i + 1}. ${o.label}`).join('\n');
      return ok(
        `FOUND ${top.length} for "${query}"${suffix}. These are ranked by swarm health, but a ` +
          `${medium} search matches on TEXT, so they are very likely DIFFERENT WORKS — a study ` +
          'guide, a companion, a boxed set, the book itself — and NOT copies of one book. Option 1 ' +
          'is NOT "the best one" in any sense that matters here.\n' +
          `${lines}\n` +
          'SHOW THEM THIS LIST and ASK WHICH BOOK THEY MEANT. Do not choose for them and do not ' +
          `assume option 1. If none of these is the book they want, say so and offer to search ` +
          `again with the author's name. Call ${consumer} ONLY once they have answered, with the ` +
          `number they chose. Nothing is ${isAudio ? 'downloading' : 'being sent'} yet.`,
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
  // 🔴 THE SAME REGEX THE CLASSIFIER USES. Two copies drifted and the narrower
  // one let spellings through the filter that then scored 0 on the ranker.
  return GRAPHIC_AUDIO.test(r.title);
}

function describe(r: Release): string {
  return `${r.title} — ${humanSize(r.sizeBytes)}, ${describeSwarm(r.seeders)}, ${r.indexer}`;
}

function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'size unknown';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

interface Offer {
  label: string;
  /**
   * The swarm band, higher is better — `swarmRank` for a torrent.
   *
   * 🔴 AN IRC OFFER IS BANDED `healthy`, AND THAT IS A CLAIM ABOUT MECHANISM.
   * A DCC transfer has no swarm to be dead: a bot either holds the file and
   * sends it, or it does not answer. Leaving it unbanded would have made a
   * one-seeder torrent outrank a bot that has the book in hand.
   */
  band: number;
  /**
   * Format sanity, higher is better. **A SECOND KEY THAT SITS UNDER THE BAND**,
   * which is the only place a quality judgement is allowed to live.
   */
  format: number;
  /** For the tiebreak only; 0 for IRC, which has no seeder count. */
  seeders: number;
  value: Record<string, unknown>;
}

/**
 * How Kindle-ready a filename looks.
 *
 * ⚠️ THIS WAS THE MODEL'S JOB UNTIL NOBODY WAS PICKING ANY MORE. While a person
 * read the numbered list, the model chose something that was actually a book.
 * A comparator does not: `Dune.Complete.Series.rar` with 90 seeders beat
 * `Dune.azw3` with 8 the moment the format key was only `.epub`-or-not.
 *
 * The accepted set is `ebook-validate.ts`'s `EbookFormat` — the formats that
 * survive validation on the way out. `.mobi` scores 0 rather than being ranked
 * as a book at all: Amazon has rejected it silently since 2022, and `send_ebook`
 * re-chooses away from one anyway.
 */
function formatScore(title: string): number {
  if (/\.epub\b/i.test(title)) return 2;
  if (/\.(azw3|pdf)\b/i.test(title)) return 1;
  return 0;
}

function ircOffer(r: IrcResult): Offer {
  const size = r.sizeBytes === undefined ? 'size unknown' : humanSize(r.sizeBytes);
  return {
    // The origin is visible to a human, so a pick is never ambiguous about where
    // it came from — and "via IRC" reads differently from a seeder count.
    label: `${r.title} — ${size}, via IRC (${r.bot})`,
    // See `Offer.band`: a DCC transfer has no swarm, so it is not a thin one.
    band: swarmRank(HEALTHY_IRC_BAND),
    format: formatScore(r.ext === '.epub' ? 'x.epub' : r.title),
    seeders: 0,
    // 🔴 The command is stored VERBATIM. It is what the bot expects to see back,
    // and reconstructing it from the label would be the classic way to break it.
    value: { source: 'irc', command: r.command, bot: r.bot, title: r.title },
  };
}

/** Any positive count banded `healthy`; see `Offer.band` for why IRC gets one. */
const HEALTHY_IRC_BAND = 999;

/**
 * One list, both sources, ONE COMPARATOR.
 *
 * ── 🔴 WHY THIS IS NOT THE INTERLEAVE IT REPLACED ───────────────────────────
 *
 * The old merge alternated the two sources and then re-sorted the whole thing on
 * `isEpub`. That trailing sort was the FINAL comparator, it had no swarm term,
 * and `top[0]` is what gets grabbed — so on the ebook path the shipped code
 * chose a 1-seeder `.epub` over a 500-seeder `.azw3` **while printing "leading
 * on swarm health"**. Ranking then re-ranking is how a first key stops being
 * first, and it is the exact ordering `pick-release.ts` exists to forbid.
 *
 * So there is one score vector, band first, and the merge no longer decides
 * anything: sources are concatenated and the comparator sorts them together.
 *
 * ⚠️ The interleave existed for a real reason — Prowlarr's ebook coverage is
 * thin (7 results where IRC had 27, measured 2026-08-26) and appending IRC after
 * five torrent rows pushed every IRC result off a five-item list. That reason
 * DIES with the numbered list: nothing is truncated for display any more, and
 * IRC offers now compete on the band rather than on their position.
 */
function mergeSources(a: Offer[], b: Offer[]): Offer[] {
  return [...a, ...b].sort(byScore((o) => [o.band, o.format, o.seeders]));
}
