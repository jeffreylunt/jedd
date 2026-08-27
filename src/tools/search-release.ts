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
import { matchWork, pinWork, relevantWorks, WORK_MATCH, type Work } from '../media/book-work.js';
import { describeWork, OpenLibraryClient, type OpenLibraryOptions } from '../media/openlibrary.js';
import { resolveOfKind } from '../choices.js';
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
function makeReleaseSearch(
  medium: 'audiobook' | 'ebook',
  fetchImpl?: FetchImpl,
  irc?: IrcEbooks,
  openLibrary?: OpenLibraryOptions,
): Tool {
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
      ? 'Search for an AUDIOBOOK — a book to LISTEN to. It works out WHICH BOOK they mean first, ' +
        'then CHOOSES the best release itself; do NOT list releases and do NOT ask which torrent ' +
        `they want. Then call ${consumer} to start it. If it comes back asking WHICH BOOK, show ` +
        'them those books and call this again with the same query and their number as `choice`. Do ' +
        'NOT say anything is downloading yet. Set graphic_audio true ONLY if they explicitly asked ' +
        'for a GraphicAudio dramatisation.'
      : 'Search for an EBOOK — a book to READ, delivered to their Kindle. It works out WHICH BOOK ' +
        'they mean first, then CHOOSES the best release itself; do NOT list releases and do NOT ask ' +
        `which torrent they want. Then call ${consumer}. If it comes back asking WHICH BOOK, show ` +
        'them those books and call this again with the same query and their number as `choice`. Do ' +
        'NOT say anything is being sent yet. Use search_audiobook instead if they want to LISTEN.',
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
    /**
     * 🔴 TWO KINDS OUT, BECAUSE THERE ARE TWO QUESTIONS AND ONLY ONE OF THEM IS
     * THE USER'S.
     *
     * `book-work` is *which book* — presented only when the catalogue cannot
     * settle it, and answered by a person. The release kind is *which copy*,
     * stored but never asked about: that one is decided here, on swarm health,
     * among releases that are copies of the pinned work.
     */
    presentsChoiceKinds: [isAudio ? 'audiobook-release' : 'ebook-release', 'book-work'],
    /**
     * 🔴 AND IT CONSUMES THE ONE IT PRODUCES. This tool is RE-ENTRANT: the first
     * call may hand back candidate works, and the answer comes back to this same
     * tool rather than to a second one.
     *
     * That is deliberate. The alternative — a `find_book` tool that presents
     * works and hands them on — makes the ebook flow THREE tool calls deep
     * (find → search → send) and adds a name to a registry where tool selection
     * was measured at 0/5 at production size on 2026-08-26. Re-entering one tool
     * keeps the flow two calls deep, exactly as it is today.
     */
    consumesChoiceKind: 'book-work',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: isAudio
            ? 'Title and author if known, e.g. "Project Hail Mary Andy Weir". Do NOT include the word "audiobook".'
            : 'Title and author if known, e.g. "Project Hail Mary Andy Weir". Do NOT include the word "book".',
        },
        choice: {
          type: 'number',
          description:
            'ONLY when this tool has just asked WHICH BOOK they meant and they answered: the number ' +
            'they picked. Leave it out on a first search. It is never a release number.',
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
       * ═══ STAGE ONE: WHICH BOOK ═══════════════════════════════════════════
       *
       * 🔴 THE WORK IS SETTLED BEFORE A SINGLE RELEASE IS RANKED, which is the
       * whole shape of the fix. See `book-work.ts` for the measurement and for
       * the honest limit on what pinning can buy on a filename index.
       *
       * ⚠️ RESOLVING THE PICK HAPPENS BEFORE THE CLEAR, AND THE ORDER IS LOAD
       * BEARING. The clear-on-start rule below exists so a stale list cannot be
       * picked from — but on the re-entrant call the pending list IS the one we
       * are being answered about. Clearing first would destroy the answer we
       * were just given, on every ambiguous book, every time.
       */
      let work: Work | undefined;
      const pick = args['choice'];
      if (pick !== undefined) {
        const n = Number(pick);
        if (!Number.isFinite(n)) return fail('That is not an option number.');
        const chosen = resolveOfKind(ctx.choices, ctx.senderHandle, n, 'book-work');
        if (!chosen.ok) {
          return fail(
            `${chosen.reason.toUpperCase()} — ${chosen.detail} Nothing was searched. If they were ` +
              'answering a list of BOOKS, search again by name; a release number does not belong here.',
          );
        }
        work = chosen.option.value['work'] as Work;
      }

      /**
       * 🔴 THE PENDING LIST DIES WHEN A NEW SEARCH **STARTS**, NOT WHEN ONE
       * SUCCEEDS. Same note as `fill-gaps.ts`, and the reason survived the
       * consumer losing its default:
       *
       * *search "Dune" (stored) → search "The Hobbit" (Prowlarr 500, UNKNOWN) →
       * "yeah, 2"* now resolves **2 from the DUNE list** and reports STARTED
       * naming a book nobody is talking about. The number is no longer optional,
       * but a number is not self-describing either — it means whatever list is
       * lying around.
       *
       * ⚠️ Clearing FIRST rather than in each early return is the point: the
       * branch someone forgets is the one that ships.
       */
      ctx.choices.clear(ctx.senderHandle);

      /**
       * 🔴 THE CATALOGUE IS AN IMPROVEMENT, NOT A DEPENDENCY.
       *
       * Every failure here degrades to the behaviour of 2.0.1 — present the
       * releases and ask which book — rather than taking the flow down. An
       * `unknown` from the catalogue is a failure to LOOK and must never become
       * "there is no such book": the fallback is the same either way, but the
       * wording the model is handed is not, and one of them is a lie.
       */
      let workNote = '';
      if (!work) {
        const found = await new OpenLibraryClient({
          baseUrl: ctx.config.openLibrary.baseUrl,
          ...openLibrary,
        }).works(query);
        if (found.state === 'works') {
          work = pinWork(query, found.works);
          /**
           * 🔴 CANDIDATES THAT SHARE NOTHING WITH THE REQUEST ARE NOT AN ANSWER.
           *
           * Live, 2026-08-27, *"that hobbit book"* came back with `Final
           * Planning Book` and `American Film` among the five. See
           * `relevantWorks`: presenting those asks somebody to choose which of
           * five wrong books they meant. When nothing plausible survives, the
           * catalogue genuinely could not settle it, and saying so is the
           * honest report — it takes the same fallback as an unreachable one.
           */
          const plausible = relevantWorks(query, found.works).slice(0, 5);
          if (!work && plausible.length === 0) {
            workNote = `the book catalogue returned nothing that looks like "${query}"`;
          } else if (!work) {
            /**
             * 🔴 THE ONE QUESTION WORTH ASKING, AND IT IS ABOUT BOOKS.
             *
             * Not a list of torrent filenames — a list of WORKS, with authors
             * and years, which is a question a person can actually answer. This
             * is the same shape `catalogue_search` already uses for a film and a
             * show that share a name, and Jeff has said that question is right.
             */
            ctx.choices.present({
              senderHandle: ctx.senderHandle,
              subject: query,
              kind: 'book-work',
              options: plausible.map((w, i) => ({
                n: i + 1,
                label: describeWork(w),
                value: { work: w as unknown as Record<string, unknown> },
              })),
            });
            return ok(
              `WHICH BOOK — "${query}" matches more than one book and nothing has been searched for ` +
                `yet:\n${plausible.map((w, i) => `  ${i + 1}. ${describeWork(w)}`).join('\n')}\n` +
                'Ask which one they meant. When they answer, call this same tool again with the same ' +
                'query and their number as `choice` — it will then choose the best release itself. ' +
                'If NONE of these is the book they want, say so plainly and ask for the author, then ' +
                'search again with the title and author together — do not talk them into one of ' +
                'these. Do NOT ask about torrents; that part is not their decision.',
            );
          }
        } else {
          // 'none' and 'unknown' both land here and are REPORTED differently by
          // the detail they carry. Neither is "no such book".
          workNote = found.detail;
        }
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
      /**
       * 🔴 ONCE A WORK IS PINNED, THE INDEXERS ARE ASKED ABOUT **THAT BOOK** AND
       * NOT ABOUT WHAT THE PERSON TYPED — FOUND BY RUNNING IT, 2026-08-27.
       *
       * *"Mistborn Brandon Sanderson"* is a SERIES name, so the catalogue could
       * not pin it and asked which book; the answer was *The Final Empire*. The
       * search then still ran on the original phrasing and came back with
       * `Mistborn Series 1-6`, `Mistborn Trilogy`, `Mistborn Complete Edition` —
       * every one of them correctly refused as a bundle, so the flow reported
       * NOT THE BOOK about a book that is plainly there. Measured, same minute:
       *
       *     "Mistborn Brandon Sanderson"       →  bundles only, 162 seeders top
       *     "The Final Empire Brandon Sanderson" →  The Final Empire by Brandon
       *                                             Sanderson EPUB, 30 seeders
       *
       * Scoring releases from a search that was never about the pinned work is
       * an identity filter applied to the wrong population. Asking a second time
       * would hammer Prowlarr (see its backoff note), so the ONE search it gets
       * is the one about the right book.
       *
       * ⚠️ Where the query already named the book — the measured Hobbit, Dune and
       * Project Hail Mary cases — the canonical term is the same string in a
       * different order, so nothing changes for them.
       */
      const term = work ? `${work.title} ${work.authors.slice(0, 1).join('')}`.trim() : query;

      const [ircFound, found] = await Promise.all([
        hasIrc
          ? irc!.search(term)
          : Promise.resolve({ state: 'none' as const, detail: 'IRC is not enabled here.' }),
        ctx.config.prowlarr.apiKey
          ? new ProwlarrClient({ ...ctx.config.prowlarr, fetchImpl }).search(
              term,
              isAudio ? CATEGORY.audiobook : CATEGORY.ebook,
            )
          : Promise.resolve({ state: 'none' as const, detail: 'Prowlarr is not configured here.' } as const),
      ]);

      let ircOffers: Offer[] = [];
      let ircNote = '';
      if (hasIrc) {
        if (ircFound.state === 'ok') {
          ircOffers = ircFound.results.map((r) => ircOffer(r, work));
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
      /**
       * ⚠️ THE `.slice(0, 5)` THAT USED TO BE HERE HAS MOVED BELOW THE WORK
       * SCORING, AND THAT IS A FIX RATHER THAN TIDYING.
       *
       * Truncating to five on SEEDERS before identity is considered would let
       * the defect survive its own fix on a busier title: five well-seeded
       * guides at the top and the novel sixth, cut before anything asked whether
       * it was the book. Measured on the Hobbit the novel came fourth, which is
       * inside five — by luck, not by design.
       */
      const torrentOffers: Offer[] = (isAudio ? rankAudiobooks(alive, { wantGraphicAudio: wantsGraphic }) : rankReleases(alive))
        .map((r) => ({
          label: describe(r),
          work: work ? matchWork(r.title, work).score : WORK_MATCH.PARTIAL,
          band: swarmRank(r.seeders),
          format: isAudio ? 0 : formatScore(r.title),
          seeders: r.seeders,
          value: { source: 'prowlarr', infoHash: r.infoHash, title: r.title, ...(r.magnetUri ? { magnetUri: r.magnetUri } : {}) },
        }));

      const merged = mergeSources(torrentOffers, ircOffers);

      /**
       * ═══ STAGE TWO: WHICH COPY ═══════════════════════════════════════════
       *
       * 🔴 A RELEASE THAT IS NOT THIS WORK IS NOT A CANDIDATE, whatever its
       * swarm. This is the line the Corey Olsen study guide fails on 24 seeders
       * while the novel passes on 8.
       */
      const wrongWork = work ? merged.filter((o) => o.work === WORK_MATCH.NOT_THIS_WORK) : [];
      const candidates = work ? merged.filter((o) => o.work !== WORK_MATCH.NOT_THIS_WORK) : merged;
      const top = candidates.slice(0, 5);

      /**
       * Everything was found and everything we can fetch is dead. Same two-zeros
       * rule as the filters above: say which, do not report absence.
       *
       * ⚠️ TESTED ON `merged`, NOT ON `top`, SO THAT THE WORK FILTER CANNOT
       * MASQUERADE AS A DEAD SWARM. "every copy is unseeded" and "none of these
       * is the book you asked for" are different findings with different next
       * moves, and collapsing them would report the wrong one whenever the
       * identity filter emptied the list.
       */
      if (merged.length === 0) {
        return ok(
          `ALL DEAD — found ${releases.length} ${medium} release(s) for "${query}" and every one has ` +
            'NO seeders, so none of them would ever finish. Nothing was chosen. Say so; do not say ' +
            'nothing was found.',
        );
      }

      /**
       * 🔴 THE WORK IS PINNED AND NOTHING ON OFFER IS A COPY OF IT.
       *
       * A third kind of zero, and the useful answer names the filter rather than
       * reporting absence — exactly the rule the GraphicAudio and dead-swarm
       * branches already follow. It also does NOT fall back to the unfiltered
       * list: quietly ranking the guides again the moment the filter finds
       * nothing is a fail-open, and it would fire on precisely the searches
       * where the filter was doing its job.
       */
      if (top.length === 0 && work) {
        return ok(
          `NOT THE BOOK — searching "${query}" returned ${merged.length} ${medium} release(s), and ` +
            `none of them is a copy of "${describeWork(work)}". They are things like: ` +
            `${wrongWork.slice(0, 3).map((o) => `${o.label.split(' — ')[0]} (${o.work === WORK_MATCH.NOT_THIS_WORK ? 'not that book' : 'partial'})`).join('; ')}. ` +
            'Tell them the book itself does not appear to be on the indexers — do NOT offer any of ' +
            'these instead, and do not say nothing was found.',
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
      if (wrongWork.length) notes.push(`${wrongWork.length} that are not that book left out`);
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
       * ── 🔴 SO WHICH BRANCH RUNS IS DECIDED BY WHETHER A WORK IS PINNED ────
       *
       * With a work: every candidate has been scored as a copy of THAT book, so
       * the question left is "which copy" and it is answered here, on the swarm.
       * Nobody is asked about a torrent — Jeff's rule, restored, and now resting
       * on the same precondition it always needed.
       *
       * Without one — the catalogue was unreachable, or knows no such book, or
       * the query names no work exactly — the precondition is absent and the
       * honest thing is the 2.0.1 behaviour: hand back the list and ask. That is
       * a DEGRADED path and it is labelled as one, so nobody reads a fallback as
       * the design.
       */
      if (work) {
        const best = top[0]!;
        return ok(
          `CHOSE — "${describeWork(work)}" is the book, and among the ${top.length} release(s) that ` +
            `are copies of it I took the healthiest swarm myself: ${best.label}${suffix}.\n` +
            'Do NOT list releases and do NOT ask which torrent they want — that choice is already ' +
            `made and it is not theirs. Call ${consumer} now with choice 1. Nothing is ` +
            `${isAudio ? 'downloading' : 'being sent'} yet.`,
        );
      }

      const lines = top.map((o, i) => `  ${i + 1}. ${o.label}`).join('\n');
      return ok(
        `FOUND ${top.length} for "${query}"${suffix}. ⚠️ The book catalogue could not settle which ` +
          `book this is${workNote ? ` — ${workNote}` : ''}, so these are ranked by swarm health ` +
          `alone. A ${medium} search matches on TEXT, so they are very likely DIFFERENT WORKS — a ` +
          'study guide, a companion, a boxed set, the book itself — and NOT copies of one book. ' +
          'Option 1 is NOT "the best one" in any sense that matters here.\n' +
          `${lines}\n` +
          'SHOW THEM THIS LIST and ASK WHICH BOOK THEY MEANT. Do not choose for them and do not ' +
          `assume option 1. If none of these is the book they want, say so and offer to search ` +
          `again with the author's name. Call ${consumer} ONLY once they have answered, with the ` +
          `number they chose. Nothing is ${isAudio ? 'downloading' : 'being sent'} yet.`,
      );
    },
  };
}

/**
 * ⚠️ `openLibrary` IS A TEST SEAM, and it is the reason these signatures grew a
 * parameter rather than the client being constructed from a module constant.
 * Without it every book test would reach the real openlibrary.org — slow,
 * flaky, and rude to a free service that asks callers to identify themselves.
 */
export function makeSearchAudiobook(fetchImpl?: FetchImpl, openLibrary?: OpenLibraryOptions): Tool {
  return makeReleaseSearch('audiobook', fetchImpl, undefined, openLibrary);
}

export function makeSearchEbook(
  fetchImpl?: FetchImpl,
  irc?: IrcEbooks,
  openLibrary?: OpenLibraryOptions,
): Tool {
  return makeReleaseSearch('ebook', fetchImpl, irc, openLibrary);
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
   * 🔴 IS THIS RELEASE A COPY OF THE PINNED WORK — **THE FIRST KEY, ABOVE THE
   * BAND**, and the one exception to `pick-release.ts`'s rule that swarm health
   * leads every release comparator.
   *
   * That rule forbids a QUALITY key above the band, and the reason is the Fringe
   * incident: a well-named release with an empty swarm is the worst option, not
   * the best. This is not a quality key. It answers whether the candidate is the
   * thing that was asked for AT ALL, which is a question that has to be settled
   * before "which of these is healthiest" means anything. A 24-seeder study
   * guide is not a better copy of The Hobbit than an 8-seeder novel; it is not a
   * copy of it.
   *
   * ⚠️ When no work could be pinned every offer gets the same value here, so the
   * key is inert and the order is exactly what it was before. It is never a
   * silent tiebreak.
   */
  work: number;
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

function ircOffer(r: IrcResult, work?: Work): Offer {
  const size = r.sizeBytes === undefined ? 'size unknown' : humanSize(r.sizeBytes);
  return {
    // The origin is visible to a human, so a pick is never ambiguous about where
    // it came from — and "via IRC" reads differently from a seeder count.
    label: `${r.title} — ${size}, via IRC (${r.bot})`,
    /**
     * 🔴 AN IRC OFFER IS SCORED FOR IDENTITY EXACTLY LIKE A TORRENT.
     *
     * Its band is a claim about MECHANISM — a bot holds the file or it does not
     * — and exempting it from the band was right for that reason. Exempting it
     * from the identity key would not be: a bot serving `Exploring The Hobbit by
     * Corey Olsen.epub` is holding a study guide in hand, and holding it firmly
     * changes nothing about which book it is. An unscored IRC offer would sit
     * above every torrent on the first key and walk straight past the filter.
     */
    work: work ? matchWork(r.title, work).score : WORK_MATCH.PARTIAL,
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
  return [...a, ...b].sort(byScore((o) => [o.work, o.band, o.format, o.seeders]));
}
