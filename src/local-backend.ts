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

import { config, isOwner, isJfagoConfigured, normalizePhone, type DownloadJob } from './config.js';
import { createInviteAndGetLink } from './jfago-client.js';
import { sendMessage, imessageAvailability } from './send.js';
import {
  searchRadarr, addRadarrMovie, checkMovieExists, getRadarrQueue, triggerMovieSearch,
  searchSonarr, addSonarrSeries, checkSeriesExists, getSonarrQueue, getSonarrSeries, triggerSeriesSearch,
} from './arr-client.js';
import { systemPromptV2 as buildSystemPrompt, promisesActionWithoutTool, claimsAddWithoutExecuting, refusesWithoutSearching, claimsResultsWithoutSearching, claimsFoundWithoutSearching, stallsWithoutTool, isStatusQuery, extractStatusTitle, stallsOnStatus, isStallReply, asksWhichOne, topResultIsDominant, parseSeasonSelection, topResultAlreadyInLibrary, parseInlineToolCall, looksLikeRawToolCall, messageHasPlausibleTitle, stripTrailingOffer, requestSpecifiesType, parseFranchiseAllRequest, parseSequelNumberList, franchiseQueryFromHistory, looksLikeMultiItemRequest, sequelNumberOfTitle, extractInviteRecipient, buildInviteText, buildProvisionConfirmation, claimsProvisionWithoutExecuting, buildCrossTypeChoiceList, findCrossTypeChoiceInHistory, resolveCrossTypePick, extractRequestTitle, closeTitleMatch, cleanedQueryVariants, titleSimilarity, buildDidYouMeanList, type CrossTypeCandidate } from './local-prompt.js';
import { jlog, truncate } from './logger.js';
import type { RadarrMovie, SonarrSeries } from './types.js';

export { promisesActionWithoutTool, claimsAddWithoutExecuting, refusesWithoutSearching, claimsResultsWithoutSearching, claimsFoundWithoutSearching, stallsWithoutTool, isStatusQuery, extractStatusTitle, stallsOnStatus, isStallReply, asksWhichOne, topResultIsDominant, parseSeasonSelection, topResultAlreadyInLibrary, parseInlineToolCall, looksLikeRawToolCall, messageHasPlausibleTitle, stripTrailingOffer, requestSpecifiesType };

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
  {
    type: 'function',
    function: {
      name: 'provision_jellyfin',
      description: "Invite/create a NEW Jellyfin streaming account for someone. Call this when the user asks to invite, set up, create, add, or make a new Jellyfin (or 'media server' / 'streaming') account/user for a person. Put that person's EMAIL ADDRESS or PHONE NUMBER in `recipient` (an email is preferred when given). Do NOT call this for movie/TV download requests — only for setting up a person's account. If no email or phone was provided, ASK for one instead of calling this.",
      parameters: {
        type: 'object',
        properties: {
          recipient: { type: 'string', description: "The new user's email address (preferred) OR phone number to send the invite to, exactly as the user gave it." },
        },
        required: ['recipient'],
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
  searchResults?: Array<{ title?: string; year?: number; in_library?: boolean; tmdb_id?: number; tvdb_id?: number; popularity?: number; hasFile?: boolean; arr_id?: number }>;
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

// `convText` = the user's message(s) this session, used to GROUND a provision_jellyfin recipient so
// the model can't invite a hallucinated/placeholder contact (qwen2.5:7b invents "friend@example.com"
// when asked to "set up my friend" with no real address). Only a contact the user actually typed is
// honored. Empty/unused for every other tool.
async function runTool(name: string, args: Record<string, any>, senderPhone: string, activeJobs: DownloadJob[], convText = ''): Promise<ToolOutcome> {
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
        // hasFile + arr_id ride along in searchResults (NOT shown to the model) so net #11 can tell a
        // ready-to-watch library item from one that's in the library but never downloaded, and
        // trigger a fresh search by Radarr id when the file is missing (the live Hook case 2026-05-24).
        hasFile: m.hasFile === true, arr_id: m.id,
        popularity: m.popularity,
      }));
      // Strip the internal-only fields from what the MODEL sees (it echoes raw numbers/ids to the
      // user otherwise); they ride along in searchResults for the deterministic nets only.
      const visible = (rs: typeof top) => rs.map(({ popularity, hasFile, arr_id, ...rest }) => rest);
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
          // arr_id rides along in searchResults (NOT shown to the model) so net #11 can fetch the
          // series' real episode-completeness from /series/{id} and trigger a search if it's in the
          // library but missing episodes (the TV analogue of the Hook movie case).
          arr_id: s.id,
          popularity: s.popularity,
        };
      });
      const visible = (rs: typeof top) => rs.map(({ popularity, arr_id, ...rest }) => rest);
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
    case 'provision_jellyfin': {
      // OWNER-ONLY — a deterministic CODE gate, never the model (the 7b will "pretend to be Jeff").
      if (!isOwner(senderPhone)) {
        jlog('provision.denied', { tool: 'provision_jellyfin', phone: senderPhone });
        return { result: { ok: false, declined: true, message: 'Only the owner can set up new Jellyfin accounts. Politely tell the requester you can\'t do that.' } };
      }
      if (!isJfagoConfigured()) {
        return { result: { ok: false, error: 'jfa-go provisioning is not configured', message: "Tell the user you can't set up Jellyfin accounts right now — it isn't configured." } };
      }
      const recipient = extractInviteRecipient(String(args.recipient || ''));
      if (!recipient) {
        return { result: { ok: false, need_recipient: true, message: 'No email or phone found. Ask the owner for the new user\'s email address or phone number.' } };
      }
      // GROUNDING: the recipient must actually appear in what the user typed — never provision to a
      // contact the model invented. qwen2.5:7b fabricates "friend@example.com" when asked to "set up
      // my friend" with no address; that must NOT create an invite.
      const convDigits = convText.replace(/\D/g, '');
      const grounded = recipient.kind === 'email'
        ? convText.toLowerCase().includes(recipient.value.toLowerCase())
        : convDigits.includes(recipient.value.replace(/\D/g, '').slice(-10));
      if (!grounded) {
        jlog('provision.ungrounded', { recipient: recipient.value });
        return { result: { ok: false, need_recipient: true, message: "Don't invent a contact — the user didn't give an email or phone. Ask them for the new user's real email address or phone number. Do NOT claim anything was set up." } };
      }
      const hours = config.jfago.inviteValidityHours;
      const label = `jedd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        if (recipient.kind === 'phone') {
          const to = normalizePhone(recipient.value);
          // iMessage capability check BEFORE burning the single-use invite. BlueBubbles is
          // iMessage-only; a definitive `false` means we must NOT text it — ask for an email instead
          // and DON'T create the invite. `null` = couldn't determine (e.g. BB Private API helper not
          // connected) → proceed best-effort and hedge with the link.
          const avail = await imessageAvailability(to);
          if (avail === false) {
            jlog('provision.not-imessage', { to });
            return { result: { ok: false, not_imessage: true, recipient: to, message: `${to} isn't reachable on iMessage, so I can't text it. Ask the owner for an email address to send the invite to instead. Do NOT say an invite was sent.` } };
          }
          const { link } = await createInviteAndGetLink({ label });
          const text = buildInviteText(link, hours, config.jellyfinPublicUrl);
          try {
            await sendMessage(to, text);
          } catch (err) {
            jlog('provision.deliver-failed', { to, error: String(err) });
            return { result: { ok: false, delivery_failed: true, recipient: to, invite_url: link, message: `The invite was created but texting ${to} failed (maybe not an iMessage number). Give the owner this link to share directly: ${link}. Do NOT claim it was sent.` } };
          }
          jlog('provision.created', { channel: 'imessage', to, label, imessage_unverified: avail === null });
          return { result: { ok: true, channel: 'imessage', recipient: to, invite_url: link, imessage_unverified: avail === null, message: `Invite created and texted to ${to} (expires in ${hours}h). Tell the owner it's done; if unsure it lands, share this link: ${link}` } };
        }
        // EMAIL: jfa-go's send-to emails the invite link via its configured SMTP.
        const { link } = await createInviteAndGetLink({ label, email: recipient.value });
        jlog('provision.created', { channel: 'email', recipient: recipient.value, label });
        return { result: { ok: true, channel: 'email', recipient: recipient.value, invite_url: link, message: `Invite created and emailed to ${recipient.value} (expires in ${hours}h). Tell the owner it's done; if it doesn't arrive they can share this link: ${link}` } };
      } catch (err) {
        jlog('provision.error', { recipient: recipient.value, error: String(err) });
        return { result: { ok: false, error: 'jfa-go create/read-back failed', message: 'Tell the owner there was a problem creating the invite and nothing was sent — they should try again.' } };
      }
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

// ["A","B","C"] → "A, B and C"; ["A","B"] → "A and B"; ["A"] → "A".
function listToProse(items: string[]): string {
  if (items.length <= 1) return items[0] || '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// Guidance reply when a multi-item request can't be fulfilled in one shot (net C fallback).
const MULTI_ITEM_GUIDANCE = 'I can grab these best one at a time — send me a single title and I\'ll get it, or say "all the <name> movies" and I\'ll grab the whole series.';

// --- Deterministic multi-movie / franchise add (nets A + B, 2026-05-24) ---
// Jeff's live failure: "Get 3 and 4 as well" and "get all the despicable me movies". Multi-title
// requests overwhelm the single-title-per-turn model loop (it thrashes, emits malformed tool calls,
// hallucinates ids). This resolves the franchise's REAL TMDB collection + real ids via Radarr and
// adds the selected members directly — never trusting a model-emitted id. Runs BEFORE the model loop;
// returns null when it can't confidently resolve (no franchise / no collection / no member match) so
// the caller falls through to the normal loop (no regression). Does NOT touch the hardened guards.
async function handleMultiMovieRequest(
  userMessage: string,
  conversationHistory?: Array<{ role: string; text: string }>,
): Promise<LocalBackendResult | null> {
  // A status check ("are 3 and 4 here yet?") must NEVER trigger an add — go look, don't grab.
  if (isStatusQuery(userMessage)) return null;
  const numberList = parseSequelNumberList(userMessage);
  const allReq = parseFranchiseAllRequest(userMessage);
  if (!numberList && !allReq) return null;

  // Resolve the franchise query: explicit ("all the despicable me movies") or from history ("3 and 4").
  const franchiseQuery = allReq || franchiseQueryFromHistory(conversationHistory);
  if (!franchiseQuery) return null;

  let results: RadarrMovie[];
  try {
    results = await searchRadarr(splitQueryYear(franchiseQuery).term);
  } catch (err) {
    jlog('error', { where: 'multi-add.search', franchiseQuery, error: String(err) });
    return null;
  }
  if (!results || results.length === 0) return null;

  // Identify the collection from the closest title match (fall back to the first result that has one).
  const anchor = results.find(r => titlesRoughlyMatch(franchiseQuery, r.title) && r.collection?.title)
    || results.find(r => r.collection?.title);
  const collectionTitle = anchor?.collection?.title;
  if (!collectionTitle) return null; // no collection → can't enumerate a franchise reliably

  // Collection members with REAL ids, de-duped, in release (sequel) order.
  const seen = new Set<number>();
  const members = results
    .filter(r => r.collection?.title === collectionTitle && r.tmdbId && !seen.has(r.tmdbId) && (seen.add(r.tmdbId), true))
    .sort((a, b) => (a.year || 0) - (b.year || 0));
  if (members.length === 0) return null;

  // Select: a number list → members at those franchise indices; 'all' → every member.
  const selected = numberList
    ? members.filter(m => numberList.includes(sequelNumberOfTitle(m.title)))
    : members;
  if (selected.length === 0) return null; // numbers didn't map to members → let the model try

  // Add / re-trigger each selected member using its REAL tmdbId (never a model-emitted id).
  const added: string[] = [];
  const regrabbed: string[] = [];
  const alreadyHave: string[] = [];
  const jobTags: string[] = [];
  let firstJob: LocalBackendResult['job'];
  for (const m of selected) {
    const label = `${m.title}${m.year ? ` (${m.year})` : ''}`;
    try {
      const inLibrary = (m.id && m.id > 0) || m.hasFile === true;
      if (inLibrary) {
        // Already in the library. No file → re-trigger a search; has file → already done.
        if (m.hasFile === false && m.id > 0) {
          await triggerMovieSearch(m.id);
          regrabbed.push(label);
          jobTags.push(`<!--JOB:movie:${m.id}:${m.title}-->`);
          firstJob ||= { type: 'movie', arrId: m.id, title: m.title };
        } else {
          alreadyHave.push(label);
        }
      } else {
        const addedMovie = await addRadarrMovie(m);
        if (addedMovie?.id) {
          added.push(label);
          jobTags.push(`<!--JOB:movie:${addedMovie.id}:${m.title}-->`);
          firstJob ||= { type: 'movie', arrId: addedMovie.id, title: m.title };
        }
      }
    } catch (err) {
      jlog('error', { where: 'multi-add.member', title: m.title, error: String(err) });
    }
  }

  if (added.length === 0 && regrabbed.length === 0 && alreadyHave.length === 0) return null;

  const grabbing = [...added, ...regrabbed];
  const parts: string[] = [];
  if (grabbing.length) parts.push(`grabbing ${listToProse(grabbing)} now`);
  if (alreadyHave.length) parts.push(`${listToProse(alreadyHave)} ${alreadyHave.length === 1 ? 'is' : 'are'} already in your library`);
  let response = parts.join('; ');
  response = response.charAt(0).toUpperCase() + response.slice(1) + '.';
  if (jobTags.length) response += '\n' + jobTags.join('\n');
  jlog('multi-add', { mode: numberList ? `numbers ${JSON.stringify(numberList)}` : 'all', franchiseQuery, added, regrabbed, alreadyHave });
  return { response, job: firstJob };
}

// --- Always-search-both + cross-type (movie ⇄ TV) disambiguation (2026-06-16) ---
// Jeff's ask: for a type-AMBIGUOUS bare title request, search BOTH Radarr and Sonarr and consider
// both result sets together. When a title has a clearly-dominant MOVIE *and* a clearly-dominant SHOW,
// don't silently pick one (the model defaults to movie-first and would never surface the show) —
// present a numbered choice and let the user pick. After they pick (number / "movie" / "show" /
// title), add the movie (or short show) or ASK which seasons for a long show. A SINGLE dominant match
// returns null → the existing model loop (+ nets #8/#9/#13/#14) adds it straight through. Runs BEFORE
// the model loop; returns null whenever it can't confidently act (no regression to the common case).
//
// Anti-bluff is unchanged: this NEVER fabricates an add — it only ADDS when an arr add actually
// returns an id, and emits the same <!--JOB:--> tag + "Added X" wording the existing add paths use.

// Probe season list for "is this message a season phrase?" (an answer to a pending season question,
// not a new title). Covers far more seasons than any real show has.
const SEASON_PROBE = Array.from({ length: 40 }, (_, i) => i + 1);

interface CrossTypeMappedMovie { title?: string; year?: number; in_library?: boolean; tmdb_id?: number; hasFile?: boolean; arr_id?: number; popularity?: number }
interface CrossTypeMappedTv { title?: string; year?: number; in_library?: boolean; tvdb_id?: number; season_count?: number; seasons?: number[]; arr_id?: number; popularity?: number }

function mapMovieResultsForDominance(results: RadarrMovie[]): CrossTypeMappedMovie[] {
  return (Array.isArray(results) ? results : []).slice(0, 8).map((m: RadarrMovie) => ({
    title: m.title, year: m.year, tmdb_id: m.tmdbId,
    in_library: m.id > 0 || m.hasFile === true,
    hasFile: m.hasFile === true, arr_id: m.id, popularity: m.popularity,
  }));
}
function mapTvResultsForDominance(results: SonarrSeries[]): CrossTypeMappedTv[] {
  return (Array.isArray(results) ? results : []).slice(0, 8).map((s: SonarrSeries) => {
    const seasonNums = (s.seasons || []).map(x => x.seasonNumber).filter(n => n > 0).sort((a, b) => a - b);
    return {
      title: s.title, year: s.year, tvdb_id: s.tvdbId,
      season_count: seasonNums.length || s.seasonCount || 0,
      seasons: seasonNums, in_library: s.id > 0, arr_id: s.id, popularity: s.popularity,
    };
  });
}

const titleLabel = (title?: string, year?: number) => `${title}${year ? ` (${year})` : ''}`;

// Proceed with the user's CHOSEN candidate from a cross-type list (or the single dominant match): a
// fresh search resolves the real id, then add the movie / short show, or ASK seasons for a long show.
// The id always comes from this live search — never the (possibly stale) candidate id.
async function addChosenTitle(pick: CrossTypeCandidate, senderPhone: string, activeJobs: DownloadJob[]): Promise<LocalBackendResult> {
  const { term } = splitQueryYear(pick.title);
  if (pick.type === 'movie') {
    const results = await searchRadarr(term);
    const movie = (Array.isArray(results) ? results : []).find((m: RadarrMovie) =>
      titlesRoughlyMatch(pick.title, m.title) && (!pick.year || m.year === pick.year)) || results[0];
    if (!movie) return { response: `I couldn't pull up ${pick.title} just now — give it another try in a sec.` };
    const existing = await checkMovieExists(movie.tmdbId);
    if (existing) {
      // In the library but no file (requested earlier, never downloaded) → re-trigger a search rather
      // than the misleading "already in your library" (the net #11 Hook behavior, applied here too).
      if (existing.hasFile === false && existing.id > 0) {
        await triggerMovieSearch(existing.id);
        const job = { type: 'movie' as const, arrId: existing.id, title: existing.title };
        return { response: `${titleLabel(existing.title, existing.year)} is already in your library but hasn't downloaded yet — I'm grabbing it now.\n<!--JOB:movie:${existing.id}:${existing.title}-->`, job };
      }
      return { response: `${titleLabel(existing.title, existing.year)} is already in your library.` };
    }
    const added = await addRadarrMovie(movie);
    if (!added?.id) return { response: `Something went wrong adding ${pick.title} just now — give it another try in a sec.` };
    const job = { type: 'movie' as const, arrId: added.id, title: added.title };
    return { response: `Added ${titleLabel(added.title, added.year)} — grabbing it now.\n<!--JOB:movie:${added.id}:${added.title}-->`, job };
  }
  // TV
  const results = await searchSonarr(term);
  const series = (Array.isArray(results) ? results : []).find((s: SonarrSeries) =>
    titlesRoughlyMatch(pick.title, s.title) && (!pick.year || s.year === pick.year)) || results[0];
  if (!series) return { response: `I couldn't pull up ${pick.title} just now — give it another try in a sec.` };
  const existing = await checkSeriesExists(series.tvdbId);
  if (existing) {
    // In the library but missing episodes → trigger a series search rather than a misleading "already
    // in your library" (the net #11 TV behavior). /series/lookup zeroes statistics, so fetch /series/{id}
    // for real counts; incomplete when monitored-aired episodes exceed episodes that have files. On any
    // error / complete series, fall back to the clean "already in your library" reply.
    if (existing.id > 0) {
      try {
        const full = await getSonarrSeries(existing.id);
        const st = full.statistics;
        if (st && typeof st.episodeCount === 'number' && st.episodeCount > 0 && (st.episodeFileCount ?? 0) < st.episodeCount) {
          await triggerSeriesSearch(existing.id);
          const job = { type: 'tv' as const, arrId: existing.id, title: existing.title };
          return { response: `${titleLabel(existing.title, existing.year)} is already in your library but some episodes haven't downloaded yet — I'm grabbing them now.\n<!--JOB:tv:${existing.id}:${existing.title}-->`, job };
        }
      } catch (err) {
        jlog('error', { where: 'cross-type.series-completeness', arr_id: existing.id, error: String(err) });
      }
    }
    return { response: `${titleLabel(existing.title, existing.year)} is already in your library.` };
  }
  const seasonNums = (series.seasons || []).map(s => s.seasonNumber).filter(n => n > 0);
  if (seasonNums.length >= 3) {
    // Long show — ASK which seasons (don't add). The user's next reply (a season phrase) goes back
    // through the model loop, which calls search_tv + add_tv; net #9 then overrides the season math
    // deterministically from the user's phrase. (Net #9 needs a fresh search_tv in that session, so
    // the guarantee is "the model searches + adds, net #9 corrects the seasons" — not a direct add here.)
    return { response: `${titleLabel(series.title, series.year)} has ${seasonNums.length} seasons — which seasons do you want, or all?` };
  }
  const added = await addSonarrSeries(series, 'all');
  if (!added?.id) return { response: `Something went wrong adding ${pick.title} just now — give it another try in a sec.` };
  const job = { type: 'tv' as const, arrId: added.id, title: added.title };
  return { response: `Added ${titleLabel(added.title, added.year)} — grabbing all seasons now.\n<!--JOB:tv:${added.id}:${added.title}-->`, job };
}

// "Did you mean?" confidence knobs. A candidate must clear DYM_FUZZY_FLOOR to be a plausible
// suggestion at all; the top is AUTO-added only when it's a near-exact hit (>= DYM_HIGH_CONFIDENCE)
// AND clearly ahead of the runner-up (by DYM_DOMINANCE_GAP) — otherwise Jedd ASKS (low-confidence guard).
const DYM_FUZZY_FLOOR = 0.34;
const DYM_HIGH_CONFIDENCE = 0.9;
const DYM_DOMINANCE_GAP = 0.15;

// Graceful typo / wrong-title recovery. Reached only when the original both-type search produced NO
// near-exact (dominant) match. If both searches were empty, retry with looser query variants; then
// rank whatever surfaced by similarity to what the user typed. A near-exact, dominant top is added
// straight through; otherwise present a numbered "did you mean?" list (reusing the cross-type pick UX).
// Returns null when nothing is plausible → the model loop delivers an honest not-found.
async function handleDidYouMean(
  title: string,
  movieMapped: CrossTypeMappedMovie[],
  tvMapped: CrossTypeMappedTv[],
  senderPhone: string,
  activeJobs: DownloadJob[],
): Promise<LocalBackendResult | null> {
  let movies = movieMapped;
  let tvs = tvMapped;

  // Both searches empty → the title is probably mistyped. Retry with looser variants until one hits.
  if (movies.length === 0 && tvs.length === 0) {
    const origTerm = splitQueryYear(title).term.toLowerCase();
    for (const variant of cleanedQueryVariants(title)) {
      const term = splitQueryYear(variant).term;
      if (!term || term.toLowerCase() === origTerm) continue;
      let mr: RadarrMovie[] = [];
      let tr: SonarrSeries[] = [];
      try {
        [mr, tr] = await Promise.all([searchRadarr(term), searchSonarr(term)]);
      } catch (err) {
        jlog('error', { where: 'did-you-mean.retry', variant, error: String(err) });
        continue;
      }
      if ((Array.isArray(mr) && mr.length) || (Array.isArray(tr) && tr.length)) {
        movies = mapMovieResultsForDominance(mr);
        tvs = mapTvResultsForDominance(tr);
        jlog('did-you-mean.retry', { title, variant, term, movies: movies.length, tvs: tvs.length });
        break;
      }
    }
  }

  // Score the top of each type by similarity to what the user typed. Skip in-library items (a
  // different reply path owns those) and require a real title.
  interface Scored { cand: CrossTypeCandidate; sim: number; pop: number }
  const pool: Scored[] = [];
  for (const m of movies.slice(0, 4)) {
    if (!m.title || m.in_library) continue;
    pool.push({ cand: { type: 'movie', title: m.title, year: m.year, tmdb_id: m.tmdb_id }, sim: titleSimilarity(title, m.title), pop: Number(m.popularity) || 0 });
  }
  for (const s of tvs.slice(0, 4)) {
    if (!s.title || s.in_library) continue;
    pool.push({ cand: { type: 'tv', title: s.title, year: s.year, tvdb_id: s.tvdb_id, season_count: s.season_count }, sim: titleSimilarity(title, s.title), pop: Number(s.popularity) || 0 });
  }

  // Keep plausible matches, best first (similarity, then popularity), deduped by type+title, top 3.
  const seen = new Set<string>();
  const ranked = pool
    .filter(p => p.sim >= DYM_FUZZY_FLOOR)
    .sort((a, b) => (b.sim - a.sim) || (b.pop - a.pop))
    .filter(p => { const k = `${p.cand.type}:${p.cand.title.toLowerCase()}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 3);

  if (ranked.length === 0) return null; // nothing plausible → model loop says not-found honestly

  // Auto-add only a near-exact, clearly-dominant top (never a merely-fuzzy match — Jeff's guard).
  const top = ranked[0];
  const runnerUp = ranked[1];
  const dominant = !runnerUp || (top.sim - runnerUp.sim) >= DYM_DOMINANCE_GAP;
  // Strict `>`: a substring-only match scores exactly DYM_HIGH_CONFIDENCE (0.9) via titleSimilarity's
  // `contains` branch — that's an ASK, not an auto-add. Only a genuine near-exact spelling match (a
  // higher edit-distance similarity) clears the bar and is added without confirmation.
  if (top.sim > DYM_HIGH_CONFIDENCE && dominant) {
    try {
      const result = await addChosenTitle(top.cand, senderPhone, activeJobs);
      jlog('did-you-mean.autoadd', { title, picked: top.cand, sim: top.sim });
      jlog('delivery.decision', { path: 'did-you-mean-autoadd', deterministic: true, text: truncate(result.response, 2000), job: result.job });
      return result;
    } catch (err) {
      jlog('error', { where: 'did-you-mean.autoadd', pick: top.cand, error: String(err) });
      // fall through to ASK rather than dead-end on an arr error
    }
  }

  // Low confidence (or a tie at the top) → ASK. Present a numbered "did you mean?" list; the reply
  // resolves through the same pick path as a cross-type choice (PATH A).
  const candidates = ranked.map(r => r.cand);
  const response = buildDidYouMeanList(title, candidates);
  jlog('did-you-mean.suggest', { title, candidates, sims: ranked.map(r => Number(r.sim.toFixed(3))) });
  jlog('delivery.decision', { path: 'did-you-mean-suggest', deterministic: true, text: truncate(response, 2000) });
  return { response };
}

async function handleCrossTypeRequest(
  userMessage: string,
  conversationHistory: Array<{ role: string; text: string }> | undefined,
  senderPhone: string,
  activeJobs: DownloadJob[],
): Promise<LocalBackendResult | null> {
  // PATH A — the user is replying to a cross-type choice list Jedd presented last turn.
  const priorChoices = findCrossTypeChoiceInHistory(conversationHistory);
  if (priorChoices) {
    const pick = resolveCrossTypePick(userMessage, priorChoices);
    if (!pick) return null; // not a recognizable pick → could be a brand-new request → fall through
    jlog('cross-type.pick', { userMessage, picked: pick, options: priorChoices.length });
    try {
      const result = await addChosenTitle(pick, senderPhone, activeJobs);
      jlog('delivery.decision', { path: 'cross-type-pick', deterministic: true, text: truncate(result.response, 2000), job: result.job });
      return result;
    } catch (err) {
      jlog('error', { where: 'cross-type.addChosen', pick, error: String(err) });
      return null; // arr error → fall through to the model loop rather than dead-end
    }
  }

  // PATH B — a NEW type-ambiguous bare title request. Search both, present a choice on a collision.
  if (isStatusQuery(userMessage)) return null;
  if (looksLikeMultiItemRequest(userMessage)) return null;
  // A Jellyfin account/provisioning request ("set my friend up on Jellyfin", "invite sam@x.com") is
  // NOT a media request — never search arr for it (let the model's provision_jellyfin path own it).
  if (/\b(jellyfin|streaming account|media server)\b/i.test(userMessage) || extractInviteRecipient(userMessage)) return null;
  if (requestSpecifiesType(userMessage) !== null) return null;             // explicit movie/TV → loop
  if (!messageHasPlausibleTitle(userMessage)) return null;                 // gibberish / non-media
  if (parseSeasonSelection(userMessage, SEASON_PROBE) !== null) return null; // a season answer, not a title
  const title = extractRequestTitle(userMessage);
  if (!title) return null;

  let movieResults: RadarrMovie[] = [];
  let tvResults: SonarrSeries[] = [];
  try {
    const { term } = splitQueryYear(title);
    [movieResults, tvResults] = await Promise.all([searchRadarr(term), searchSonarr(term)]);
  } catch (err) {
    jlog('error', { where: 'cross-type.search', title, error: String(err) });
    return null; // arr error → fall through to the model loop
  }

  const movieMapped = mapMovieResultsForDominance(movieResults);
  const tvMapped = mapTvResultsForDominance(tvResults);
  const candidates: CrossTypeCandidate[] = [];
  if (topResultIsDominant(title, movieMapped)) {
    const top = movieMapped[0];
    candidates.push({ type: 'movie', title: top.title!, year: top.year, tmdb_id: top.tmdb_id });
  }
  if (topResultIsDominant(title, tvMapped)) {
    const top = tvMapped[0];
    candidates.push({ type: 'tv', title: top.title!, year: top.year, tvdb_id: top.tvdb_id, season_count: top.season_count });
  }

  // ≥2 dominant → a genuine CROSS-TYPE collision (a dominant movie AND a dominant show) → numbered choice.
  if (candidates.length >= 2) {
    const response = buildCrossTypeChoiceList(title, candidates);
    jlog('cross-type.disambiguate', { title, candidates });
    jlog('delivery.decision', { path: 'cross-type-disambiguate', deterministic: true, text: truncate(response, 2000) });
    return { response };
  }

  // Exactly 1 dominant → the common single-match case → straight through (the model loop adds it). No
  // new friction here (Jeff's clean-case rule).
  if (candidates.length === 1) return null;

  // 0 dominant. If the TOP result of either type is still a near-exact title match, this is a correct
  // (just ambiguous, e.g. two same-name films) title → leave it to the model loop / net #8. Only when
  // NOTHING close matches do we treat it as a typo / wrong title and try graceful "did you mean?" recovery.
  const topClose = (!!movieMapped[0]?.title && closeTitleMatch(title, movieMapped[0].title!))
    || (!!tvMapped[0]?.title && closeTitleMatch(title, tvMapped[0].title!));
  if (topClose) return null;

  return handleDidYouMean(title, movieMapped, tvMapped, senderPhone, activeJobs);
}

export async function runLocalSession(
  senderPhone: string,
  userMessage: string,
  activeJobs: DownloadJob[],
  conversationHistory?: Array<{ role: string; text: string; timestamp: string }>,
  conversationId = 'c_nocid',
): Promise<LocalBackendResult> {
  // Stable correlation id for this whole interaction. `turn` increments per model hop. Every
  // structured event below carries {conversationId, turn} so a single conversation is greppable
  // end-to-end (`grep <conversationId> jedd-*.log`). `net()` records which guardrail fired and why.
  let turn = 0;
  const cid = conversationId;
  const net = (name: string, detail: Record<string, unknown> = {}) =>
    jlog('net.fire', { conversationId: cid, turn, net: name, ...detail });

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

  // Does the conversation actually reference a real media title to search for? Net #3 (force a
  // search on a refusal/parrot with no search) is correct for the poisoned-history case (a real
  // title named, model parrots "couldn't find" without searching). But forcing a search on a
  // title-LESS message — gibberish ("asdkjfh"), a pure non-media request ("play music") — makes the
  // small model HALLUCINATE a title to satisfy the forcing turn (live 2026-05-22: "asdkjfh" →
  // searched + added "Barbie"). So net #3 only fires when the current message OR a recent history
  // user turn plausibly names a title. A title-less message keeps its honest clarifying reply.
  const userHasPlausibleTitle = messageHasPlausibleTitle(userMessage)
    || (conversationHistory || []).some(m => m.role === 'user' && messageHasPlausibleTitle(m.text));

  // The user's CURRENT message as a season phrase ("all", "the latest season", "seasons 1-3",
  // "first and last"). qwen2.5:7b reliably mangles this when it builds the add_tv call itself (it
  // sent seasons:[1] for an "all seasons" request, live 2026-05-22). So whenever the user gave a
  // clear season phrase, we OVERRIDE the model's seasons array with the deterministic parse against
  // the show's real season list — the model never does season math. Passed through add_tv as
  // `_seasonPhrase`; resolved there against availableSeasons (so "all"/"latest" map to real numbers).
  const userSeasonPhraseRaw = userMessage;

  // The request's explicit media type, if the user named one ("the movie X", "season 2 of X").
  // null = type-ambiguous (a bare title) → eligible for the cross-type search fallback (net #13).
  const requestedType = requestSpecifiesType(userMessage);

  jlog('session.start', {
    conversationId: cid,
    phone: senderPhone,
    owner: isOwner(senderPhone),
    message: userMessage,
    historyLen: conversationHistory?.length || 0,
    model: OLLAMA_MODEL,
    gates: { userAskedStatus, statusTitle, userHasPlausibleTitle, requestedType },
  });

  // Nets A + B: a multi-movie / whole-franchise request ("get 3 and 4", "all the X movies"). Resolve
  // the real TMDB collection + ids and add deterministically BEFORE the model loop (the small model
  // thrashes on multi-title requests). null → not a resolvable multi-request → fall through.
  const multiResult = await handleMultiMovieRequest(userMessage, conversationHistory);
  if (multiResult) {
    jlog('delivery.decision', { conversationId: cid, path: 'multi-movie-handler', deterministic: true, text: truncate(multiResult.response, 2000), job: multiResult.job });
    return multiResult;
  }

  // Always-search-both + cross-type disambiguation: search Radarr AND Sonarr for a type-ambiguous
  // bare title and, on a movie+show collision, present a numbered choice (don't auto-pick); resolve a
  // reply to a prior choice list into the chosen add / seasons question. Returns null (fall through to
  // the model loop) for the single-dominant common case and anything it can't confidently act on.
  const crossTypeResult = await handleCrossTypeRequest(userMessage, conversationHistory, senderPhone, activeJobs);
  if (crossTypeResult) {
    jlog('delivery.decision', { conversationId: cid, path: 'cross-type-handler', deterministic: true, text: truncate(crossTypeResult.response, 2000), job: crossTypeResult.job });
    return crossTypeResult;
  }

  let lastJob: LocalBackendResult['job'];
  let toolUsedThisSession = false;
  let searchToolUsed = false;
  // Which search types ran this session, and whether each returned ZERO results — drives the
  // cross-type fallback (net #13): a movie-first empty + the user never said "movie" → try TV.
  let movieSearched = false;
  let tvSearched = false;
  let movieSearchEmpty = false;
  let tvSearchEmpty = false;
  let nudgedForCrossSearch = false;
  // Net #14: we've forced ONCE after the model emitted a not-found reply DESPITE the (usually
  // cross-type-fallback) search returning a dominant match — so the found title is carried forward
  // instead of dropped (the live "U.S. Against the World" bug, 2026-06-16).
  let nudgedForFoundButRefused = false;
  let statusToolUsed = false;
  let nudgedForStatusStall = false;
  let statusStalls = 0;
  let addToolUsed = false;
  // True once a provision_jellyfin call returned ok:true — gates the false-provision FINAL GUARD so
  // the model can never claim an invite was sent unless one really was created + delivered.
  let provisionSucceeded = false;
  // The verified ok:true provision result (channel + REAL recipient + read-back-verified invite_url).
  // Captured so the success reply is built deterministically from this — never the 7b's narration,
  // which once reported a hallucinated "joey@example.com" even though a real invite was created.
  let provisionResult: { channel?: string; recipient?: string; invite_url?: string; imessage_unverified?: boolean } | null = null;
  let nudgedForPromise = false;
  let nudgedForFakeAdd = false;
  let nudgedForRefusal = false;
  // Net #3b: we've forced ONE real search after the model fabricated a "found it / N seasons /
  // which seasons?" reply with no search this session (the live Star City bug, 2026-05-31).
  let nudgedForFabricatedFound = false;
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
  let lastSearchResults: Array<{ title?: string; year?: number; in_library?: boolean; tmdb_id?: number; tvdb_id?: number; seasons?: number[]; hasFile?: boolean; arr_id?: number }> = [];
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
    turn = hop + 1;
    const msg = await ollamaChat(messages);
    let toolCalls = msg.tool_calls || [];
    const nativeToolCalls = toolCalls.length;

    // FALLBACK: recover tool calls emitted as JSON text in content (qwen2.5-coder).
    let recoveredFromText = false;
    if (toolCalls.length === 0 && msg.content) {
      const recovered = recoverToolCalls(msg.content);
      if (recovered.length) { toolCalls = recovered; recoveredFromText = true; }
    }

    // RAW model output for this turn — the single most important record for diagnosing a
    // fabrication: it shows EXACTLY what the model emitted before any parsing/net/guard ran.
    jlog('model.turn', {
      conversationId: cid,
      turn,
      rawContent: truncate(msg.content || ''),
      nativeToolCalls,
      recoveredFromText,
      toolCallNames: toolCalls.map((tc: any) => tc.function?.name).filter(Boolean),
    });

    if (toolCalls.length > 0) {
      toolUsedThisSession = true;
      messages.push({ role: 'assistant', content: '', tool_calls: toolCalls });
      for (const tc of toolCalls) {
        const name = tc.function?.name || '';
        let args: any = tc.function?.arguments;
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
        args = args || {};
        jlog('tool.call', { conversationId: cid, turn, tool: name, args });
        if (name === 'search_movie' || name === 'search_tv') searchToolUsed = true;
        if (name === 'check_status') statusToolUsed = true;
        // If the user gave a clear season phrase this turn, hand it to add_tv so it overrides the
        // model's (often wrong) seasons array deterministically against the real season list.
        if (name === 'add_tv') args._seasonPhrase = userSeasonPhraseRaw;
        const provisionConvText = [userMessage, ...((conversationHistory || []).map((m) => m.text))].join(' \n ');
        const outcome = await runTool(name, args, senderPhone, activeJobs, provisionConvText);
        // FULL tool response — the arr-visible result the model sees, plus the side-channel search
        // candidates (titles + ids + popularity the nets use) and any add job. This is what lets us
        // see the EXACT lookup candidates / add outcome that drove the model's next move.
        jlog('tool.result', {
          conversationId: cid,
          turn,
          tool: name,
          result: outcome.result,
          searchCandidates: outcome.searchResults,
          job: outcome.job,
        });
        // Only count an add as "used" if it actually SUCCEEDED. A failed add (hallucinated
        // tmdb_id, lookup miss) must NOT suppress safety-net #2 — otherwise the model can call
        // add_movie, get ok:false, and still narrate "I added it" (the Ghost Dad / James bug,
        // 2026-05-22). Leaving addToolUsed false lets net #2 force a real, correct add.
        if ((name === 'add_movie' || name === 'add_tv') && outcome.result?.ok === true) addToolUsed = true;
        if (name === 'provision_jellyfin' && outcome.result?.ok === true) { provisionSucceeded = true; provisionResult = outcome.result; }
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
          const empty = (outcome.searchResults || []).length === 0;
          if (name === 'search_movie') { movieSearched = true; movieSearchEmpty = empty; }
          else { tvSearched = true; tvSearchEmpty = empty; }
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
        net('status-stall.honest-error', { stalls: statusStalls, content: truncate(content, 300) });
        const response = `I couldn't pull the status just now — give it another try in a sec.`;
        jlog('delivery.decision', { conversationId: cid, turn, path: 'status-stall-cap', text: response });
        return { response };
      }
      nudgedForStatusStall = true;
      const titlePart = statusTitle ? ` with title "${statusTitle}"` : '';
      net('status-stall', { content: truncate(content, 300), forced: 'check_status', statusTitle: statusTitle || undefined, stall: `${statusStalls}/${STATUS_STALL_CAP}` });
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
        net('bad-id-add.honest-error', { stalls: forcedSearchStalls, title, content: truncate(content, 300) });
        const response = `I hit a snag adding ${title} just now — give it another try in a sec.`;
        jlog('delivery.decision', { conversationId: cid, turn, path: 'forced-search-stall-cap', text: response });
        return { response };
      }
      const wasStall = nudgedForBadIdAdd && stallsWithoutTool(content);
      nudgedForBadIdAdd = true;
      const searchFn = failedAddIsTv ? 'search_tv' : 'search_movie';
      net('bad-id-add-without-search', { content: truncate(content, 300), wasStall, forced: searchFn, failedAddTitle, stall: `${forcedSearchStalls}/${STALL_CAP}` });
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
      net('recovery-re-ask', { content: truncate(content, 300), forced: addFn, failedAddTitle });
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
      net('promise-without-execute', { content: truncate(content, 300), forced: 'a tool call' });
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
      net('claims-added-without-adding', { content: truncate(content, 300), forced: pendingSeasonQuestion ? 'a season question' : (searchToolUsed ? 'the add' : 'a search-then-add'), searchToolUsed, pendingSeasonQuestion });
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: pendingSeasonQuestion
          ? 'You have NOT added anything yet. This show has 3 or more seasons, so do not claim it is added — ask me which seasons I want (or "all") and wait for my answer. Reply with that question now.'
          : !searchToolUsed
            // No search ran this turn (stateless resume — a prior turn's results are NOT in context),
            // so the model has no real id to add with. Forcing "add from the results you have" is
            // impossible — make it SEARCH first, then add (the live Star City bug, 2026-05-31).
            ? 'You have NOT added anything and you have not looked it up this turn, so you do not have a real id to add. Call search_tv now (or search_movie for a film) for the title I asked about, then add it using the id from those results. Do NOT tell me it is added until the add tool actually returns success.'
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
    if (!searchToolUsed && !nudgedForRefusal && userHasPlausibleTitle && (refusesWithoutSearching(content) || claimsResultsWithoutSearching(content))) {
      nudgedForRefusal = true;
      net('claim-without-searching', { content: truncate(content, 300), forced: 'a search' });
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: 'You have NOT actually searched yet — no search tool was called. Do not say you could not find it without looking. Call search_movie now (or search_tv for a show/series/cartoon) for the title I asked for, passing the year in the year param if I gave one. Make the tool call now, do not reply with words.',
      });
      continue;
    }

    // SAFETY NET #3b — fabricated search result: the model PRESENTS details about a title (FOUND it,
    // a SEASON COUNT, a "which seasons?" offer) but NEVER called a search tool this session. qwen2.5:7b
    // reconstructs this entirely from conversation history without looking anything up (the live Star
    // City bug, 2026-05-31: "Found Star City. Which seasons would you like? ... Star City has 4 seasons
    // available" — a 1-season show reported as 4, and it was never actually searched). Net #3's
    // refusesWithoutSearching/claimsResultsWithoutSearching catch the "couldn't find" and "multiple
    // results, which one?" shapes but NOT the single-show "found it / N seasons" shape. Force a real
    // search so the match AND the season count come from Sonarr, not the model's memory. Gated on
    // !searchToolUsed (a genuine post-search reply is untouched) and the non-status path (net #6 owns
    // status). The user-has-a-title gate prevents hallucinating a title from a title-less message.
    if (!searchToolUsed && !statusToolUsed && !userAskedStatus && !nudgedForFabricatedFound
        && userHasPlausibleTitle && claimsFoundWithoutSearching(content)) {
      nudgedForFabricatedFound = true;
      net('fabricated-found-without-searching', { content: truncate(content, 300), forced: 'a search' });
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: 'You have NOT looked it up yet — do not tell me you found it, how many seasons it has, or ask which seasons until you actually search. Call search_tv now (or search_movie for a film) for the title I asked about, then use ONLY the season_count and id from those results. Make the tool call now, not a reply.',
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
      net('post-search-stall', { content: truncate(content, 300), forced: 'the add' });
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
      if (searchToolUsed && !addToolUsed && already) {
        const label = `${already.title}${already.year ? ` (${already.year})` : ''}`;
        // MOVIE that's in the library but has NO file: it was requested earlier but never downloaded
        // or imported (the live Hook case, 2026-05-24). "Already in your library" is MISLEADING — the
        // user can't watch a 0-byte movie. This OVERRIDES even a model reply that says "already in
        // your library" (the small model only sees in_library:true and parrots that), because the
        // file is genuinely missing. Trigger a fresh MoviesSearch by Radarr id, register a follow-up
        // job (JOB tag → scheduler reports when it lands), and tell them it's grabbing now. Gated to
        // movies (TV file-completeness is per-episode and murkier — left as a follow-up).
        if (!lastSearchWasTv && already.hasFile === false && typeof already.arr_id === 'number' && already.arr_id > 0) {
          net('already-in-library.movie-no-file', { title: already.title, arr_id: already.arr_id, forced: `MoviesSearch(${already.arr_id})` });
          try {
            await triggerMovieSearch(already.arr_id);
            const job = { type: 'movie' as const, arrId: already.arr_id, title: already.title! };
            const response = `${label} is already in your library but hasn't downloaded yet — I'm grabbing it now.\n<!--JOB:movie:${already.arr_id}:${already.title}-->`;
            jlog('delivery.decision', { conversationId: cid, turn, path: 'already-in-library.movie-no-file', text: response, job });
            return { response, job };
          } catch (err) {
            jlog('error', { where: 'MoviesSearch-trigger', title: already.title, arr_id: already.arr_id, error: String(err) });
            const response = `${label} is in your library but hasn't downloaded yet — I tried to kick off another search but hit a snag. Give it another try in a bit.`;
            jlog('delivery.decision', { conversationId: cid, turn, path: 'already-in-library.movie-no-file-error', text: response });
            return { response };
          }
        }
        // TV analogue (2026-05-24): a SERIES in the library but missing episodes. The /series/lookup
        // result has ZEROED statistics, so fetch /series/{id} for the real episode counts. Incomplete
        // when monitored-aired episodes (episodeCount) exceed episodes with files (episodeFileCount).
        // If incomplete, trigger a series-scoped SeriesSearch (grabs the missing monitored episodes),
        // register a follow-up job, and override even a parroted "already in your library" — the user
        // can't watch episodes that aren't there. A fully-complete series falls through to the clean
        // reply. If we can't determine completeness (no stats / fetch failed), fall through (safe).
        if (lastSearchWasTv && typeof already.arr_id === 'number' && already.arr_id > 0) {
          let incomplete = false;
          try {
            const series = await getSonarrSeries(already.arr_id);
            const st = series.statistics;
            if (st && typeof st.episodeCount === 'number' && st.episodeCount > 0) {
              incomplete = (st.episodeFileCount ?? 0) < st.episodeCount;
            }
          } catch (err) {
            jlog('error', { where: 'getSonarrSeries-completeness', arr_id: already.arr_id, error: String(err) });
          }
          if (incomplete) {
            net('already-in-library.series-incomplete', { title: already.title, arr_id: already.arr_id, forced: `SeriesSearch(${already.arr_id})` });
            try {
              await triggerSeriesSearch(already.arr_id);
              const job = { type: 'tv' as const, arrId: already.arr_id, title: already.title! };
              const response = `${label} is already in your library but some episodes haven't downloaded yet — I'm grabbing them now.\n<!--JOB:tv:${already.arr_id}:${already.title}-->`;
              jlog('delivery.decision', { conversationId: cid, turn, path: 'already-in-library.series-incomplete', text: response, job });
              return { response, job };
            } catch (err) {
              jlog('error', { where: 'SeriesSearch-trigger', title: already.title, arr_id: already.arr_id, error: String(err) });
              const response = `${label} is in your library but some episodes haven't downloaded yet — I tried to kick off another search but hit a snag. Give it another try in a bit.`;
              jlog('delivery.decision', { conversationId: cid, turn, path: 'already-in-library.series-incomplete-error', text: response });
              return { response };
            }
          }
        }
        // It IS fully in the library (movie has a file / series is complete). Only emit the canned
        // reply if the model didn't already say so — never overwrite a good already-have answer.
        const saysAlready = /already (in|added|available|have|got)|in your library/i.test(content);
        if (!saysAlready) {
          net('already-in-library.complete', { title: already.title, query: lastSearchQuery });
          const response = `${label} is already in your library.`;
          jlog('delivery.decision', { conversationId: cid, turn, path: 'already-in-library.complete', text: response });
          return { response };
        }
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
      // Fire when the model ASKS ("which seasons?") on a short show OR when it FALSELY CLAIMS it
      // added the show (claimsAddWithoutExecuting) — the post-search arm of the Star City false-add
      // bug: net #2 forced a real search, the search found a clear short-show match, but the model
      // narrated "I've added it" without calling add_tv. A short dominant show needs no season
      // question, so add all its seasons deterministically instead of delivering the false claim.
      const shortShowDirectAdd = phrasePick === null && avail.length > 0 && avail.length < 3
        && (/\?/.test(content) || claimsAddWithoutExecuting(content)) && !siblingVersions;
      const picked = phrasePick !== null ? phrasePick : (shortShowDirectAdd ? 'all' : null);
      if (picked !== null && top?.tvdb_id) {
        nudgedForSeasonSelect = true;
        net('season-selection', { userMessage, picked, title: top.title, tvdb_id: top.tvdb_id, shortShowDirectAdd });
        const outcome = await runTool('add_tv', { tvdb_id: top.tvdb_id, title: top.title, seasons: picked === 'all' ? undefined : picked }, senderPhone, activeJobs);
        jlog('tool.result', { conversationId: cid, turn, tool: 'add_tv', via: 'season-selection-net', result: outcome.result, job: outcome.job });
        if (outcome.result?.ok === true && outcome.job) {
          const seasonsAdded = (outcome.result.seasons as number[] | string);
          const seasonText = picked === 'all' || seasonsAdded === 'all'
            ? 'all seasons' : `season${(Array.isArray(seasonsAdded) ? seasonsAdded : []).length === 1 ? '' : 's'} ${(Array.isArray(seasonsAdded) ? seasonsAdded : []).join(', ')}`;
          const response = `Added ${top.title}${top.year ? ` (${top.year})` : ''} — grabbing ${seasonText} now.\n<!--JOB:tv:${outcome.job.arrId}:${outcome.job.title}-->`;
          jlog('delivery.decision', { conversationId: cid, turn, path: 'season-selection-add', text: response, job: outcome.job });
          return { response, job: outcome.job };
        }
        if (outcome.result?.already_in_library === true) {
          const response = `${outcome.result.title} is already in your library.`;
          jlog('delivery.decision', { conversationId: cid, turn, path: 'season-selection-already-in-library', text: response });
          return { response };
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
      net('tv-show-disambig', { content: truncate(content, 300), title: top?.title, seasonCount: count, forced: 'seasons question' });
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: `I mean "${top?.title}"${top?.year ? ` (${top.year})` : ''} — the obvious one, don't ask which show. It has ${count} seasons. Ask me which seasons I want (or "all") in one short question. Do not add anything yet.`,
      });
      continue;
    }

    // SAFETY NET #13 — cross-type search fallback (movie↔TV): the user gave a type-AMBIGUOUS request
    // (a bare title, no "movie"/"show"/"season" signal), the search that ran came back EMPTY, and the
    // OTHER media type has NOT been searched yet this turn. Jeff's bug (2026-05-23): "keep sweet pray
    // and obey" is a TV show; Jedd searched MOVIES, found nothing, and said "couldn't find that one"
    // instead of trying TV. The rule: Jedd may only say not-found after BOTH a movie AND a TV search
    // come up empty. So before accepting a not-found reply, force the cross-type search. Gated on:
    //   - requestedType === null (the user did NOT pin movie/TV — respect explicit requests)
    //   - exactly one type searched AND it was empty, the other not yet searched
    //   - no successful add and no pending season question (those are real outcomes, not not-found)
    // Fires once (nudgedForCrossSearch) so it can't ping-pong. If the cross search ALSO comes back
    // empty, this net won't re-fire (the other type is now searched) and the model's not-found reply
    // stands. We force the search rather than trusting a prompt rule because the 7b model is
    // unreliable — the deterministic net is the guarantee.
    const oneTypeSearchedEmpty =
      (movieSearched && movieSearchEmpty && !tvSearched) ||
      (tvSearched && tvSearchEmpty && !movieSearched);
    if (requestedType === null && oneTypeSearchedEmpty && !addToolUsed && !pendingSeasonQuestion
        && !nudgedForCrossSearch) {
      nudgedForCrossSearch = true;
      const otherIsTv = movieSearched && !tvSearched; // searched movie → now try TV
      const crossFn = otherIsTv ? 'search_tv' : 'search_movie';
      const crossTitle = lastSearchQuery || 'the title I asked for';
      net('cross-type-fallback', { emptyType: movieSearched ? 'movie' : 'tv', forced: crossFn, crossTitle });
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: `Before you say you couldn't find it, check the other type — it might be a ${otherIsTv ? 'TV show' : 'movie'}. Call ${crossFn} RIGHT NOW with query "${crossTitle}". Only if THAT also returns nothing may you say you couldn't find it. Make the tool call now, not a reply.`,
      });
      continue;
    }

    // SAFETY NET #14 — not-found DESPITE a real match (carry the search result forward, don't drop it).
    // After a search returns a clearly-DOMINANT match for the title — most often the cross-type fallback
    // (net #13) that just forced a search_tv and FOUND the show — the small model sometimes STILL replies
    // "couldn't find it as a movie or TV show", discarding the result it already has (the live "U.S.
    // Against the World" bug, 2026-06-16: movie search empty → net #13 forced search_tv → FOUND the
    // docuseries → model said not-found anyway, so Jeff had to re-ask "it's a tv show"). A not-found
    // reply is only honest after the search came up EMPTY — here it didn't. So when the model refuses
    // as not-found but we hold a dominant top result, do NOT accept it: surface that result and force
    // the right next action — ASK which seasons for a long (pending-season-question) show, otherwise
    // force the ADD. Anti-bluff is unchanged: the model must still produce a real ok:true add before any
    // "added" claim is delivered (the add path + FINAL GUARD own that; no add is fabricated here).
    // Gated on a dominant top result (a genuine miss — search returned only near-miss/unrelated titles —
    // is NOT dominant via topResultIsDominant, so a real not-found still stands) and fires once.
    if (searchToolUsed && !addToolUsed && !nudgedForFoundButRefused
        && refusesWithoutSearching(content) && topResultIsDominant(lastSearchQuery, lastSearchResults)) {
      nudgedForFoundButRefused = true;
      const top = lastSearchResults[0];
      const label = `${top?.title}${top?.year ? ` (${top.year})` : ''}`;
      // Base the long-vs-short decision on the DOMINANT top result's OWN season count, not the
      // session-wide pendingSeasonQuestion (which can be set by a non-top result). >=3 → ask which
      // seasons; otherwise (short show OR movie) → force the add directly.
      const topSeasonCount = Array.isArray(top?.seasons) ? top!.seasons!.length : 0;
      const isLongShow = lastSearchWasTv && topSeasonCount >= 3;
      net('found-but-said-notfound', { content: truncate(content, 300), title: top?.title, isTv: lastSearchWasTv, topSeasonCount, isLongShow, pendingSeasonQuestion });
      messages.push({ role: 'assistant', content });
      if (isLongShow) {
        // Mark over-disambig handled so net #10 doesn't also fire on the model's forced seasons reply.
        nudgedForOverDisambig = true;
        messages.push({
          role: 'user',
          content: `You DID find it — "${label}" came back in the search results, so do NOT say you couldn't find it. It has ${topSeasonCount} seasons. Ask me which seasons I want (or "all") in one short question. Do not add anything yet.`,
        });
      } else {
        const addFn = lastSearchWasTv ? 'add_tv' : 'add_movie';
        const idLabel = lastSearchWasTv ? 'tvdb_id' : 'tmdb_id';
        const topId = lastSearchWasTv ? top?.tvdb_id : top?.tmdb_id;
        messages.push({
          role: 'user',
          content: `You DID find it — "${label}" came back in the search results, so do NOT say you couldn't find it. Call ${addFn} RIGHT NOW using ${idLabel} ${topId ?? 'from the top search result'}. Make the add call now, not a not-found reply.`,
        });
      }
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
      net('over-disambiguation', { content: truncate(content, 300), forced: addFn, title: top?.title, id: topId });
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
        net('universal-stall-backstop.honest-error', { nudges: stallBackstopNudges, content: truncate(content, 300) });
        const response = `I couldn't get that done just now — give it another try in a sec.`;
        jlog('delivery.decision', { conversationId: cid, turn, path: 'stall-backstop-cap', text: response });
        return { response };
      }
      const looksStatus = userAskedStatus || /\b(status|check|ready|downloading|how'?s it|progress|update)\b/i.test(content);
      const titlePart = statusTitle ? ` with title "${statusTitle}"` : '';
      net('universal-stall-backstop', { content: truncate(content, 300), forced: looksStatus ? 'check_status' : 'a search/add', nudge: `${stallBackstopNudges}/${STALL_BACKSTOP_CAP}` });
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
        net('raw-toolcall-string.honest-error', { nudges: rawToolCallNudges, suppressed: truncate(content, 300) });
        const response = `I hit a snag with that just now — give it another try in a sec.`;
        jlog('delivery.decision', { conversationId: cid, turn, path: 'raw-toolcall-cap', text: response, suppressed: truncate(content, 300) });
        return { response };
      }
      net('raw-toolcall-string', { content: truncate(content, 300), forced: 're-force proper tool call', nudge: `${rawToolCallNudges}/${RAW_TOOLCALL_CAP}` });
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: 'Do NOT write the tool call as text — actually invoke it. Make a real tool call now (search_movie / search_tv / add_movie / add_tv / check_status as appropriate), and after it returns reply with ONLY the plain-language result. Never put a function call like search_movie({...}) in your message text.',
      });
      continue;
    }

    // FINAL GUARD — false add success. The model claims it added something but NO add tool returned
    // ok:true this session (addToolUsed=false). NEVER tell the user it's added when it isn't — the
    // live Star City bug (2026-05-31): the model fabricated the entire flow with ZERO tool calls,
    // net #2 forced once, the model re-claimed success as text, and the lie reached the user. An
    // "I've added X" reply is only honest after a real successful add (addToolUsed is set true ONLY
    // on outcome.result.ok===true). The deterministic add nets (#8/#9/#11) return their own correct
    // strings earlier, so anything reaching here with an unbacked add-claim is a fabrication —
    // suppress it and deliver an honest failure instead. This is the hard guarantee for the
    // false-success bug; it runs LAST, after every forcing net has had its chance to make a real add.
    if (!addToolUsed && claimsAddWithoutExecuting(content)) {
      const response = `I wasn't able to add that just now — something went wrong on my end and nothing was actually added. Tell me the exact title (and the year, if you know it) and I'll try again.`;
      net('FINAL-GUARD.false-add', { suppressed: truncate(content, 500), reason: 'no successful add this session', delivered: response });
      jlog('delivery.decision', { conversationId: cid, turn, path: 'final-guard-false-add', blocked: truncate(content, 500), text: response });
      return { response };
    }

    // FINAL GUARD — false provision success. The model claims a Jellyfin invite/account was sent or
    // created, but NO provision_jellyfin call returned ok:true this session. Same class as the
    // false-add guard: never tell the owner an invite went out when it didn't. provisionSucceeded is
    // set true ONLY on outcome.result.ok===true, so an unbacked "invite sent/account created" reply
    // is a fabrication — suppress it and deliver an honest failure.
    if (!provisionSucceeded && claimsProvisionWithoutExecuting(content)) {
      const response = `I wasn't able to set that up just now — nothing was actually created or sent. Give me the email or phone again and I'll retry.`;
      net('FINAL-GUARD.false-provision', { suppressed: truncate(content, 500), reason: 'no successful provision this session', delivered: response });
      jlog('delivery.decision', { conversationId: cid, turn, path: 'final-guard-false-provision', blocked: truncate(content, 500), text: response });
      return { response };
    }

    // FINAL GUARD — verified provision confirmation. A provision_jellyfin call returned ok:true this
    // session, meaning the invite was created AND its code was read back from jfa-go (and, for the
    // phone path, actually texted). The owner-facing confirmation MUST carry the REAL recipient + the
    // read-back-verified link — never whatever the 7b narrates. The 2026-06-06 incident: a real invite
    // WAS created, but the model reported a hallucinated "joey@example.com". So OVERRIDE the model's
    // narration with a deterministic message built from the verified tool result. This is the hard
    // guarantee for acceptance criteria #1 (real recipient, never a placeholder) and #3 (only the
    // verified link + recipient). Runs only on a genuine success — failures are handled by the guard
    // above and the model's own honest-error relays.
    if (provisionSucceeded && provisionResult) {
      // Enforce the invariant rather than assume it: an ok:true result must carry BOTH a real
      // recipient and a verified link. If either is somehow missing, fail loud (honest error) rather
      // than emit a malformed "...emailed it to  (single-use..." — never report a half-verified result.
      if (!provisionResult.recipient || !provisionResult.invite_url) {
        const response = `I wasn't able to confirm that invite just now — give me the email or phone again and I'll retry.`;
        net('FINAL-GUARD.provision-confirm-incomplete', { result: provisionResult, delivered: response });
        jlog('delivery.decision', { conversationId: cid, turn, path: 'final-guard-provision-incomplete', text: response, result: provisionResult });
        return { response };
      }
      const response = buildProvisionConfirmation({
        channel: provisionResult.channel,
        recipient: provisionResult.recipient,
        invite_url: provisionResult.invite_url,
        hours: config.jfago.inviteValidityHours,
        imessage_unverified: provisionResult.imessage_unverified === true,
      });
      net('FINAL-GUARD.provision-confirm', { channel: provisionResult.channel, recipient: provisionResult.recipient, model_narration: truncate(content, 500), delivered: response });
      jlog('delivery.decision', { conversationId: cid, turn, path: 'final-guard-provision-confirm', text: response, model_narration: truncate(content, 500) });
      return { response };
    }

    // Strip any dangling "I'll check the other years if you're interested" style follow-up offer the
    // model tacks on after a complete answer (Jeff's no-future-promises rule; live Apex reply,
    // 2026-05-22). The answer is already complete — this only removes the trailing empty offer.
    let response = stripTrailingOffer(content);
    const offerStripped = response !== content;
    if (lastJob) response += `\n<!--JOB:${lastJob.type}:${lastJob.arrId}:${lastJob.title}-->`;
    jlog('delivery.decision', {
      conversationId: cid, turn, path: 'model-final-text',
      text: truncate(response, 2000), offerStripped, job: lastJob,
      toolUsedThisSession, searchToolUsed, addToolUsed,
    });
    return { response, job: lastJob };
  }

  // Net C — graceful multi-item fallback. The deterministic franchise handler runs before the loop,
  // so reaching here on a multi-item request means it couldn't be resolved (e.g. no TMDB collection)
  // and the model thrashed to exhaustion. Don't dead-end with "give it another try" (it'd fail the
  // same way) — guide the user to ask one title at a time. Only for apparent multi-item requests.
  if (looksLikeMultiItemRequest(userMessage)) {
    net('hops-exhausted.multi-item-guidance', { hops: MAX_TOOL_HOPS });
    jlog('delivery.decision', { conversationId: cid, turn, path: 'hops-exhausted-multi-item', text: MULTI_ITEM_GUIDANCE });
    return { response: MULTI_ITEM_GUIDANCE };
  }

  // Hops exhausted. If we were mid-recovery on a failed add (owed a search/add that never
  // completed), do NOT throw a false "I'm searching" promise — return an honest error so the user
  // knows nothing was added and can retry (the multi-turn Severance backstop, 2026-05-22). Any
  // other exhaustion (genuinely stuck) still throws and session-manager replies with an error.
  if (addFailedNeedsSearch && !addToolUsed) {
    const title = failedAddTitle || 'that';
    net('hops-exhausted.mid-recovery-honest-error', { hops: MAX_TOOL_HOPS, title });
    const response = `I hit a snag adding ${title} just now — give it another try in a sec.`;
    jlog('delivery.decision', { conversationId: cid, turn, path: 'hops-exhausted-mid-recovery', text: response });
    return { response };
  }
  // Status query that never resolved to a real check_status — honest error, not a dangling
  // "I'm checking now" promise (mirrors the add-recovery backstop, 2026-05-22).
  if (userAskedStatus && !statusToolUsed) {
    net('hops-exhausted.status-honest-error', { hops: MAX_TOOL_HOPS });
    const response = `I couldn't pull the status just now — give it another try in a sec.`;
    jlog('delivery.decision', { conversationId: cid, turn, path: 'hops-exhausted-status', text: response });
    return { response };
  }
  jlog('error', { conversationId: cid, turn, where: 'runLocalSession', error: 'exceeded max tool hops without a final reply', hops: MAX_TOOL_HOPS });
  throw new Error('local model exceeded max tool hops without a final reply');
}
