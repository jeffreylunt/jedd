// The Ollama backend for Jedd — the one and only LLM engine. Runs a NATIVE function-calling
// loop against Ollama (default qwen2.5:7b). Ports the working experiment harness
// (experiments/local-tooluse/) to production:
//   - recoverToolCalls(): some models emit tool calls as JSON text in message.content
//     with tool_calls empty — recover them, or the model looks broken when it isn't.
//   - capabilities-first system prompt (v2): a verbose access-control block made the
//     small model refuse legit requests. Narrowed to the off-topic case only.
//   - safety nets for the small model's failure modes (see end of runLocalSession):
//     promise-without-execute, claims-add-without-executing, refusal-without-searching
//     (history poisoning — repeated prior "couldn't find" turns make it mimic the refusal).
// The tools are wired to the REAL Sonarr/Radarr APIs via arr-client.ts. Adds emit a
// <!--JOB:--> tag so the scheduler picks up follow-up tracking. On error, session-manager
// catches and replies with a friendly error — there is no secondary backend.

import { config, isOwner, type DownloadJob } from './config.js';
import {
  searchRadarr, addRadarrMovie, checkMovieExists, getRadarrQueue,
  searchSonarr, addSonarrSeries, checkSeriesExists, getSonarrQueue,
} from './arr-client.js';
import { systemPromptV2 as buildSystemPrompt, promisesActionWithoutTool, claimsAddWithoutExecuting, refusesWithoutSearching, claimsResultsWithoutSearching, stallsWithoutTool, isStatusQuery, extractStatusTitle, stallsOnStatus, isStallReply, asksWhichOne, topResultIsDominant, parseSeasonSelection, topResultAlreadyInLibrary, parseInlineToolCall, looksLikeRawToolCall } from './local-prompt.js';
import type { RadarrMovie, SonarrSeries } from './types.js';

export { promisesActionWithoutTool, claimsAddWithoutExecuting, refusesWithoutSearching, claimsResultsWithoutSearching, stallsWithoutTool, isStatusQuery, extractStatusTitle, stallsOnStatus, isStallReply, asksWhichOne, topResultIsDominant, parseSeasonSelection, topResultAlreadyInLibrary, parseInlineToolCall, looksLikeRawToolCall };

// Active local model + Ollama URL come from config.ollama (env: LOCAL_MODEL / OLLAMA_URL,
// default qwen2.5-coder:14b — the benchmark winner). Swap the model without a code change.
const OLLAMA_URL = config.ollama.url;
const OLLAMA_MODEL = config.ollama.model;
// Leaves room for the longest forced-recovery chain: bad-id add → forced search (stall) →
// stall-retry → real search → add → final reply. The multi-turn Severance bug (2026-05-22) needed
// an extra hop for a stall-after-force ("I'm searching now, hang on") that must be re-driven.
const MAX_TOOL_HOPS = 8;
const OLLAMA_TIMEOUT_MS = 120000; // 2 min — generous for a few ~4s turns + arr API calls

// --- Tool schema (native function-calling), mirrors experiments/local-tooluse/tools.mjs ---

const tools = [
  {
    type: 'function',
    function: {
      name: 'search_movie',
      description: 'Search for a movie by title to find it before adding. Returns matching movies with their tmdb_id, year, and whether already in the library. If the user named a specific year (e.g. "the 2025 one"), ALWAYS pass it as the year param so the results are narrowed to that year — do not search the bare title again.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The movie title to search for, e.g. "Dune Part Two"' },
          year: { type: 'integer', description: 'Optional release year. Pass this whenever the user specified a year (or you already know it from a prior result) to collapse same-title results to that one year.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_tv',
      description: 'Search for a TV show by title to find it before adding. Returns matching shows with their tvdb_id, year, and season_count. If the user named a specific year, ALWAYS pass it as the year param to narrow results.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The TV show title to search for, e.g. "The Bear"' },
          year: { type: 'integer', description: 'Optional first-air year. Pass this whenever the user specified a year to collapse same-title results.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_movie',
      description: 'Add a movie to the download library and start searching for it. Only call after search_movie returns a match. Use the tmdb_id from the search result.',
      parameters: {
        type: 'object',
        properties: {
          tmdb_id: { type: 'integer', description: 'The tmdb_id from the search_movie result' },
          title: { type: 'string', description: 'The movie title' },
        },
        required: ['tmdb_id', 'title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_tv',
      description: 'Add a TV show to the download library and start searching. Only call after search_tv. For shows with 3+ seasons, you MUST ask the user which seasons first and pass the seasons array; do not call this until they answer.',
      parameters: {
        type: 'object',
        properties: {
          tvdb_id: { type: 'integer', description: 'The tvdb_id from the search_tv result' },
          title: { type: 'string', description: 'The show title' },
          seasons: {
            type: 'array',
            items: { type: 'integer' },
            description: 'Season numbers to download. Omit to grab all seasons (only for shows with <3 seasons, or after the user said "all").',
          },
        },
        required: ['tvdb_id', 'title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_status',
      description: "Check the download status of the user's previously requested media. Use when the user asks if something is ready yet or how a download is coming along.",
      parameters: {
        type: 'object',
        properties: { title: { type: 'string', description: 'Optional title to check; omit to list all active downloads.' } },
        required: [],
      },
    },
  },
];

const TOOL_NAMES = new Set(tools.map(t => t.function.name));

// systemPromptV2 + promisesActionWithoutTool now live in ./local-prompt so the offline
// scenario harness imports the EXACT shipped prompt and safety-net (no drift between what
// we benchmark and what runs live).

// --- Tool-call recovery (ported verbatim from harness.mjs) ---
// Pull {name, arguments} objects out of free-text content. Handles bare JSON, fenced
// ```json blocks, <tool_call>...</tool_call> wrappers, AND a JSON object embedded after
// prose via brace-matching. This single fix took qwen2.5-coder from 22% -> 56%.

interface RecoveredCall { function: { name: string; arguments: Record<string, unknown> } }

function recoverToolCalls(content: string): RecoveredCall[] {
  const out: RecoveredCall[] = [];
  const candidates: string[] = [];
  for (const m of content.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) candidates.push(m[1]);
  for (const m of content.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(m[1]);
  candidates.push(content.trim());
  for (let i = 0; i < content.length; i++) {
    if (content[i] !== '{') continue;
    let depth = 0;
    for (let j = i; j < content.length; j++) {
      if (content[j] === '{') depth++;
      else if (content[j] === '}') { depth--; if (depth === 0) { candidates.push(content.slice(i, j + 1)); i = j; break; } }
    }
  }
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c);
      const arr = Array.isArray(obj) ? obj : [obj];
      for (const o of arr as any[]) {
        const name = o.name || o.tool || o.function?.name;
        let args = o.arguments ?? o.parameters ?? o.function?.arguments ?? {};
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* keep */ } }
        if (name && TOOL_NAMES.has(name)) out.push({ function: { name, arguments: args } });
      }
      if (out.length) return out;
    } catch { /* not JSON, try next candidate */ }
  }
  // LAST RESORT: a tool call emitted in FUNCTION-CALL syntax as plain text, e.g.
  // `search_movie({"query": "Apex"})` — qwen2.5:7b does this and the JSON-only candidates above
  // miss it (the whole string isn't JSON; the brace-matched `{"query":"Apex"}` has no `name`). Parse
  // it so we EXECUTE the call instead of ever delivering the literal string (the live Apex bug,
  // 2026-05-22).
  const inline = parseInlineToolCall(content);
  if (inline) out.push({ function: { name: inline.name, arguments: inline.arguments } });
  return out;
}

// --- Ollama /api/chat call ---

interface OllamaToolCall { function?: { name?: string; arguments?: unknown } }
interface OllamaMessage { role: string; content?: string; tool_calls?: OllamaToolCall[]; tool_name?: string }

async function ollamaChat(messages: OllamaMessage[]): Promise<OllamaMessage> {
  const body: Record<string, unknown> = {
    model: OLLAMA_MODEL,
    messages,
    tools,
    stream: false,
    options: { temperature: 0, num_ctx: 8192 },
  };
  // qwen3.x burns tokens on hidden thinking -> empty output unless think:false at the TOP
  // level. qwen2.5-coder is NOT a thinking model so it doesn't need this, but set it for
  // any qwen3* model in case OLLAMA_MODEL is swapped (Ollama ignores it otherwise).
  if (/qwen3/.test(OLLAMA_MODEL)) body.think = false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return data.message || {};
  } finally {
    clearTimeout(timer);
  }
}

// --- Real tool execution against Sonarr/Radarr ---

// Derive the search term + effective year. The year comes from the explicit `year` param if
// given; otherwise from a trailing/standalone 4-digit year in the query text (small models often
// stuff "Eternity 2025" into the query instead of using the param). The year is stripped from the
// term so Radarr/Sonarr lookup matches the bare title (lookups don't reliably match a year in the
// term), then we narrow the results by year ourselves. Range kept to plausible film years.
export function splitQueryYear(query: string, yearArg?: unknown): { term: string; year: number | undefined } {
  let year = Number(yearArg) || undefined;
  let term = query.trim();
  const m = term.match(/\b(19\d\d|20\d\d|21\d\d)\b/);
  if (!year && m) year = Number(m[1]);
  if (m) term = term.replace(m[0], '').replace(/\s{2,}/g, ' ').replace(/[\s,.-]+$/, '').trim();
  if (year && (year < 1900 || year > 2100)) year = undefined;
  return { term: term || query.trim(), year };
}

// Guard against a hallucinated-but-VALID id: the model passes title:"James and the Giant Peach"
// with tmdb_id:10485, but 10485 is a real OTHER movie ("Ghost Dad"). An exact-id match alone
// can't catch this — so cross-check the resolved title against the title the model claims it is
// adding. Returns true if they plausibly refer to the same work (one is a substring of the other,
// or they share a significant content word). Stopwords are ignored so "the/and/a" don't carry a
// match. Deliberately lenient: it only needs to catch a GROSS mismatch (Ghost Dad vs James), not
// adjudicate near-duplicates.
const TITLE_STOPWORDS = new Set(['the', 'a', 'an', 'and', 'of', 'to', 'in', 'on', 'part', 'movie', 'film', 'version']);
export function titlesRoughlyMatch(requested: string, resolved: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const r = norm(requested);
  const v = norm(resolved);
  if (!r || !v) return true; // no requested title to check against -> don't block
  if (r === v || r.includes(v) || v.includes(r)) return true;
  const words = (s: string) => new Set(s.split(' ').filter(w => w.length > 2 && !TITLE_STOPWORDS.has(w)));
  const rw = words(r);
  const vw = words(v);
  if (rw.size === 0) return true;
  for (const w of rw) if (vw.has(w)) return true;
  return false;
}

interface ToolOutcome {
  result: Record<string, unknown>;
  // If an add succeeded, the loop emits a JOB tag so the scheduler tracks follow-up.
  job?: { type: 'movie' | 'tv'; arrId: number; title: string };
  // Search results WITH popularity, for net #8's dominance check. Kept OUT of `result` (the
  // model-visible tool message) so the model never echoes raw popularity numbers to the user.
  searchResults?: Array<{ title?: string; year?: number; in_library?: boolean; tmdb_id?: number; tvdb_id?: number; popularity?: number }>;
}

// Title-scoped status: resolve a named title against the LIVE library + queue and report its
// real state. Checks Radarr (movie) and Sonarr (TV) — /lookup returns library entries with id>0
// (and hasFile for movies); a matching id>0 entry means it's in the library. We then read that
// item's download queue for active progress. The four reportable states map to what Jedd should
// say: in_library (ready), downloading (with %), searching (added, no release yet), not_added
// (never requested -> offer to add). Title match uses titlesRoughlyMatch so "severance" matches
// "Severance". On any arr error we degrade to not_found rather than throwing the whole turn.
async function statusForTitle(title: string): Promise<Record<string, unknown>> {
  const { term, year } = splitQueryYear(title);
  // Try movie first (DEFAULT-to-movie mirrors the search routing), then TV.
  for (const kind of ['movie', 'tv'] as const) {
    let results: Array<RadarrMovie | SonarrSeries> = [];
    try {
      results = kind === 'movie' ? await searchRadarr(term) : await searchSonarr(term);
    } catch { continue; }
    // A library entry has id>0. Narrow to the requested year if one was given.
    const inLib = results.filter(r => r.id > 0
      && titlesRoughlyMatch(term, r.title)
      && (!year || r.year === year));
    if (inLib.length === 0) continue;
    const item = inLib[0];
    if (kind === 'movie') {
      const movie = item as RadarrMovie;
      if (movie.hasFile === true) {
        return { title: movie.title, type: 'movie', state: 'ready', in_library: true, message: `${movie.title} is in your library and ready to watch.` };
      }
      let queue: Awaited<ReturnType<typeof getRadarrQueue>> = [];
      try { queue = await getRadarrQueue(movie.id); } catch { /* degrade to searching */ }
      const q = queue[0];
      if (q && q.size > 0 && q.sizeleft < q.size) {
        const pct = Math.max(0, Math.min(100, Math.round(100 * (1 - q.sizeleft / q.size))));
        return { title: movie.title, type: 'movie', state: 'downloading', in_library: true, progress: `${pct}%`, message: `${movie.title} is downloading, about ${pct}% done.` };
      }
      return { title: movie.title, type: 'movie', state: 'searching', in_library: true, message: `${movie.title} is added and still searching for a release — nothing downloading yet.` };
    } else {
      const series = item as SonarrSeries;
      let queue: Awaited<ReturnType<typeof getSonarrQueue>> = [];
      try { queue = await getSonarrQueue(series.id); } catch { /* degrade */ }
      let size = 0, left = 0;
      for (const x of queue) { size += x.size || 0; left += x.sizeleft || 0; }
      if (size > 0 && left < size) {
        const pct = Math.max(0, Math.min(100, Math.round(100 * (1 - left / size))));
        return { title: series.title, type: 'tv', state: 'downloading', in_library: true, progress: `${pct}%`, message: `${series.title} is downloading, about ${pct}% done.` };
      }
      if (queue.length > 0) {
        return { title: series.title, type: 'tv', state: 'downloading', in_library: true, message: `${series.title} is downloading now.` };
      }
      return { title: series.title, type: 'tv', state: 'searching', in_library: true, message: `${series.title} is added and still searching for episodes — nothing downloading yet.` };
    }
  }
  // Not in either library -> it was never added.
  return { title, state: 'not_added', in_library: false, message: `${title} isn't in your library yet — want me to add it?` };
}

async function runTool(name: string, args: Record<string, any>, senderPhone: string, activeJobs: DownloadJob[]): Promise<ToolOutcome> {
  switch (name) {
    case 'search_movie': {
      // Robustness: small models often stuff the year INTO the query ("Eternity 2025") instead
      // of using the year param, and Radarr's lookup does not reliably match a year in the term.
      // So: derive the effective year from the param OR a trailing 4-digit year in the query,
      // and search the BARE title. Radarr's /movie/lookup returns ALL years for a title; we
      // narrow by year HERE.
      const { term, year } = splitQueryYear(String(args.query || ''), args.year);
      const results = await searchRadarr(term);
      const top = results.slice(0, 8).map((m: RadarrMovie) => ({
        title: m.title, year: m.year, tmdb_id: m.tmdbId,
        in_library: m.id > 0 || m.hasFile === true,
        popularity: m.popularity,
      }));
      // Strip popularity from what the MODEL sees (it echoes raw numbers to the user otherwise);
      // popularity rides along in searchResults for net #8's dominance check only.
      const visible = (rs: typeof top) => rs.map(({ popularity, ...rest }) => rest);
      if (year && top.length) {
        const matched = top.filter(m => m.year === year);
        // NEVER empty a non-empty result set: if the year matches nothing, fall back to all
        // (with a note) so a year-filter can't turn a real hit into "couldn't find".
        if (matched.length) return { result: { results: visible(matched) }, searchResults: matched };
        const closest = top.slice(0, 5);
        return { result: { results: visible(closest), note: `no exact match for year ${year}; showing closest results` }, searchResults: closest };
      }
      const top5 = top.slice(0, 5);
      return { result: { results: visible(top5) }, searchResults: top5 };
    }
    case 'search_tv': {
      const { term, year } = splitQueryYear(String(args.query || ''), args.year);
      const results = await searchSonarr(term);
      const top = results.slice(0, 8).map((s: SonarrSeries) => {
        const seasonNums = (s.seasons || []).map(x => x.seasonNumber).filter(n => n > 0).sort((a, b) => a - b);
        return {
          title: s.title, year: s.year, tvdb_id: s.tvdbId,
          season_count: seasonNums.length || s.seasonCount || 0,
          // Real season numbers so the model can map "the latest season"/"first and last" to actual
          // numbers instead of guessing a count (it sent [1,8] for a 5-season show, live 2026-05-22).
          seasons: seasonNums,
          in_library: s.id > 0,
          popularity: s.popularity,
        };
      });
      const visible = (rs: typeof top) => rs.map(({ popularity, ...rest }) => rest);
      if (year && top.length) {
        const matched = top.filter(s => s.year === year);
        if (matched.length) return { result: { results: visible(matched) }, searchResults: matched };
        const closest = top.slice(0, 5);
        return { result: { results: visible(closest), note: `no exact match for year ${year}; showing closest results` }, searchResults: closest };
      }
      const top5 = top.slice(0, 5);
      return { result: { results: visible(top5) }, searchResults: top5 };
    }
    case 'add_movie': {
      const tmdbId = Number(args.tmdb_id);
      if (!tmdbId) return { result: { error: 'missing tmdb_id' } };
      const existing = await checkMovieExists(tmdbId);
      if (existing) return { result: { ok: false, already_in_library: true, title: existing.title } };
      // Re-fetch the full lookup object (Radarr needs the full payload to add). REQUIRE an exact
      // tmdbId match — small models sometimes hallucinate a tmdb_id. Falling back to lookups[0]
      // here once added "Ghost Dad" (tmdb 10485) for a "James and the Giant Peach" request and
      // reported success (2026-05-22). On a miss, surface an error so the model re-searches and
      // uses a REAL id from the results instead of adding the wrong movie.
      const lookups = await searchRadarr(`tmdb:${tmdbId}`);
      const movie = lookups.find((m: RadarrMovie) => m.tmdbId === tmdbId);
      if (!movie) return { result: { ok: false, error: `no movie with tmdb_id ${tmdbId} — re-run search_movie and use a tmdb_id from those results` } };
      // Title cross-check: a hallucinated-but-valid tmdb_id resolves to a real WRONG movie (the
      // Ghost-Dad-for-James bug). If the resolved title grossly mismatches what the model says it
      // is adding, refuse and make it re-search rather than add the wrong film.
      if (args.title && !titlesRoughlyMatch(String(args.title), movie.title)) {
        return { result: { ok: false, error: `tmdb_id ${tmdbId} is "${movie.title}", not "${args.title}" — re-run search_movie for "${args.title}" and use the correct tmdb_id from those results` } };
      }
      const added = await addRadarrMovie(movie);
      return {
        result: { ok: true, added: added.title, radarr_id: added.id, searching: true },
        job: { type: 'movie', arrId: added.id, title: added.title },
      };
    }
    case 'add_tv': {
      // RESOLVE the series by id first, falling back to a title search. qwen2.5:7b reliably
      // FABRICATES a tvdb_id on its first add_tv even right after a search returned the real one
      // (live, 2026-05-22: passes 327692/326766 for The Bear when search gave 403294). The old
      // path errored on a bad id and leaned on the multi-hop bad-id recovery nets (#4/#7) — fragile
      // (a mid-recovery 503 or a re-mangled season array dropped the add). Since add_tv ALSO
      // receives the title, we self-heal: if the id doesn't resolve to a series whose title matches,
      // search by title and take the dominant match's REAL id. No fabricated ids ever reach Sonarr.
      const tvdbId = Number(args.tvdb_id);
      const wantTitle = String(args.title || '').trim();
      let series: SonarrSeries | undefined;
      if (tvdbId) {
        const lookups = await searchSonarr(`tvdb:${tvdbId}`);
        const byId = lookups.find((s: SonarrSeries) => s.tvdbId === tvdbId);
        // Accept the id only if it resolves AND (no title given OR the titles roughly match).
        if (byId && (!wantTitle || titlesRoughlyMatch(wantTitle, byId.title))) series = byId;
      }
      // Id missing/bad/mismatched → resolve by title against the live search, dominant match wins.
      if (!series && wantTitle) {
        const results = await searchSonarr(wantTitle);
        const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
        const wt = norm(wantTitle);
        series = results.find((s: SonarrSeries) => norm(s.title) === wt) || results[0];
      }
      if (!series) return { result: { ok: false, error: `couldn't resolve a show for "${wantTitle || tvdbId}" — re-run search_tv and use a tvdb_id from those results` } };
      const existing = await checkSeriesExists(series.tvdbId);
      if (existing) return { result: { ok: false, already_in_library: true, title: existing.title } };
      // Resolve the requested seasons against the show's REAL season list. The model is unreliable
      // at translating "all"/"latest"/"first and last" to numbers and even fabricates counts (it
      // sent [1,8] for a 5-season show). availableSeasons is the source of truth; we clamp the
      // model's array to seasons that actually exist so a hallucinated number can't slip through.
      const availableSeasons = (series.seasons || []).map(s => s.seasonNumber).filter(n => n > 0).sort((a, b) => a - b);
      let seasons: number[] | 'all';
      // The user's season phrase (passed by the loop) is the source of truth — qwen2.5:7b mangles
      // the seasons array (sent [1] for "all seasons", [1,8] for a 5-season show). Resolve the phrase
      // deterministically against the real season list and OVERRIDE the model's array when it parses.
      const phrase = typeof args._seasonPhrase === 'string' ? args._seasonPhrase : '';
      const fromPhrase = phrase ? parseSeasonSelection(phrase, availableSeasons) : null;
      if (fromPhrase !== null) {
        seasons = fromPhrase;
      } else if (Array.isArray(args.seasons) && args.seasons.length) {
        const clamped = args.seasons.map(Number).filter(n => availableSeasons.includes(n));
        seasons = clamped.length ? clamped : 'all';
      } else {
        seasons = 'all';
      }
      const added = await addSonarrSeries(series, seasons);
      const monitored = (added.seasons || []).filter(s => s.seasonNumber > 0 && s.monitored).map(s => s.seasonNumber);
      return {
        result: { ok: true, added: added.title, sonarr_id: added.id, seasons: monitored.length ? monitored : seasons, searching: true },
        job: { type: 'tv', arrId: added.id, title: added.title },
      };
    }
    case 'check_status': {
      // TITLE-SCOPED status: "status of Severance" -> report Severance's REAL state, not a global
      // sweep (Jeff's ask, 2026-05-22). When a title is given, resolve it against the live library
      // (Sonarr/Radarr lookup returns library items with id>0 and hasFile) and the download queue,
      // and report exactly one of: in library / downloading (w/ progress) / searching / not added.
      const title = String(args.title || '').trim();
      if (title) return { result: await statusForTitle(title) };
      // No title -> the existing global sweep over this user's active downloading jobs.
      const userJobs = activeJobs.filter(j => j.requestedBy === senderPhone && j.status === 'downloading');
      const jobs: Array<Record<string, unknown>> = [];
      for (const j of userJobs) {
        try {
          const queue = j.type === 'movie' ? await getRadarrQueue(j.arrId) : await getSonarrQueue(j.arrId);
          const item = queue[0];
          jobs.push({
            title: j.title, type: j.type,
            status: item ? item.status : 'searching',
            progress: item && item.size ? `${Math.round(100 * (1 - item.sizeleft / item.size))}%` : undefined,
          });
        } catch {
          jobs.push({ title: j.title, type: j.type, status: 'searching' });
        }
      }
      return { result: { jobs } };
    }
    default:
      return { result: { error: `unknown tool ${name}` } };
  }
}

// --- Public entry point: one full request (start or resume are identical for local —
// it's stateless, the caller passes conversation history). ---

export interface LocalBackendResult {
  response: string;
  job?: { type: 'movie' | 'tv'; arrId: number; title: string };
}

export async function runLocalSession(
  senderPhone: string,
  userMessage: string,
  activeJobs: DownloadJob[],
  conversationHistory?: Array<{ role: string; text: string; timestamp: string }>,
): Promise<LocalBackendResult> {
  const messages: OllamaMessage[] = [{ role: 'system', content: buildSystemPrompt(isOwner(senderPhone), config.displayName) }];

  // Replay recent history so the model has context (resume equivalent).
  if (conversationHistory && conversationHistory.length > 0) {
    for (const m of conversationHistory) {
      messages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text });
    }
  }
  messages.push({ role: 'user', content: userMessage });

  // The user asked for a status — arm the status-stall net. When this is set, ANY text-only reply
  // (no check_status call) is treated as a stall and re-forces a real check_status, title-scoped
  // when the user named a title. Jeff's rule: on a status request, JUST GO LOOK and report the
  // real state in one message — never "I'm checking now, wait a moment" (2026-05-22).
  const userAskedStatus = isStatusQuery(userMessage);
  const statusTitle = userAskedStatus ? extractStatusTitle(userMessage) : '';

  // The user's CURRENT message as a season phrase ("all", "the latest season", "seasons 1-3",
  // "first and last"). qwen2.5:7b reliably mangles this when it builds the add_tv call itself (it
  // sent seasons:[1] for an "all seasons" request, live 2026-05-22). So whenever the user gave a
  // clear season phrase, we OVERRIDE the model's seasons array with the deterministic parse against
  // the show's real season list — the model never does season math. Passed through add_tv as
  // `_seasonPhrase`; resolved there against availableSeasons (so "all"/"latest" map to real numbers).
  const userSeasonPhraseRaw = userMessage;

  let lastJob: LocalBackendResult['job'];
  let toolUsedThisSession = false;
  let searchToolUsed = false;
  let statusToolUsed = false;
  let nudgedForStatusStall = false;
  let statusStalls = 0;
  let addToolUsed = false;
  let nudgedForPromise = false;
  let nudgedForFakeAdd = false;
  let nudgedForRefusal = false;
  let nudgedForBadIdAdd = false;
  let nudgedForStall = false;
  let nudgedForRecoveryAdd = false;
  let nudgedForOverDisambig = false;
  let nudgedForSeasonSelect = false;
  // Universal stall backstop (net #12): how many times we've re-forced a tool call after the model
  // emitted a "doing it now / wait a moment" stall that slipped past every specific net (e.g. a
  // status query phrased so isStatusQuery missed it — "How is severance doing", 2026-05-22). Capped
  // so a model that refuses to ever call a tool bails to an honest error, never a delivered stall.
  let stallBackstopNudges = 0;
  // How many times we've suppressed + re-forced a reply that was a RAW tool-call string the
  // recoverToolCalls parser couldn't cleanly execute (malformed `search_movie({...})` text). Capped
  // so a model that keeps emitting garbage bails to an honest error — NEVER delivers the raw string
  // to the user (the live Apex bug, 2026-05-22).
  let rawToolCallNudges = 0;
  // The most recent search results + the query they came from, so net #8 can run a deterministic
  // dominance check (top result clearly matches the request → add directly instead of asking).
  let lastSearchResults: Array<{ title?: string; year?: number; in_library?: boolean; tmdb_id?: number; tvdb_id?: number; seasons?: number[] }> = [];
  let lastSearchQuery = '';
  let lastSearchWasTv = false;
  // True when an add tool returned ok:false because the id didn't resolve (hallucinated/bad id)
  // and no search has succeeded this session. The correct recovery is to SEARCH for the title and
  // re-add from the results — but the model tends to punt with "let me search again" and stop. The
  // safety net below forces the search so the turn doesn't end on a dangling promise.
  let addFailedNeedsSearch = false;
  // The title the failed add referenced, so the forcing turn can name it.
  let failedAddTitle = '';
  // Was the failed add a TV add (so we force search_tv, not search_movie)?
  let failedAddIsTv = false;
  // How many times we've re-driven a still-pending forced search after the model answered with a
  // STALL ("I'm searching now, hang on") instead of a real tool call. Capped so a model that
  // refuses to ever call the tool can't spin to MAX_TOOL_HOPS doing nothing — we bail to an honest
  // error instead of a dangling "wait a moment" (the multi-turn Severance bug, 2026-05-22).
  let forcedSearchStalls = 0;
  // True when the most recent search_tv returned a 3+ season show and no season was specified
  // this session — in that case the correct next step is to ASK which seasons, NOT to force an
  // add. Prevents safety-net #2 from auto-adding ALL seasons of a long show the user must pick.
  let pendingSeasonQuestion = false;

  for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
    const msg = await ollamaChat(messages);
    let toolCalls = msg.tool_calls || [];

    // FALLBACK: recover tool calls emitted as JSON text in content (qwen2.5-coder).
    if (toolCalls.length === 0 && msg.content) {
      const recovered = recoverToolCalls(msg.content);
      if (recovered.length) toolCalls = recovered;
    }

    if (toolCalls.length > 0) {
      toolUsedThisSession = true;
      messages.push({ role: 'assistant', content: '', tool_calls: toolCalls });
      for (const tc of toolCalls) {
        const name = tc.function?.name || '';
        let args: any = tc.function?.arguments;
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
        args = args || {};
        console.log(`[local] tool_call ${name}(${JSON.stringify(args)})`);
        if (name === 'search_movie' || name === 'search_tv') searchToolUsed = true;
        if (name === 'check_status') statusToolUsed = true;
        // If the user gave a clear season phrase this turn, hand it to add_tv so it overrides the
        // model's (often wrong) seasons array deterministically against the real season list.
        if (name === 'add_tv') args._seasonPhrase = userSeasonPhraseRaw;
        const outcome = await runTool(name, args, senderPhone, activeJobs);
        // Only count an add as "used" if it actually SUCCEEDED. A failed add (hallucinated
        // tmdb_id, lookup miss) must NOT suppress safety-net #2 — otherwise the model can call
        // add_movie, get ok:false, and still narrate "I added it" (the Ghost Dad / James bug,
        // 2026-05-22). Leaving addToolUsed false lets net #2 force a real, correct add.
        if ((name === 'add_movie' || name === 'add_tv') && outcome.result?.ok === true) addToolUsed = true;
        // An add that FAILED because the id didn't resolve (hallucinated/wrong id) while no search
        // has happened → flag that we must force a search+re-add (the Oppenheimer-bad-id punt,
        // 2026-05-22). Exclude already_in_library (a legit terminal state, handled by the model).
        if ((name === 'add_movie' || name === 'add_tv') && outcome.result?.ok === false
            && !outcome.result?.already_in_library && !searchToolUsed) {
          addFailedNeedsSearch = true;
          failedAddTitle = String(args.title || '').trim();
          failedAddIsTv = name === 'add_tv';
        }
        if (outcome.job) lastJob = outcome.job;
        // Capture the latest search results (WITH popularity, via the side channel) + query so
        // net #8 can judge top-result dominance.
        if (name === 'search_movie' || name === 'search_tv') {
          lastSearchResults = outcome.searchResults || [];
          lastSearchQuery = String(args.query || '').trim();
          lastSearchWasTv = name === 'search_tv';
        }
        // Track whether a season question is owed: a search_tv that found a single 3+ season
        // show with no seasons specified in the add args. Adding seasons clears it.
        if (name === 'search_tv') {
          const results = (outcome.result?.results as Array<{ season_count?: number }>) || [];
          pendingSeasonQuestion = results.length > 0 && results.some(r => (r.season_count || 0) >= 3) && !(Array.isArray(args.seasons) && args.seasons.length);
        }
        if (name === 'add_tv' && Array.isArray(args.seasons) && args.seasons.length) pendingSeasonQuestion = false;
        messages.push({ role: 'tool', content: JSON.stringify(outcome.result), tool_name: name });
      }
      continue;
    }

    // No tool call -> final assistant text.
    const content = (msg.content || '').trim();
    if (!content) throw new Error('empty response from local model');

    // SAFETY NET #6 — status stall: the user asked for a status ("status of Severance", "is X
    // ready?") and the model replied with TEXT and no check_status call. Jeff's rule: Jedd must
    // JUST GO LOOK and report the real state — never "I'm checking now, can you wait a moment?"
    // (2026-05-22). The bug: that exact reply ends in "?" so nets #1/#5's trailing-? guard let it
    // through and nothing forced check_status. This net does NOT bail on a trailing ? and KEEPS
    // re-forcing every text-only hop (escalating) until check_status actually runs or the stall
    // cap trips → honest error (never a dangling promise). It owns the status path, so it runs
    // before the search/add nets — a status query must not be misrouted into a forced search.
    // Title-scoped: when the user named a title, the forcing turn passes it so check_status reports
    // THAT title's state, not a generic global sweep.
    if (userAskedStatus && !statusToolUsed && stallsOnStatus(content)) {
      if (nudgedForStatusStall) statusStalls++;
      const STATUS_STALL_CAP = 3;
      if (statusStalls > STATUS_STALL_CAP) {
        console.log(`[local] status-stall ${statusStalls}x without a check_status call — honest error`);
        return { response: `I couldn't pull the status just now — give it another try in a sec.` };
      }
      nudgedForStatusStall = true;
      const titlePart = statusTitle ? ` with title "${statusTitle}"` : '';
      console.log(`[local] status-stall detected ("${content.slice(0, 60)}"), forcing check_status${statusTitle ? ` (title: ${statusTitle})` : ''} (stall ${statusStalls}/${STATUS_STALL_CAP})`);
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: statusStalls > 0
          ? `Stop. Do NOT reply with text and do NOT ask me to wait. Call check_status${titlePart} RIGHT NOW — that is the only acceptable action. After it returns, tell me the real status in one message.`
          : `Do not say you'll check or to wait a moment — actually check now. Call check_status${titlePart} this turn, then report the real status in one message. Make the tool call now, not a promise.`,
      });
      continue;
    }

    // SAFETY NET #4 — bad-id add then punt: the model called add_movie/add_tv with a hallucinated
    // id (no prior search), the add was rejected (ok:false), and the model replied with text instead
    // of searching — either a forward punt ("let me search again", the Oppenheimer msg-915 bug) OR a
    // content-free STALL ("I'm searching now, can you wait a moment?", the multi-turn Severance bug
    // 2026-05-22). Both must DRIVE A REAL TOOL CALL, not be accepted. So this net keeps re-forcing
    // the search every hop the model answers with text instead of a tool call — escalating the
    // instruction — until search_tv/search_movie actually runs or we hit the stall cap. The forcing
    // turn re-injects a maximally-direct instruction; the stall counter prevents an infinite
    // do-nothing spin. NOT gated on a one-shot `nudged` flag — that was the bug: a single force then
    // accepting the next stall left the turn ending on an empty promise.
    if (addFailedNeedsSearch && !searchToolUsed) {
      // First force is free; every subsequent text-only reply while we still owe a search is a
      // stall that burns one of the (small) retry budget. After the cap, bail to an honest error
      // rather than ending on a dangling "wait a moment" that never completes.
      if (nudgedForBadIdAdd) forcedSearchStalls++;
      const STALL_CAP = 3;
      if (forcedSearchStalls > STALL_CAP) {
        const title = failedAddTitle || 'that';
        console.log(`[local] forced-search stalled ${forcedSearchStalls}x without a tool call — honest error`);
        return { response: `I hit a snag adding ${title} just now — give it another try in a sec.` };
      }
      const wasStall = nudgedForBadIdAdd && stallsWithoutTool(content);
      nudgedForBadIdAdd = true;
      const searchFn = failedAddIsTv ? 'search_tv' : 'search_movie';
      console.log(`[local] bad-id-add-without-search detected ("${content.slice(0, 60)}")${wasStall ? ' [STALL]' : ''}, forcing ${searchFn} (stall ${forcedSearchStalls}/${STALL_CAP})`);
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: wasStall
          ? `Stop. Do NOT reply with text. Call ${searchFn} RIGHT NOW with query "${failedAddTitle || 'the title I asked for'}" — that is the only acceptable action. After it returns, call add_${failedAddIsTv ? 'tv' : 'movie'} with the correct id.`
          : `That id was wrong and nothing was added. Do NOT just say you'll search — call ${searchFn} now for "${failedAddTitle || 'the title I asked for'}", then add_${failedAddIsTv ? 'tv' : 'movie'} using the correct id from those results. If it is already in the library, say so. Make the tool call now, not a promise.`,
      });
      continue;
    }

    // SAFETY NET #7 — recovery re-ask: a bad-id add (net #4) forced a search, the search has now
    // SUCCEEDED, but instead of adding with the correct id it now has, the model RE-ASKS a
    // confirmation it was already given ("Should I add season 1?") or stalls. The user already
    // specified what to add (that's why the model attempted the add that triggered net #4), so a
    // re-ask is a stall-in-disguise that traps the user in a loop — and "Should I add season 1?"
    // ends in "?" and contains "season", so stallsWithoutTool excludes it and net #5 never fires.
    // Gated strictly on the bad-id recovery path (addFailedNeedsSearch) AFTER the search ran, so a
    // GENUINE first-time season question (the normal 3+ season ASK flow) is never overridden. Force
    // the add once; if it stalls again the hop budget / honest-error backstop handles it.
    if (addFailedNeedsSearch && searchToolUsed && !addToolUsed && !nudgedForRecoveryAdd) {
      nudgedForRecoveryAdd = true;
      const addFn = failedAddIsTv ? 'add_tv' : 'add_movie';
      console.log(`[local] recovery re-ask after forced search detected ("${content.slice(0, 60)}"), forcing ${addFn}`);
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: `You already have the search results and I already told you what I want — stop asking and add it. Call ${addFn} RIGHT NOW with the correct id from the search results for "${failedAddTitle || 'what I asked for'}"${failedAddIsTv ? ' (the seasons I specified, or all if I said all)' : ''}. Do not ask again and do not reply with words — make the add call now.`,
      });
      continue;
    }

    // SAFETY NET for the "promise without execute" failure: small models sometimes reply
    // "Sure, I'll search for that" or "I'm checking the status now" and stop, never calling
    // the tool. If the reply PROMISES an action but no tool ran this whole session, push a
    // forcing turn and retry once.
    if (!toolUsedThisSession && !nudgedForPromise && promisesActionWithoutTool(content)) {
      nudgedForPromise = true;
      console.log(`[local] promise-without-execute detected ("${content.slice(0, 60)}"), forcing a tool call`);
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: 'You said you would but did not actually do it. Call the appropriate tool RIGHT NOW: check_status if they asked about the status / whether something is ready, otherwise search_tv for a show/cartoon/series or search_movie for a film. Do not reply with words — make the tool call.',
      });
      continue;
    }

    // SAFETY NET #2 — search-then-no-add: the model SEARCHED (so the nudge above is suppressed)
    // and then CLAIMS it added the item ("I added the 2021 version") but never called add_movie/
    // add_tv. This is the live Eternity/Dune-correction shape. Force the right next step once —
    // which is to ASK seasons if a 3+ season show is pending (NOT auto-add all seasons), else add.
    if (addToolUsed === false && !nudgedForFakeAdd && claimsAddWithoutExecuting(content)) {
      nudgedForFakeAdd = true;
      console.log(`[local] claims-added-without-adding detected ("${content.slice(0, 60)}"), forcing ${pendingSeasonQuestion ? 'a season question' : 'the add'}`);
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: pendingSeasonQuestion
          ? 'You have NOT added anything yet. This show has 3 or more seasons, so do not claim it is added — ask me which seasons I want (or "all") and wait for my answer. Reply with that question now.'
          : 'You have NOT actually added it — no add tool was called. From the search results you already have, call add_movie (or add_tv) RIGHT NOW with the tmdb_id/tvdb_id of the entry that matches what I asked for (match the year if I gave one). Do not reply with words and do not search again — make the add call.',
      });
      continue;
    }

    // SAFETY NET #3 — claim-without-searching: the model gives a search-DEPENDENT reply but NEVER
    // called a search tool this session. Two shapes, same poisoned-history root cause (2026-05-22):
    //   (a) a flat refusal ("Couldn't find that one") — refusesWithoutSearching
    //   (b) a parroted disambiguation question ("I found multiple results for X. Which one?") —
    //       claimsResultsWithoutSearching. It CANNOT have real results without searching this turn.
    // Nets #1/#2 only catch forward promises and false add claims; both shapes slip through. Force
    // ONE real search. Gated on !searchToolUsed so a GENUINE post-search refusal/question is never
    // second-guessed.
    if (!searchToolUsed && !nudgedForRefusal && (refusesWithoutSearching(content) || claimsResultsWithoutSearching(content))) {
      nudgedForRefusal = true;
      console.log(`[local] claim-without-searching detected ("${content.slice(0, 60)}"), forcing a search`);
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: 'You have NOT actually searched yet — no search tool was called. Do not say you could not find it without looking. Call search_movie now (or search_tv for a show/series/cartoon) for the title I asked for, passing the year in the year param if I gave one. Make the tool call now, do not reply with words.',
      });
      continue;
    }

    // SAFETY NET #5 — post-search stall: the model already SEARCHED (nets #3/#4 are satisfied) but
    // then STALLS ("I found it, adding now... hang on", "give me a sec") without ever calling the
    // add tool, and it's a STALL shape that nets #1/#2 don't catch (no add VERB, no "I'll add"). If
    // an add is still owed (no successful add, no pending season question), drive the add once.
    // Gated on a pending forced search NOT being active (net #4 owns that phase) and on having
    // searched, so a pre-search stall is left to net #4. Fires once to avoid loops; if it stalls
    // again the hop budget / final return handles it. This is the post-search arm of the same
    // dangling-"wait a moment" failure as net #4 (multi-turn Severance, 2026-05-22).
    if (searchToolUsed && !addToolUsed && !pendingSeasonQuestion && !nudgedForStall
        && !(addFailedNeedsSearch && !searchToolUsed) && stallsWithoutTool(content)) {
      nudgedForStall = true;
      console.log(`[local] post-search stall detected ("${content.slice(0, 60)}"), forcing the add`);
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: 'Stop — do NOT reply with text or ask me to wait. You have the search results already. Call add_movie (or add_tv) RIGHT NOW with the id of the entry that matches what I asked for. Make the tool call now.',
      });
      continue;
    }

    // SAFETY NET #11 — already-in-library: a search ran, the dominant top result is ALREADY in the
    // library, no add happened, and the model is NOT clearly saying so — instead it lists options
    // ("which Chernobyl?") or asks (live qwen2.5:7b, 2026-05-22: "add Chernobyl" → disambiguation
    // even though the 2019 one is in the library). The prompt already says "in_library:true → tell
    // them it's already available", but the small model ignores that when same-title siblings exist.
    // Deterministic + terminal: if the top result closely matches the query and is flagged
    // in_library, just say it's already there. Gated on the model not having already given a correct
    // already-have reply (so a good answer is never overwritten) and on no successful add.
    {
      const already = topResultAlreadyInLibrary(lastSearchQuery, lastSearchResults);
      const saysAlready = /already (in|added|available|have|got)|in your library/i.test(content);
      if (searchToolUsed && !addToolUsed && already && !saysAlready) {
        console.log(`[local] already-in-library net: "${already.title}" matches "${lastSearchQuery}" and is in library`);
        return { response: `${already.title}${already.year ? ` (${already.year})` : ''} is already in your library.` };
      }
    }

    // SAFETY NET #9 — TV season selection: a search ran and returned a clearly-dominant show, the
    // user's message is a recognizable SEASON phrase ("just season 1", "seasons 1-3", "all", "the
    // latest season", "first and last"), but the model has NOT produced a successful add — it
    // fabricated the tvdb_id, mangled the season numbers ([1,8] for a 5-season show), or stalled
    // (live qwen2.5:7b, 2026-05-22). The model is unreliable at BOTH the id and the season math, so
    // do it deterministically: parse the seasons from the user's words against the show's REAL
    // season list and execute add_tv ourselves with the dominant result's REAL tvdb_id. No
    // fabricated ids, no model season arithmetic. Gated on a dominant TV top result so we never
    // auto-add into a genuinely ambiguous show; fires once. This is the multi-season analogue of
    // net #8 — net #8 adds the obvious movie/short show directly; net #9 adds the obvious LONG show
    // with exactly the seasons the user named.
    if (lastSearchWasTv && searchToolUsed && !addToolUsed && !nudgedForSeasonSelect
        && topResultIsDominant(lastSearchQuery, lastSearchResults)) {
      const top = lastSearchResults[0];
      const avail = Array.isArray(top?.seasons) ? top!.seasons! : [];
      const phrasePick = parseSeasonSelection(userMessage, avail);
      // A SHORT dominant show (<3 seasons) needs no season question — the prompt says add it right
      // away. If the model instead asks (a question reply), add all its seasons directly. This is the
      // TV analogue of net #8 for short shows (live qwen2.5:7b, 2026-05-22: "add the show Severance",
      // a 2-season show, got a hybrid "is this the 2022 one? which seasons?" instead of adding).
      // GUARD: only when the title is unambiguous — if OTHER results share the query as a title base
      // (e.g. "The Office" → "The Office (US)", "The Office (AU)"), it's a genuine multi-version
      // ambiguity (which the strict dominance check misses because the siblings have suffixes), so
      // leave the model's "which one?" ask standing rather than silently adding the wrong version.
      const qNorm = lastSearchQuery.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
      const siblingVersions = lastSearchResults.slice(1).some(r => {
        const rn = (r.title || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
        return qNorm && rn.startsWith(qNorm + ' ');
      });
      const shortShowDirectAdd = phrasePick === null && avail.length > 0 && avail.length < 3
        && /\?/.test(content) && !siblingVersions;
      const picked = phrasePick !== null ? phrasePick : (shortShowDirectAdd ? 'all' : null);
      if (picked !== null && top?.tvdb_id) {
        nudgedForSeasonSelect = true;
        console.log(`[local] season-selection net: user="${userMessage}" -> ${JSON.stringify(picked)} for "${top.title}" (tvdb ${top.tvdb_id})${shortShowDirectAdd ? ' [short-show direct add]' : ''}`);
        const outcome = await runTool('add_tv', { tvdb_id: top.tvdb_id, title: top.title, seasons: picked === 'all' ? undefined : picked }, senderPhone, activeJobs);
        if (outcome.result?.ok === true && outcome.job) {
          const seasonsAdded = (outcome.result.seasons as number[] | string);
          const seasonText = picked === 'all' || seasonsAdded === 'all'
            ? 'all seasons' : `season${(Array.isArray(seasonsAdded) ? seasonsAdded : []).length === 1 ? '' : 's'} ${(Array.isArray(seasonsAdded) ? seasonsAdded : []).join(', ')}`;
          const response = `Added ${top.title}${top.year ? ` (${top.year})` : ''} — grabbing ${seasonText} now.\n<!--JOB:tv:${outcome.job.arrId}:${outcome.job.title}-->`;
          return { response, job: outcome.job };
        }
        if (outcome.result?.already_in_library === true) {
          return { response: `${outcome.result.title} is already in your library.` };
        }
        // Add failed for some other reason — fall through to the existing nets / honest error.
      }
    }

    // SAFETY NET #10 — TV show-disambiguation on a multi-season show: the user asked for a clearly
    // dominant LONG show ("add The Bear"), but Sonarr's lookup also returns near-namesakes (Boz the
    // Bear, Care Bears), so the model asks "which SHOW do you mean?" and stops — never resolving to
    // the obvious show to ask the seasons question. Net #8 can't help (it's gated !pendingSeason
    // question so the legit seasons ask survives), and net #9 needs a season phrase the user hasn't
    // given yet. So when there's a pending season question, a dominant TV top result, no add yet,
    // and the model is asking a SHOW-disambiguation question (which one / did you mean) rather than
    // a SEASONS question, force it to ask which SEASONS of the dominant show. Fires once; the user's
    // next message (a season phrase) is then handled deterministically by net #9.
    if (lastSearchWasTv && pendingSeasonQuestion && searchToolUsed && !addToolUsed && !nudgedForOverDisambig
        && asksWhichOne(content) && !/which seasons?\b/i.test(content)
        && topResultIsDominant(lastSearchQuery, lastSearchResults)) {
      nudgedForOverDisambig = true;
      const top = lastSearchResults[0];
      const count = Array.isArray(top?.seasons) ? top!.seasons!.length : 0;
      console.log(`[local] tv show-disambig on multi-season show, forcing seasons question for "${top?.title}"`);
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: `I mean "${top?.title}"${top?.year ? ` (${top.year})` : ''} — the obvious one, don't ask which show. It has ${count} seasons. Ask me which seasons I want (or "all") in one short question. Do not add anything yet.`,
      });
      continue;
    }

    // SAFETY NET #8 — over-disambiguation: the model SEARCHED, has real results, the top result is
    // a clearly-dominant match for what the user asked (deterministic topResultIsDominant), but it
    // ASKS "which one?" instead of just adding it. Jeff's ask (2026-05-22): "add The Matrix" /
    // "Whiplash" should add the obvious well-known film directly. Conservative: gated on a real
    // search having run, no add yet, NO pending season question (the TV "which seasons?" ask must
    // survive), and the deterministic dominance check — so a GENUINELY ambiguous case (two distinct
    // films of the same name) or a vague request still asks. The forced add still goes through the
    // real exact-id add path (no fabricated ids — the model uses the id from the results it has).
    // Fires once; if it still doesn't add, net #5 / hop budget handles the fallout.
    if (searchToolUsed && !addToolUsed && !pendingSeasonQuestion && !nudgedForOverDisambig
        && asksWhichOne(content) && topResultIsDominant(lastSearchQuery, lastSearchResults)) {
      nudgedForOverDisambig = true;
      const top = lastSearchResults[0];
      const addFn = lastSearchWasTv ? 'add_tv' : 'add_movie';
      const idLabel = lastSearchWasTv ? 'tvdb_id' : 'tmdb_id';
      const topId = lastSearchWasTv ? top?.tvdb_id : top?.tmdb_id;
      console.log(`[local] over-disambiguation detected ("${content.slice(0, 60)}"), forcing ${addFn} of dominant top result "${top?.title}"`);
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: `That's the obvious one — don't ask, just add it. Call ${addFn} RIGHT NOW for "${top?.title}"${top?.year ? ` (${top.year})` : ''} using ${idLabel} ${topId ?? 'from the top search result'}. Make the add call now, not a question.`,
      });
      continue;
    }

    // SAFETY NET #12 — UNIVERSAL STALL BACKSTOP. The hard rule (Jeff, 2026-05-22): for anything Jedd
    // can do now (status/search/add) it must call the tool synchronously and return ONLY the result
    // — it must NEVER deliver an "I'm checking/searching/doing X now / wait a moment / I'll get back
    // to you" message. The specific nets above are gated (isStatusQuery, searchToolUsed, trailing-?
    // guards) and a stall can slip past all of them — e.g. "How is severance doing" didn't match
    // isStatusQuery so net #6 never armed, and the "...wait a moment?" reply (trailing ?) dodged
    // nets #1/#5, so the stall reached the user. This net is the catch-all: if the FINAL reply for
    // this turn is a stall (isStallReply) and no tool ran this session, do NOT return it — force the
    // right tool and loop. Decide which tool from intent: status-y -> check_status, else search.
    if (!toolUsedThisSession && isStallReply(content)) {
      const STALL_BACKSTOP_CAP = 3;
      stallBackstopNudges++;
      if (stallBackstopNudges > STALL_BACKSTOP_CAP) {
        console.log(`[local] universal stall backstop hit cap (${stallBackstopNudges}) without a tool call — honest error`);
        return { response: `I couldn't get that done just now — give it another try in a sec.` };
      }
      const looksStatus = userAskedStatus || /\b(status|check|ready|downloading|how'?s it|progress|update)\b/i.test(content);
      const titlePart = statusTitle ? ` with title "${statusTitle}"` : '';
      console.log(`[local] universal stall backstop fired ("${content.slice(0, 60)}"), forcing ${looksStatus ? 'check_status' : 'a search/add'} (nudge ${stallBackstopNudges}/${STALL_BACKSTOP_CAP})`);
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: looksStatus
          ? `Stop. Do NOT reply with text and do NOT ask me to wait. Call check_status${titlePart} RIGHT NOW, then report the real status in one message.`
          : `Stop. Do NOT reply with text and do NOT ask me to wait. Call the right tool RIGHT NOW — search_tv for a show/series/cartoon or search_movie for a film, then add it — and report the result in one message. Make the tool call now, not a promise.`,
      });
      continue;
    }

    // FINAL GUARD — raw tool-call string. The model emitted a tool call as LITERAL TEXT
    // (`search_movie({"query": "Apex"})`) that recoverToolCalls couldn't cleanly parse+execute
    // (malformed/partial JSON args, or it slipped through earlier). Delivering it is gibberish to
    // the user (the live Apex bug, 2026-05-22). NEVER send it: suppress and re-force a proper tool
    // call, capped → honest error. This runs LAST — a recoverable inline call was already turned
    // into a real tool call at the top of the loop, so anything reaching here is unrecoverable.
    if (looksLikeRawToolCall(content)) {
      const RAW_TOOLCALL_CAP = 3;
      rawToolCallNudges++;
      if (rawToolCallNudges > RAW_TOOLCALL_CAP) {
        console.log(`[local] raw tool-call string emitted ${rawToolCallNudges}x, unrecoverable — honest error (NOT delivering "${content.slice(0, 60)}")`);
        return { response: `I hit a snag with that just now — give it another try in a sec.` };
      }
      console.log(`[local] raw tool-call string detected ("${content.slice(0, 60)}"), suppressing + re-forcing (nudge ${rawToolCallNudges}/${RAW_TOOLCALL_CAP})`);
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: 'Do NOT write the tool call as text — actually invoke it. Make a real tool call now (search_movie / search_tv / add_movie / add_tv / check_status as appropriate), and after it returns reply with ONLY the plain-language result. Never put a function call like search_movie({...}) in your message text.',
      });
      continue;
    }

    // Append the JOB tag so the scheduler tracks follow-up.
    let response = content;
    if (lastJob) response += `\n<!--JOB:${lastJob.type}:${lastJob.arrId}:${lastJob.title}-->`;
    return { response, job: lastJob };
  }

  // Hops exhausted. If we were mid-recovery on a failed add (owed a search/add that never
  // completed), do NOT throw a false "I'm searching" promise — return an honest error so the user
  // knows nothing was added and can retry (the multi-turn Severance backstop, 2026-05-22). Any
  // other exhaustion (genuinely stuck) still throws and session-manager replies with an error.
  if (addFailedNeedsSearch && !addToolUsed) {
    const title = failedAddTitle || 'that';
    console.log('[local] hops exhausted mid-recovery without a successful add — honest error');
    return { response: `I hit a snag adding ${title} just now — give it another try in a sec.` };
  }
  // Status query that never resolved to a real check_status — honest error, not a dangling
  // "I'm checking now" promise (mirrors the add-recovery backstop, 2026-05-22).
  if (userAskedStatus && !statusToolUsed) {
    console.log('[local] hops exhausted on a status query without a check_status — honest error');
    return { response: `I couldn't pull the status just now — give it another try in a sec.` };
  }
  throw new Error('local model exceeded max tool hops without a final reply');
}
