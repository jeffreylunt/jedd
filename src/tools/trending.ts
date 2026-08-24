import type { FetchImpl } from '../media/arr.js';
import { POPULAR_KINDS, TmdbClient, popularLabel, type PopularItem, type PopularKind } from '../media/tmdb.js';
import { fail, ok, type Tool } from './types.js';

/**
 * "What's popular?" — what the WORLD is watching, which no arr can answer.
 *
 * The three media tools now cover three different questions and none of them
 * substitutes for another:
 *   - `library_search`    — do WE have it?           (owned)
 *   - `catalogue_search`  — can we GET it?           (addable, by title)
 *   - `whats_popular`     — what is everyone watching? (browse, no title)
 *
 * The third is the one V1 and early V2 could not do at all: both required the
 * person to NAME a title first, so *"what should I watch"* had no path.
 *
 * ── ONE TOOL, NOT FIVE ───────────────────────────────────────────────────────
 *
 * Jeff: *"keep it light and simple. Rely on the smarts of the model."* So there
 * is one tool with one enum, and no ranking, filtering, formatting or
 * recommendation logic anywhere in it. TMDB's own ordering is passed through
 * untouched and the model decides what to say about it.
 *
 * ── 🔴 THE ID IS ONLY DIRECTLY ADDABLE FOR FILMS ─────────────────────────────
 *
 * Radarr keys films by **tmdbId**, which is the same id TMDB returns — so a film
 * option flows straight into `add_movie` with no second lookup, and its stored
 * value is byte-identical to the one `catalogue_search` stores.
 *
 * Sonarr keys shows by **tvdbId**, a DIFFERENT id space. Both are small
 * integers, so a TMDB show id passed to `add_series` would not error — it would
 * quietly add **a different show**. That is the Moneyball defect in a new
 * costume, so a show's stored option deliberately has **no `id` field at all**:
 * the value that would be misused is absent by construction, and the route back
 * to an addable id is named in its place.
 */
export function makeTrending(fetchImpl?: FetchImpl): Tool {
  return {
    name: 'whats_popular',
    description:
      'Browse what is popular or trending right now, from The Movie Database. Use this when someone ' +
      'asks what is popular, what is trending, what is new, or what they should watch — anything ' +
      'where they have NOT named a title. It says what the world is watching; it does not say what ' +
      'this library owns (library_search) or what can be added (catalogue_search). Films come back ' +
      'with a tmdbId that add_movie takes directly. SHOWS DO NOT: a show needs a tvdbId, so run ' +
      'catalogue_search on its title first and never pass a tmdbId to add_series.',
    minRole: 'guest',
    writes: false,
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: POPULAR_KINDS,
          description:
            'Which list. "trending" mixes films and shows and is the right default for a vague ask. ' +
            'Use trending_movies/trending_shows when they asked about one or the other, and ' +
            'popular_movies/popular_shows for "popular" as opposed to "this week".',
        },
      },
      required: ['kind'],
    },
    async run(args, ctx) {
      const raw = typeof args['kind'] === 'string' ? args['kind'].trim() : '';
      const kind = (raw || 'trending') as PopularKind;
      if (!POPULAR_KINDS.includes(kind)) {
        return fail(`"${raw}" is not a list I can ask for. Choose one of: ${POPULAR_KINDS.join(', ')}.`);
      }

      const token = ctx.config.tmdb.readToken;
      if (!token) {
        return fail('TMDB is not configured here, so I cannot see what is popular. This is not "nothing is popular".');
      }

      const answer = await new TmdbClient({ readToken: token, fetchImpl }).popular(kind);

      // 🔴 An unreachable TMDB is UNKNOWN. "Nothing is trending" is never true and
      // would be indistinguishable, to the person reading it, from a real answer.
      if (answer.state === 'unknown') {
        return fail(
          `Could not reach The Movie Database, so this is UNKNOWN rather than "nothing is popular": ` +
            `${answer.detail}. Say you could not check.`,
        );
      }
      if (answer.items.length === 0) {
        return ok(`TMDB answered for ${popularLabel(kind)} but listed nothing addable.`);
      }

      /**
       * Record the options as a side effect of producing them — the same
       * mechanism `catalogue_search` uses, deliberately not a parallel one. The
       * list must survive to the next message so *"add the third one"* resolves
       * through `resolve_choice`, and it survives because the tool that made it
       * stored it, not because the model remembered to.
       */
      if (ctx.choices) {
        ctx.choices.present({
          senderHandle: ctx.senderHandle,
          subject: popularLabel(kind),
          kind: 'media-choice',
          options: answer.items.map((i) => ({ n: i.rank, label: describe(i), value: optionValue(i) })),
        });
      }

      const lines = answer.items.map((i) => `  ${i.rank}. ${describe(i)}`).join('\n');
      return ok(
        `${popularLabel(kind).toUpperCase()} — TMDB's order, unchanged:\n${lines}\n` +
          '(offer these as a numbered list; resolve_choice maps a later pick back. ' +
          'A film can go straight to add_movie with its tmdbId; a show needs catalogue_search first.)',
      );
    },
  };
}

function describe(i: PopularItem): string {
  const year = i.year ? ` (${i.year})` : '';
  const rating = i.rating === null ? '' : `, rated ${i.rating}`;
  const id = i.media === 'film' ? `tmdbId ${i.tmdbId}` : `tmdbId ${i.tmdbId}, NOT a tvdbId`;
  return `${i.title}${year} — ${i.media}${rating} [${id}]`;
}

/**
 * What `resolve_choice` hands back when this option is picked.
 *
 * A film's shape matches `catalogue_search`'s exactly, so the add path is
 * identical whichever tool produced the list. A show gets `tmdbId` and no `id`,
 * plus the route to the id it actually needs.
 */
function optionValue(i: PopularItem): Record<string, unknown> {
  if (i.media === 'film') return { arr: 'movie', id: i.tmdbId, title: i.title };
  return {
    arr: 'series',
    title: i.title,
    tmdbId: i.tmdbId,
    needs: 'a tvdbId — call catalogue_search with this title; do NOT pass tmdbId to add_series',
  };
}
