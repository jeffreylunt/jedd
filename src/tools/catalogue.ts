import { ArrClient, type FetchImpl } from '../media/arr.js';
import { typeVerdict, type Candidate } from '../media/matching.js';
import { fail, ok, type Tool } from './types.js';

/**
 * "Can you get X?" — what COULD be added.
 *
 * 🔴 SEARCHES BOTH CATALOGUES, ALWAYS, AND NEVER GUESSES A TYPE.
 *
 * Measured over 806 real user turns, the modal request is **`verb + bare title`
 * with no type marker** — *"add whiplash"*, *"Get hook"*. The title is the whole
 * payload, so any code that decided film-or-show before searching would be
 * guessing on the majority of real traffic. V1 did exactly that and booked
 * *Moneyball (2021)*, a TV series, when the ask was the 2011 film.
 *
 * When a title matches plausibly in both, this returns AMBIGUOUS and says not to
 * add. That is a code rule rather than a model judgement, so the silent
 * cross-type add is unreachable for the shape of title that caused the defect.
 * A single-catalogue match is still the model's call — what is removed is the
 * *silent* error, not every error.
 */
export function makeCatalogueSearch(fetchImpl?: FetchImpl): Tool {
  return {
    name: 'catalogue_search',
    description:
      'Search what COULD be added to the library — films in Radarr and shows in Sonarr, both at once. ' +
      'Use this for "can you get X". Do NOT use it to answer "do you have X" — it searches the ' +
      'catalogue of addable things, not what is owned. If the result says AMBIGUOUS, the title exists ' +
      'as both a film and a show: present both and ask which they meant, and add neither.',
    minRole: 'guest',
    writes: false,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The title, as the person said it. Do not add a year or a type.' },
      },
      required: ['title'],
    },
    async run(args, ctx) {
      const title = typeof args['title'] === 'string' ? args['title'].trim() : '';
      if (!title) return fail('No title supplied.');

      const sonarr = new ArrClient({ ...ctx.config.sonarr, fetchImpl }, 'series');
      const radarr = new ArrClient({ ...ctx.config.radarr, fetchImpl }, 'movie');
      const [films, shows] = await Promise.all([radarr.catalogue(title), sonarr.catalogue(title)]);

      // 🔴 An unreachable catalogue is UNKNOWN. Reporting "nothing found" when
      // one side could not be searched is a false negative dressed as an answer.
      if (films.state === 'unknown' && shows.state === 'unknown') {
        return fail(
          `Could not search either catalogue, so this is UNKNOWN rather than "not available". ` +
            `Radarr: ${films.detail} Sonarr: ${shows.detail}`,
        );
      }
      if (films.state === 'unknown') {
        return fail(
          `Sonarr searched, but RADARR IS UNREACHABLE (${films.detail}), so I cannot say whether a ` +
            'FILM of this name exists. Report that gap rather than answering as if only shows exist.',
        );
      }
      if (shows.state === 'unknown') {
        return fail(
          `Radarr searched, but SONARR IS UNREACHABLE (${shows.detail}), so I cannot say whether a ` +
            'SHOW of this name exists. Report that gap rather than answering as if only films exist.',
        );
      }

      const verdict = typeVerdict(title, films.candidates, shows.candidates);
      switch (verdict.type) {
        case 'none':
          return ok(
            `NO MATCH — ${verdict.detail} (searched ${films.candidates.length} film and ` +
              `${shows.candidates.length} show result(s)).`,
          );
        case 'ambiguous':
          return ok(
            `AMBIGUOUS — ${verdict.detail}\n` +
              `  film:  ${describe(verdict.movie.best)}\n` +
              `  show:  ${describe(verdict.series.best)}`,
          );
        case 'movie':
          return ok(
            `FILM — ${describe(verdict.pick.best)} (radarr tmdbId ${verdict.pick.best.id}).` +
              contestedNote(films.candidates, verdict.pick.contested),
          );
        case 'series':
          return ok(
            `SHOW — ${describe(verdict.pick.best)} (sonarr tvdbId ${verdict.pick.best.id}).` +
              contestedNote(shows.candidates, verdict.pick.contested),
          );
      }
    },
  };
}

function describe(c: Candidate): string {
  return `${c.title}${c.year ? ` (${c.year})` : ''}`;
}

/**
 * When the runner-up is close, say so and list the options.
 *
 * A near-tie — *Dune (2021)* against *Dune (1984)* — is a question, not a pick.
 * Resolving it silently is how someone gets the wrong version of a film they
 * asked for by name.
 */
function contestedNote(all: Candidate[], contested: boolean): string {
  if (!contested) return '';
  const top = all
    .slice(0, 5)
    .map((c, i) => `${i + 1}. ${describe(c)}`)
    .join('; ');
  return (
    ' ⚠️ CONTESTED — another result matches almost as well, so do NOT add without asking. ' +
    `Present these and let them choose: ${top}`
  );
}
