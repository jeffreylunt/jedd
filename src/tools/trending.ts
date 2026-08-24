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
 * ── 🔴 A SHOW'S TMDB ID IS NOT EMITTED AT ALL ────────────────────────────────
 *
 * Radarr keys films by **tmdbId**, which is the same id TMDB returns — so a film
 * option flows straight into `add_movie` with no second lookup, and its stored
 * value is byte-identical to the one `catalogue_search` stores.
 *
 * A show's id is a different matter, in two ways that compound:
 *
 *  - Sonarr keys shows by **tvdbId**, a different id space of similarly small
 *    integers. A TMDB show id passed to `add_series` would not error; it would
 *    quietly add **a different show**.
 *  - Worse, and less obvious: TMDB's movie and tv ids are **separate
 *    sequences**, so tv id 1396 and movie id 1396 are both real and unrelated.
 *    A show's tmdbId is therefore a *valid and wrong* argument to `add_movie`,
 *    which nothing forbids — and calling it "a tmdbId" invites exactly that.
 *
 * So the number is **not emitted anywhere** for a show: not in the rendered
 * line, not in the stored label, not in the option value. An earlier version
 * kept it under a renamed key with a warning beside it, which is the shape this
 * codebase refuses everywhere else — a sentence guarding a live footgun. What
 * remains is the title, which is what `catalogue_search` takes, so nothing an
 * add actually needs was lost.
 */
export function makeTrending(fetchImpl?: FetchImpl): Tool {
  return {
    name: 'whats_popular',
    description:
      'Browse what is popular or trending right now, from The Movie Database. Use this when someone ' +
      'asks what is popular, what is trending, what is new, or what they should watch — anything ' +
      'where they have NOT named a title. It says what the world is watching; it does not say what ' +
      'this library owns (library_search) or what can be added (catalogue_search). Films come back ' +
      'with a tmdbId that add_movie takes directly. Shows come back with no id at all, because ' +
      'add_series needs a tvdbId from a different id space — to add a show, call catalogue_search ' +
      'with its title.',
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
      /**
       * 🔴 TWO DIFFERENT ZEROS, AND ONLY ONE OF THEM IS AN ANSWER.
       *
       * A filter that rejects 100% of a non-empty input has not found that
       * nothing is popular — it has failed to recognise anything, which is a
       * TMDB field rename (`media_type`, `id`, `title`/`name`) we have not
       * noticed yet. Twenty real titles in and "nothing addable" out is the same
       * false negative as the missing-`results` case one level up, and it must
       * be UNKNOWN for the same reason.
       *
       * `considered === 0` is the honest empty list, and stays an answer.
       */
      if (answer.items.length === 0 && answer.considered > 0) {
        return fail(
          `UNKNOWN — TMDB returned ${answer.considered} row(s) for ${popularLabel(kind)} and NONE of ` +
            `them parsed, which means the response shape has changed rather than that nothing is ` +
            `popular. First row's fields: ${answer.sampleKeys.join(', ') || '(none)'}. Say you could not check.`,
        );
      }
      if (answer.items.length === 0) {
        return ok(`TMDB answered for ${popularLabel(kind)} and its list was empty.`);
      }

      /**
       * Record the options as a side effect of producing them — the same
       * mechanism `catalogue_search` uses, deliberately not a parallel one. The
       * list must survive to the next message so *"add the third one"* resolves
       * through `resolve_choice`, and it survives because the tool that made it
       * stored it, not because the model remembered to.
       *
       * ⚠️ A new list REPLACES any pending one for this sender (see
       * `ChoiceStore.present`). This tool is the one most likely to be called
       * mid-flow — *"what else is popular?"* — so it is also the one most likely
       * to invalidate a `catalogue_search` list the person is still deciding on.
       * That is the intended behaviour (two live lists make a bare "2"
       * unanswerable), noted here because it is a real consequence.
       *
       * 🔴 The hint that a pick can be resolved is emitted ONLY when the list was
       * actually stored. A tool must never promise a continuation it did not
       * manage to record — the same rule `watchIt()` follows for follow-ups.
       */
      let hint = '';
      if (ctx.choices) {
        ctx.choices.present({
          senderHandle: ctx.senderHandle,
          subject: popularLabel(kind),
          kind: 'media-choice',
          options: answer.items.map((i) => ({ n: i.rank, label: describe(i), value: optionValue(i) })),
        });
        hint =
          '\n(offer these as a numbered list; resolve_choice maps a later pick back. A film can go ' +
          'straight to add_movie with its tmdbId; for a show, call catalogue_search with its title.)';
      }

      const lines = answer.items.map((i) => `  ${i.rank}. ${describe(i)}`).join('\n');
      const shown =
        answer.items.length < answer.considered
          ? ` (${answer.items.length} of the ${answer.considered} rows TMDB returned)`
          : '';
      return ok(`${popularLabel(kind).toUpperCase()}${shown} — TMDB's order, unchanged:\n${lines}${hint}`);
    },
  };
}

function describe(i: PopularItem): string {
  const year = i.year ? ` (${i.year})` : '';
  // "/10" so the scale is stated rather than left for the model to supply.
  const rating = i.rating === null ? '' : `, rated ${i.rating}/10`;
  // 🔴 Films only. See the header: a show's tmdbId is not printed anywhere.
  const id = i.media === 'film' ? ` [tmdbId ${i.tmdbId}]` : '';
  return `${i.title}${year} — ${i.media}${rating}${id}`;
}

/**
 * What `resolve_choice` hands back when this option is picked.
 *
 * A film's shape matches `catalogue_search`'s exactly, so the add path is
 * identical whichever tool produced the list. A show carries **no number at
 * all** — only the title, which is the argument `catalogue_search` takes.
 */
function optionValue(i: PopularItem): Record<string, unknown> {
  if (i.media === 'film') return { arr: 'movie', id: i.tmdbId, title: i.title };
  /**
   * ⚠️ `year` and NOT an id. A show still emits no number that could be
   * misrouted — a year cannot be mistaken for a tmdbId or a tvdbId by anything.
   * It is here because `title_details` resolves a show by NAME, and "Lioness"
   * matches one show and three films on TMDB; the year is what picks correctly
   * without reintroducing the id.
   */
  return {
    arr: 'series',
    title: i.title,
    year: i.year ?? undefined,
    needs: 'a tvdbId — call catalogue_search with this title',
  };
}
