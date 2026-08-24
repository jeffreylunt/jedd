import type { FetchImpl } from '../media/arr.js';
import { TmdbClient, type TitleDetails, type TitleRef } from '../media/tmdb.js';
import { fail, ok, type Tool } from './types.js';

/**
 * "Tell me more about Lioness" — the question `whats_popular` made inevitable.
 *
 * ── 🔴 WHY THIS EXISTS, AND THE REASONING MISS THAT DELAYED IT ───────────────
 *
 * `whats_popular` shipped deliberately without descriptions, on the argument
 * that a TRUNCATED overview invites the model to complete a plot it only saw the
 * start of. That reasoning was right; the conclusion did not follow from it.
 * Minutes after shipping, live:
 *
 *   JEFF: "Can you tell me more about Lioness?"
 *   JEDD: "I can't pull a description or cast list — I've got no tool that
 *          returns that kind of detail."
 *
 * A tool that lets someone BROWSE makes *"what's that one?"* the near-certain
 * next question. The remedy for a dangerous truncation is **the whole text or
 * none**, not the absence of the capability.
 *
 * ── 🔴 A TYPED REFERENCE, NEVER A BARE ID ───────────────────────────────────
 *
 * TMDB's movie and tv ids are independent sequences, so a bare integer is half
 * an identifier and the missing half decides whether the answer is right or
 * confidently wrong. So this takes an ORDINAL from the list just shown, or a
 * TITLE — never a TMDB id. The model does not hold one at any point.
 *
 * ⚠️ AND `value.id` ON A SERIES IS A **TVDB** ID. `catalogue_search` stores
 * `{arr:'series', id: <tvdbId>}`. Feeding that to `/tv/{id}` would fetch a
 * different show and describe it in full confidence — the Moneyball failure
 * arriving through this door instead. **A show is therefore ALWAYS resolved by
 * title,** and the id on a series option is never read here. That is a code
 * rule, not a caution.
 */
export function makeTitleDetails(fetchImpl?: FetchImpl): Tool {
  return {
    name: 'title_details',
    description:
      'Look up what a film or show is ABOUT — plot, cast, genres, runtime or season count, rating. ' +
      'Use it for "tell me more about X", "what is that one about", "who is in it". If they are ' +
      'pointing at something from a numbered list you just showed, pass `choice` with that number. ' +
      'Otherwise pass `title` with what they called it. Do NOT pass an id — you never need one.',
    minRole: 'guest',
    writes: false,
    // Optional here — it also works from a bare title — but declared so the
    // dependency is visible and checked.
    consumesChoiceKind: 'media-choice',
    parameters: {
      type: 'object',
      properties: {
        choice: {
          type: 'number',
          description: 'The number they picked from the list you just showed. Prefer this when there is one.',
        },
        title: { type: 'string', description: 'The title, as they said it. Use when there is no list.' },
        kind: {
          type: 'string',
          enum: ['film', 'show'],
          description: 'Only if they made it clear which. Leave it out when you do not know.',
        },
      },
    },
    async run(args, ctx) {
      const token = ctx.config.tmdb.readToken;
      if (!token) {
        return fail('TMDB is not configured here, so I cannot look anything up. This is not "nothing is known".');
      }
      const client = new TmdbClient({ readToken: token, fetchImpl });

      const rawKind = typeof args['kind'] === 'string' ? args['kind'] : '';
      const kind = rawKind === 'film' || rawKind === 'show' ? rawKind : undefined;
      const askedTitle = typeof args['title'] === 'string' ? args['title'].trim() : '';
      const choice = Number(args['choice']);

      let ref: TitleRef | null = null;
      let resolvedNote = '';

      if (Number.isFinite(choice)) {
        if (!ctx.choices) return fail('No option store is available, so a numbered pick cannot be resolved.');
        const picked = ctx.choices.resolve(ctx.senderHandle, choice);
        if (!picked.ok) return fail(`${picked.reason.toUpperCase()} — ${picked.detail}`);

        const value = picked.option.value;
        const arr = String(value['arr'] ?? '');
        const pickedTitle = String(value['title'] ?? picked.option.label).trim();

        if (arr === 'movie') {
          // Radarr keys films by tmdbId and that IS the TMDB id, so this one is
          // safe to use directly — the only case that is.
          const id = Number(value['id']);
          if (Number.isFinite(id) && id > 0) ref = { media: 'film', tmdbId: id };
        }
        if (!ref) {
          /**
           * 🔴 EVERY OTHER CASE GOES THROUGH A NAME LOOKUP, INCLUDING A SERIES
           * THAT HAS AN `id`. On a series that id is a **tvdbId** and using it
           * would describe a different show with total confidence.
           */
          const year = Number(value['year']);
          const found = await client.find(
            pickedTitle,
            arr === 'series' ? 'show' : kind,
            Number.isFinite(year) ? year : null,
          );
          if (found.state === 'unknown') return fail(unknownDetail(found.detail));
          if (found.state === 'none') {
            return fail(`${found.detail} That was option ${choice}, "${pickedTitle}" — ask what they meant.`);
          }
          ref = found.ref;
          resolvedNote = describeResolution(found.title, found.year, found.alternates);
        }
      } else if (askedTitle) {
        const found = await client.find(askedTitle, kind);
        if (found.state === 'unknown') return fail(unknownDetail(found.detail));
        if (found.state === 'none') {
          // ⚠️ `found.detail` already names the title; prefixing our own sentence
          // printed it twice. The detail is the message.
          return fail(`${found.detail} Ask what they meant rather than guessing.`);
        }
        ref = found.ref;
        resolvedNote = describeResolution(found.title, found.year, found.alternates);
      } else {
        return fail('Give either the number they picked from a list, or the title they named.');
      }

      const answer = await client.details(ref);
      if (answer.state === 'unknown') return fail(unknownDetail(answer.detail));
      return ok(render(answer.details, resolvedNote));
    },
  };
}

function unknownDetail(detail: string): string {
  return (
    `UNKNOWN — could not get this from The Movie Database, so this is a gap rather than ` +
    `"there is nothing to tell": ${detail}. Say you could not look it up.`
  );
}

/**
 * What the name resolved to, said out loud.
 *
 * Measured: "Lioness" matches one show and three films on TMDB. A tool that
 * silently took the first would sound certain about a coin toss — so it names
 * what it picked and how many it did not, and the model can offer the others.
 */
function describeResolution(title: string, year: number | null, alternates: number): string {
  const named = `${title}${year ? ` (${year})` : ''}`;
  if (alternates <= 0) return `\nMatched "${named}" — the only thing of that name.`;
  return (
    `\nMatched "${named}", and TMDB lists ${alternates} other title(s) of the same name — ` +
    'if that is the wrong one, say so and offer to look again.'
  );
}

function render(d: TitleDetails, resolvedNote: string): string {
  const lines: string[] = [];
  const year = d.year ? ` (${d.year})` : '';
  lines.push(`${d.title}${year} — ${d.media}${d.status ? `, ${d.status}` : ''}`);
  if (d.tagline) lines.push(`Tagline: ${d.tagline}`);
  if (d.genres.length) lines.push(`Genres: ${d.genres.join(', ')}`);
  if (d.media === 'film') {
    if (d.runtimeMinutes) lines.push(`Runtime: ${d.runtimeMinutes} min`);
    if (d.madeBy.length) lines.push(`Director: ${d.madeBy.join(', ')}`);
  } else {
    if (d.seasons !== null) lines.push(`Seasons: ${d.seasons}${d.episodes ? `, ${d.episodes} episodes` : ''}`);
    if (d.networks.length) lines.push(`On: ${d.networks.join(', ')}`);
    if (d.madeBy.length) lines.push(`Created by: ${d.madeBy.join(', ')}`);
  }
  if (d.rating !== null) lines.push(`Rated ${d.rating}/10 from ${d.votes} votes`);

  /**
   * 🔴 THE OVERVIEW IS WHOLE OR ABSENT. There is no third rendering.
   *
   * An empty overview is a real answer — TMDB has none — and saying so is
   * different from having failed to ask. What must never appear is a cut one:
   * the model cannot tell a short paragraph from a severed one, and given the
   * front half of a plot it will supply the back half.
   */
  lines.push(d.overview ? `\n${d.overview}` : '\nTMDB lists no description for this one.');

  if (d.cast.length) {
    const shown = d.cast.map((c) => (c.character ? `${c.name} as ${c.character}` : c.name)).join('; ');
    // A LIST cap, and reported as one — the same rule as whats_popular's "10 of 20".
    const more = d.castTotal > d.cast.length ? ` (${d.cast.length} of ${d.castTotal} listed)` : '';
    lines.push(`\nCast${more}: ${shown}`);
  }
  return `${lines.join('\n')}${resolvedNote}`;
}
