// Prompt + promise-detectors for the Ollama backend, factored out of local-backend.ts so they
// can be imported and unit-tested without pulling in arr-client/config (which need a reachable
// arr server + env). This module has ZERO runtime dependencies — keep it that way.

/** v2 capabilities-first system prompt. `owner` chooses the owner vs family-member tail.
 *  `displayName` is the bot's persona name (configurable). */
export function systemPromptV2(owner: boolean, displayName = 'Jedd'): string {
  return `You are ${displayName}, a friendly media request assistant for a family. People text you asking for movies and TV shows. ALWAYS help with media requests — that is your whole job.

YOUR DOMAIN IS MOVIES AND TV ONLY. You can ONLY find and download movies and TV shows. You do NOT deal with video games, mobile games, apps, music, or anything else — those tools do not exist for you. When someone names a title, it is ALWAYS a movie or TV show: NEVER ask "is this the mobile game?" or offer game/app options. If a title is ambiguous between a movie and a show, search_movie first (or ask "movie or show?"), but never frame it as a game or anything non-media. Example: "Apex" → treat as a movie/TV title (search_movie), not the video game.

#1 RULE — ACT, DON'T PROMISE. Anything you can do right now (check a status, search, add) you MUST do in this same turn by calling the tool — then reply with ONLY the result. NEVER send a message that narrates intent or asks the user to wait: no "I'll search for that", "I'm checking the status now", "let me look that up", "searching now", "on it", "hang on", "give me a sec", "I'll let you know", or "can you wait a moment?". You do NOT follow up later — there is no later. A reply like that with no tool call is a FAILURE and the user never gets an answer. If you intend to check/search/add, call the tool NOW; only AFTER the tool returns do you write a single reply with the actual result. Also do NOT offer to do more later ("I'll check the other years if you're interested", "let me know and I'll look", "I can look into that for you") — just give the result and stop; if the user wants something else they will ask.

THE SEARCH IS THE SOURCE OF TRUTH — NOT YOUR MEMORY. The search tools query a live, up-to-date catalog that includes brand-new releases. NEVER decide from your own training knowledge whether a title exists, what year it is, or which version is right — you do NOT know about recent movies/shows. A title you have never heard of is almost certainly a real, NEW release: search for it, do not say "I don't know that" or "that doesn't exist". When a title shares its name with an older work you DO know (e.g. a 2025 remake of an old film), do NOT assume the old one — the results are newest-first, so use the result's actual year and tmdb_id/tvdb_id, never a year or id from memory. Always add the entry from the SEARCH RESULTS, exactly as returned.

HOW TO ACT — call the provided tools, do not describe steps or write curl:
- Movie request -> call search_movie, then add_movie with the tmdb_id from the result. If the search returns exactly ONE movie, add it directly — do NOT ask "should I add it?". Only say something is added AFTER add_movie actually returns ok.
- TV request -> call search_tv. If season_count >= 3, ask which seasons and STOP (do not call add_tv yet). If season_count < 3, call add_tv right away (do not ask for confirmation on a short show).
- After the user answers which seasons (or says "all"), call add_tv.
- "Is it ready / how's it going / what's the status of X" -> call check_status NOW. If they named a title, pass it as the title param so you report THAT item's real state. NEVER reply "I'm checking now" or "can you wait a moment" — just call check_status this turn and report the actual status (in your library, downloading with %, still searching, or not added yet) in one message.

NEVER say "I added it" / "it's been added" unless add_movie or add_tv actually returned ok in THIS turn. Searching is not adding. After a search, the next step is the ADD call, then the reply.

MOVIE vs TV — pick the right search tool:
- DEFAULT to search_movie. Only use search_tv when there is a clear TV signal: the user says "show"/"series"/"season"/"episodes", it is a known cartoon / kids' animated series or sitcom, or it is plainly episodic (e.g. "Mickey and the Roadster Racers", "Bluey", "The Office", "Breaking Bad"). A bare film-like title (e.g. "Barbie", "Memento", "Dune") is a MOVIE — call search_movie.
- If unsure and search_movie comes back with a poor/odd match, try search_tv before giving up.
- CROSS-CHECK BEFORE GIVING UP: if the user did NOT say whether it's a movie or a show, and your first search returns NO results, you MUST call the OTHER search tool (search_tv if you tried search_movie, or search_movie if you tried search_tv) BEFORE telling them you couldn't find it. Only say "couldn't find that one" after BOTH a movie search AND a TV search come back empty. Many titles you don't recognize are TV shows — never assume not-found from a single movie search.

CRITICAL — NEVER claim an action you did not actually perform this turn:
- Do NOT say "I added it", "I'll search and add it", "it's been added", or "searching for it now" UNLESS you are calling a search/add tool in this SAME turn. Words are not actions — only a tool call adds anything.
- If the user CHANGES or CORRECTS a request (e.g. "I meant the 2023 version", "actually the other one", "no, the new one"), you MUST call the search tool again and then the add tool for the corrected pick. Do not just reply that you will — actually call the tools now.
- When the user picks from a numbered list or names a year, add THAT specific result: call the add tool with the id of the entry whose year matches their choice. Match by year, never add a different year's entry.

DISAMBIGUATION (multiple search results):
- Search results come back BEST-MATCH FIRST. For a MOVIE with no year given, if the first result's title matches what they asked for, JUST ADD THE FIRST RESULT — call add_movie immediately, do NOT ask "which one?". A casual "add The Matrix" / "get Whiplash" means the obvious well-known film: the top result IS that film, so add it. Asking which one for an obvious request annoys the user — only ask when truly necessary. (For TV, the seasons rule still applies: a 3+ season show must ASK which seasons first, even when adding the first result.)
- ONLY ask "which one?" when it is GENUINELY ambiguous — the title maps to two or more DISTINCT well-known works (e.g. several different films literally sharing the same name with no clear winner), OR the user was vague. A different-year sequel in the list (e.g. "The Matrix Reloaded" under "The Matrix") does NOT make it ambiguous — the exact-title top result still wins. When you do ask, list the options WITH YEARS, MOST RECENT FIRST (newest = option 1) so "the first one" is unambiguous.
- BUT if the user has ALREADY named a year or picked an option (now or in an earlier turn — e.g. "the 2021 one", "the first one", "I meant the 2023 version", or an IMDb/TMDB link), do NOT ask again and do NOT re-run a bare-title search. You ALREADY have the results in this conversation — call add_movie/add_tv NOW with the id of the matching entry. Match a YEAR answer to the result's year; match "the first/second one" to the position in the list you just presented (which is newest-first). Re-searching and re-asking a question they already answered traps them in a loop and is a failure.
- When you know the year (the user said it, or you are re-searching to confirm), pass it as the search tool's "year" param — a SEPARATE field — and keep the query to JUST the title. Do NOT put the year inside the query text (search query="Eternity" with year=2025, NOT query="Eternity 2025"). Never re-search the bare title hoping it narrows — the library returns ALL years regardless of any year in the query text.

RESULT RULES:
- Search returns no results -> reply "Couldn't find that one, sorry." Add nothing.
- Movie or TV search result has in_library: true -> tell them it's already available, do not add again.

REPLY STYLE: plain text, casual, 1-3 sentences. No markdown. Never mention internal services or technical details.

${owner
  ? `The sender is the owner. They have full access — help with anything.`
  : `The sender is a family member. They may request movies and TV and check status — ALL of those are allowed, do them normally. The ONLY thing to refuse: if they ask something unrelated to getting media (chit-chat, questions about how you work, what model you are), call NO tool and reply exactly: "Hey! I can help you find movies and TV shows. Just tell me what you're looking for!"`}`;
}

// Detect a future-tense "I'll do X" promise with no accompanying tool call — the small-model
// failure where it replies as if it acted but never called a tool. Covers search/add intent
// AND status-check intent ("I'm checking the status now", "I'll check on X"): a status promise
// with no check_status call leaves the user with no actual status (Jedd hit this 2026-05-21).
// Deliberately narrow: does not fire on a clarifying question ("which one?") or a real result.
export function promisesActionWithoutTool(text: string): boolean {
  const t = text.toLowerCase();
  // Don't treat a clarifying question as a promise — that's a legit STOP (e.g. "which seasons?").
  if (/\?\s*$/.test(text.trim()) || /which (one|seasons?|version)/.test(t)) return false;
  // Don't treat the canned non-Jeff refusal ("I can help you find movies...") as a promise.
  if (/i can help you find (movies|movies, tv)/.test(t)) return false;
  const searchOrAdd = /\b(i'?ll|i will|let me|going to|gonna)\b[^.!?]*\b(search|look|find|add|grab|get|download|pull up)\b/.test(t)
    || /\b(searching|looking|adding|grabbing) (for |that |it )/.test(t);
  // Status-check promise: "I'm checking the status now", "I'll check on the status of X",
  // "let me check how that's coming". A bare status promise must trigger check_status.
  const statusCheck = /\b(i'?m |i am |i'?ll |i will |let me )?check(ing)?\b[^.!?]*\bstatus\b/.test(t)
    || /\b(i'?ll|i will|let me|i'?m|i am)\b[^.!?]*\bcheck(ing)?\b[^.!?]*\b(on|how)\b/.test(t);
  return searchOrAdd || statusCheck;
}

// Detect a reply that CLAIMS a media item was (or is being) added — "I added it", "I've added
// the 2021 version", "it's been added", "adding it now", "added to the library". This is the
// dominant search-then-no-add failure: the model searches, then NARRATES an add it never made
// (the live Eternity/Dune-correction shape). The loop fires this only when no add tool ran for
// an add-intent request, so it forces the missing add_movie/add_tv. Excludes "already added /
// already in the library" (a legit already-in-library reply) and clarifying questions.
export function claimsAddWithoutExecuting(text: string): boolean {
  const t = text.toLowerCase();
  if (/\?\s*$/.test(text.trim()) || /which (one|seasons?|version)/.test(t)) return false;
  // "already added", "already in the library", "already available" -> legit, not a false claim.
  if (/already (added|in (the )?library|available|have)/.test(t)) return false;
  if (/i can help you find (movies|movies, tv)/.test(t)) return false;
  return /\b(i'?ve|i have|i)\s+added\b/.test(t)
    || /\b(it'?s|it has) been added\b/.test(t)
    || /\badded\b[^.!?]*\b(to the (download )?library|to your library)\b/.test(t)
    || /\b(i'?m|i am)\s+adding\b/.test(t)
    // bare present-progressive "adding X" / "found it, adding ..." (qwen2.5:7b says this without
    // the "I'm" — 2026-05-22). Sentence-initial or after a clause break, followed by a title.
    || /(^|[.!,]\s*)adding\b/.test(t)
    // "started/starting (the )?download" without an add tool having run is also a false claim.
    || /\b(started|starting)\b[^.!?]*\bdownload/.test(t);
}

// Detect a "couldn't find / not available" refusal emitted WITHOUT the model ever calling a
// search tool this session. The live Eternity loop (2026-05-22): a poisoned history of repeated
// "Couldn't find that one, sorry." assistant turns primes qwen2.5-coder to mimic that refusal on
// the next identical request — it pattern-matches the failure instead of searching. The two
// earlier safety nets only catch forward PROMISES and false ADD claims; a flat past-tense
// refusal slips through both. The loop fires this only when no search tool ran for the turn, and
// forces a real search_movie/search_tv. Excludes legit already-in-library replies (those follow a
// real search), clarifying questions, and the canned non-Jeff refusal.
export function refusesWithoutSearching(text: string): boolean {
  const t = text.toLowerCase();
  if (/\?\s*$/.test(text.trim()) || /which (one|seasons?|version)/.test(t)) return false;
  if (/already (added|in (the )?library|available|have)/.test(t)) return false;
  if (/i can help you find (movies|movies, tv)/.test(t)) return false;
  return /\b(could ?n'?t|can'?t|couldn ?not|unable to)\s+find\b/.test(t)
    || /\bno luck\b/.test(t)
    || /\b(does ?n'?t|did ?n'?t|not)\s+(seem to be|appear to be)?\s*(available|found|in (the )?library)\b/.test(t)
    || /\b(can'?t|could ?n'?t|unable to)\s+(get|locate|track down)\b/.test(t);
}

// Does the user's message plausibly contain a real media TITLE worth searching for? Used to gate
// net #3 (refusal/parrot → force a search). Net #3 was built for the POISONED-HISTORY case where
// the user names a real title ("get Eternity 2025") and the model parrots a prior "couldn't find"
// without searching — forcing a search there is correct. But forcing a search on a message with NO
// title — gibberish ("asdkjfh"), a pure non-media request ("play music", "add a book") — makes the
// small model HALLUCINATE a plausible title to satisfy the forcing turn (live 2026-05-22: "asdkjfh"
// → searched + added "Barbie"). So when the message has no plausible title, we let the honest
// clarifying reply ("couldn't find that — what are you looking for?") stand instead of forcing.
//
// Conservative — defaults to TRUE (search) so a real title is never suppressed; returns FALSE only
// for clearly title-less messages: (a) a single gibberish token (a long word with no vowels or an
// improbable consonant run, and not a request phrase), or (b) the whole message is just a non-media
// request verb with no quoted/capitalized title and no other content words.
const NON_MEDIA_NOUNS = /\b(music|song|songs|album|albums|playlist|book|books|ebook|ebooks|podcast|game|games|app|apps|software|spotify|netflix|weather|news)\b/i;
const REQUEST_VERBS = /\b(get|add|download|find|grab|play|want|watch|search|look|pull up)\b/i;
export function messageHasPlausibleTitle(userMessage: string): boolean {
  const raw = (userMessage || '').trim();
  if (!raw) return false;
  const t = raw.toLowerCase();
  // Strip leading request framing ("can you", "could you", "please", "for me", trailing "plz").
  const stripped = t
    .replace(/\b(can|could|would|will)\s+(you|we|u)\b/g, ' ')
    .replace(/\bplease\b|\bplz\b|\bpls\b|\bfor me\b|\bthanks?\b/g, ' ')
    .replace(/[?.!,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Tokens that are NOT request verbs / fillers — the candidate "title" words.
  const FILLER = new Set(['a', 'an', 'the', 'me', 'us', 'you', 'i', 'to', 'of', 'and', 'or', 'some', 'new', 'latest', 'movie', 'film', 'show', 'series', 'tv', 'season']);
  const tokens = stripped.split(' ').filter(Boolean);
  const contentTokens = tokens.filter(w => !REQUEST_VERBS.test(w) && !FILLER.has(w));
  // A pure non-media request with no real title ("play music", "add a book"): every content token
  // is a non-media noun (or there are none), so there's no media title to search. A proper-noun
  // title ("Taylor Swift album", "Spotify"-the-name) still has capitalized/non-noun content, so it
  // is left to search (it may legitimately match a concert film) — we only suppress the truly
  // contentless cases. NOTE: "download Spotify" is a single non-media noun token → suppressed.
  if (contentTokens.length === 0) return false;
  const allNonMedia = contentTokens.every(w => NON_MEDIA_NOUNS.test(w));
  if (allNonMedia) return false;
  // Single-token gibberish: one content token, length >= 6, with no vowel OR a run of 4+ consonants
  // and not a real-looking word. ("asdkjfh" → no vowels in a long token = gibberish.) A real one-word
  // title (Barbie, Memento, Inception, Amélie) has normal vowel structure and passes.
  if (contentTokens.length === 1) {
    const w = contentTokens[0].replace(/[^a-zà-ÿ]/g, '');
    if (w.length >= 6) {
      const vowels = (w.match(/[aeiouyà-ÿ]/g) || []).length;
      const longConsonantRun = /[bcdfghjklmnpqrstvwxz]{4,}/.test(w);
      if (vowels === 0 || (longConsonantRun && vowels / w.length < 0.2)) return false;
    }
  }
  return true;
}

// Detect a "I found multiple results / which one did you mean?" disambiguation question emitted
// WITHOUT the model having searched this session. Same poisoned-history root cause as
// refusesWithoutSearching, but the parroted reply is a QUESTION ("I found multiple results for
// 'Eternity'. Which one?") — which refusesWithoutSearching deliberately excludes. If the model
// never searched this turn, it CANNOT have real results to disambiguate; it's parroting a prior
// turn. Net #3 uses this (gated on !searchToolUsed) to force a real search. The season question
// ("which seasons?") is legit AFTER a search, so it's only a problem when no search ran — the
// !searchToolUsed gate in the loop handles that; here we just match the multiple-results shape.
export function claimsResultsWithoutSearching(text: string): boolean {
  const t = text.toLowerCase();
  if (/i can help you find (movies|movies, tv)/.test(t)) return false;
  // "which seasons" is a legitimate post-search question shape — don't treat it as parroting.
  if (/which seasons?/.test(t) && !/multiple|several|found \d|versions?/.test(t)) return false;
  return /\b(found|there are|i see)\b[^.!?]*\b(multiple|several|\d+|two|three|a few|some)\b[^.!?]*\b(results?|versions?|matches?|movies?|shows?|options?)\b/.test(t)
    || /\bmultiple results?\b/.test(t)
    || /\bwhich (one|version)\b[^.!?]*(do you mean|did you mean|would you like)/.test(t);
}

// Detect a "stall / hold-on" reply that promises imminent work but contains NO tool call — the
// model says it is busy ("I'm searching now", "give me a moment", "hang on", "let me look",
// "one sec") and ENDS the turn without doing anything. This is the dangling-promise failure that
// slips past every other net: it is not a forward "I'll add it" promise (net #1), not a false add
// claim (net #2), not a refusal/disambiguation (net #3) — it's a content-free "wait a moment"
// (the multi-turn Severance bug, 2026-05-22, where the model answered the forced-search nudge with
// "I'm searching for Severance now. Can you wait a moment?" and stopped). When the loop has a
// PENDING forced action and gets one of these, it must keep forcing, not accept the stall.
// Deliberately distinct from promisesActionWithoutTool: that one keys off search/add VERBS; this
// one keys off the WAIT/HOLD shape that has no verb of completion. A genuine clarifying question
// ("which seasons?") is excluded so we never re-force a legit STOP.
export function stallsWithoutTool(text: string): boolean {
  const t = text.toLowerCase();
  if (/which (one|seasons?|version)/.test(t)) return false;
  if (/i can help you find (movies|movies, tv)/.test(t)) return false;
  // "wait / hold on / hang on / one sec / a moment / a second / a minute / just a"
  const holdShape = /\b(wait a (moment|sec(ond)?|minute)|hold on|hang on|one (sec|moment|second|minute)|just a (sec(ond)?|moment|minute)|give me a (sec(ond)?|moment|minute)|bear with me|stand by)\b/.test(t)
    || /\bcan you (wait|hold)\b/.test(t)
    || /\b(please )?wait\b[^.!?]*\b(moment|sec|second|minute|while)\b/.test(t);
  // present-progressive "I'm searching/looking/checking ... now/right now" with no tool call —
  // a stall when emitted as the WHOLE reply (the model narrates work it isn't doing).
  const busyShape = /\b(i'?m|i am)\s+(searching|looking|checking|working on|getting|pulling up|fetching)\b/.test(t)
    || /\b(searching|looking|checking)\b[^.!?]*\b(right )?now\b/.test(t)
    || /\blet me (look|search|check|see|find)\b/.test(t);
  return holdShape || busyShape;
}

// UNIVERSAL stall backstop: ANY text-only reply where Jedd narrates that it is about to do
// something (check/search/add) or asks the user to wait, instead of having done it. This is the
// hard rule (Jeff, 2026-05-22): for anything Jedd can do right now (status/search/add) it must
// perform the tool call synchronously and return ONLY the result — it must NEVER deliver an
// "I'm checking/searching/doing X now / wait a moment / hang on / I'll get back to you" message.
//
// This detector is INTENTIONALLY broad and does NOT bail on a trailing "?" (so "...can you wait a
// moment?" is caught) — the loop only consults it when NO tool ran for the turn, so a false
// positive can at worst force one extra real tool call, never a wrong action. It excludes:
//   - the canned off-topic refusal,
//   - genuine clarifying questions we must preserve (which one? / which seasons?),
//   - replies that already state a CONCRETE result (a %, terminal state, "not added", "couldn't
//     find", "still searching") so a real post-tool report is never re-forced.
export function isStallReply(text: string): boolean {
  const t = text.toLowerCase();
  if (/i can help you find (movies|movies, tv)/.test(t)) return false;
  // Preserve legitimate clarifying questions — those are correct STOPs, not stalls.
  if (asksWhichOne(text)) return false;
  if (/which seasons?\b/.test(t) || /\bseasons?\b[^.!?]*\b(want|would you like|should i)\b/.test(t)) return false;

  // "Doing it now" / "about to do it" framing — present-progressive or future, any verb of work.
  const doingNowShape = /\b(i'?m|i am)\s+(searching|looking|checking|working on|getting|pulling up|fetching|adding|grabbing|finding)\b/.test(t)
    || /\b(i'?ll|i will|i'?m going to|gonna|i'?m about to|let me)\b[^.!?]*\b(search|look|check|see|find|add|grab|get|pull up|fetch|look into)\b/.test(t)
    || /\b(searching|looking|checking|adding|grabbing)\b[^.!?]*\b(right )?now\b/.test(t)
    || /\b(on it|looking into it)\b/.test(t)
    || /\bi'?ll (let you know|get back to you|update you|report back)\b/.test(t);
  // "Wait / hold on / give me a sec" framing.
  const waitShape = /\b(wait a (moment|sec(ond)?|minute)|hold on|hang on|one (sec|moment|second|minute)|just a (sec(ond)?|moment|minute)|give me a (sec(ond)?|moment|minute)|bear with( me)?|stand by)\b/.test(t)
    || /\bcan you (wait|hold)\b/.test(t)
    || /\b(please )?wait\b[^.!?]*\b(moment|sec|second|minute|while)\b/.test(t);
  if (!doingNowShape && !waitShape) return false;

  // Don't re-force a reply that ALREADY carries a concrete result (so a genuine post-tool report,
  // which may also contain incidental verbs, is never treated as a stall). NOTE: match only RESULT
  // framing — NOT bare "searching" (a stall like "I'm searching for that now" contains "searching"
  // but is NOT a result), so the "still searching / queued" terminal state requires the qualifier.
  const concreteAnswer = /\b\d{1,3}\s?%/.test(t)
    || /\b(downloaded|ready to watch|finished downloading|already (in|available|added)|added .+ (now|—)|grabbing .+ now)\b/.test(t)
    || /\b(not (in your library|added|been added|downloading)|isn'?t (in your library|added|downloading)|nothing (is )?(currently )?downloading|no active downloads|hasn'?t (been )?(added|started))\b/.test(t)
    || /\b(couldn'?t find|can'?t find|don'?t see)\b/.test(t)
    || /\b(still searching|queued|in the queue|looking for a release)\b/.test(t);
  // A confirmed add ("Added X — grabbing all seasons now") contains "grabbing ... now" but is a
  // real result, handled by concreteAnswer above.
  return !concreteAnswer;
}

// The known tool names, duplicated here (local-prompt has ZERO runtime deps and can't import the
// tool schema from local-backend without a cycle). Keep in sync with the `tools` array there.
const KNOWN_TOOL_NAMES = ['search_movie', 'search_tv', 'add_movie', 'add_tv', 'check_status'];
// Match a function-call invocation emitted as PLAIN TEXT, e.g. `search_movie({"query": "Apex"})` or
// `add_tv({"tvdb_id": 12345, "title": "X"})`. qwen2.5:7b sometimes prints the tool call as literal
// content instead of making a real function/tool call — if that text is delivered, the user gets
// gibberish (live Apex bug, 2026-05-22). The arg blob is captured for JSON parsing by the caller.
const INLINE_TOOLCALL_RE = new RegExp(`\\b(${KNOWN_TOOL_NAMES.join('|')})\\s*\\(\\s*(\\{[\\s\\S]*\\})\\s*\\)`);

// Parse a raw `toolName({...json...})` invocation out of free text. Returns the tool name and the
// parsed argument object when the text contains a recognizable tool-call syntax with a valid JSON
// arg blob; otherwise null. Tolerates surrounding prose ("Sure! search_movie({\"query\":\"Apex\"})").
// The JSON blob is brace-matched from the first `{` after the paren so trailing prose doesn't break
// JSON.parse. This is the parser arm of the raw-tool-call fix — the loop PARSES + EXECUTES the call
// instead of ever delivering the literal string to the user.
// Brace-match a `{...}` JSON arg blob starting at braceStart and JSON.parse it. Returns the call or
// null if the braces don't balance / the blob isn't a JSON object.
function braceMatchArgs(text: string, braceStart: number, name: string): { name: string; arguments: Record<string, unknown> } | null {
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;
  try {
    const args = JSON.parse(text.slice(braceStart, end + 1));
    if (args && typeof args === 'object' && !Array.isArray(args)) return { name, arguments: args as Record<string, unknown> };
  } catch { /* unparseable arg blob */ }
  return null;
}

export function parseInlineToolCall(text: string): { name: string; arguments: Record<string, unknown> } | null {
  if (!text) return null;
  // Match a known tool name followed by an opener — either `(` (function-call form,
  // `search_movie({...})`) or `{` (space-brace, NO-PAREN form qwen2.5:7b leaks live, e.g.
  // `search_movie {"query":"Hook"}` / `check_status {}` — the Hook bug, 2026-05-24).
  const nameMatch = text.match(new RegExp(`\\b(${KNOWN_TOOL_NAMES.join('|')})\\s*([({])`));
  if (!nameMatch) return null;
  const name = nameMatch[1];
  const opener = nameMatch[2];
  const openerIdx = nameMatch.index! + nameMatch[0].length - 1; // index of the `(` or `{`
  if (opener === '{') {
    // No-paren form: the brace IS the arg blob.
    return braceMatchArgs(text, openerIdx, name);
  }
  // Paren form: brace-match the JSON arg blob starting at the first `{` after the opening paren.
  const braceStart = text.indexOf('{', openerIdx);
  if (braceStart === -1) {
    // `toolName()` with no args, or `toolName(...)` with non-JSON args — treat as an empty-arg call
    // only when the parens are clearly empty; otherwise we can't parse it, return null.
    const after = text.slice(openerIdx + 1).trimStart();
    if (after.startsWith(')')) return { name, arguments: {} };
    return null;
  }
  return braceMatchArgs(text, braceStart, name);
}

// True when the text LOOKS like a raw tool-call invocation for a known tool (`toolName({...})` or
// `toolName(...)`), regardless of whether the JSON args parse. Used as a FINAL delivery guard: a
// reply matching this must NEVER be sent to the user verbatim — at best it's an unexecuted tool
// call, at worst gibberish (the live Apex bug, 2026-05-22). When parseInlineToolCall can extract a
// clean call we execute it; when it can't, we suppress + re-force rather than deliver the string.
export function looksLikeRawToolCall(text: string): boolean {
  if (!text) return false;
  if (INLINE_TOOLCALL_RE.test(text)) return true;
  // `toolName(` (paren form, possibly malformed args) OR `toolName {` (space-brace, NO-PAREN form,
  // qwen's `search_movie {"query":"Hook"}` / `check_status {}` — the Hook bug, 2026-05-24). Catches a
  // malformed blob parseInlineToolCall can't cleanly parse, so it's suppressed rather than delivered.
  return new RegExp(`\\b(${KNOWN_TOOL_NAMES.join('|')})\\s*[({]`).test(text);
}

// Strip a trailing "offer to do more later" sentence from an otherwise-complete reply. qwen2.5:7b
// often answers correctly then tacks on a follow-up offer it will never fulfill — "I'll check the
// other years if you're interested.", "Let me know and I'll look.", "I can look into that for you."
// (live 2026-05-22, the Apex reply). Jeff's hard rule: Jedd does not promise future work. The reply
// already carries the real answer, so this is NOT a stall to re-force — we just remove the dangling
// offer at delivery. Only strips a SENTENCE that is purely such an offer; never touches the answer.
const TRAILING_OFFER_RE = /(?:^|[.!?]\s+)((?:i'?(?:ll|d)|i can|i could|let me|just let me|feel free to|if you'?(?:d| would) like,? i'?(?:ll|d))\b[^.!?]*\b(?:check|look|search|find|see|let you know|get back|look into|update you|reach out|dig)\b[^.!?]*[.!?]?)\s*$/i;
export function stripTrailingOffer(text: string): string {
  if (!text) return text;
  let out = text.trim();
  // Strip up to two trailing offer sentences (some replies stack "...is in your library. I'll
  // check the other years. Let me know!"), but never strip the whole reply to empty.
  for (let i = 0; i < 2; i++) {
    const m = out.match(TRAILING_OFFER_RE);
    if (!m) break;
    const candidate = out.slice(0, out.length - m[1].length).trim().replace(/[\s,;:-]+$/, '').trim();
    if (!candidate) break; // would empty the reply — keep it as-is
    out = candidate;
    // Re-close punctuation if we trimmed mid-sentence.
    if (!/[.!?]$/.test(out)) out += '.';
  }
  return out;
}

// Deterministically resolve a SEASON-SELECTION phrase from the user against a show's REAL season
// list. qwen2.5:7b is unreliable at this math — it guessed [1,8] for a 5-season show's "first and
// last" (live 2026-05-22) — so the loop parses the phrase itself and forces the add with exact
// numbers instead of trusting the model. Returns the selected seasons (sorted, deduped, clamped to
// the available list), 'all', or null when the message is NOT a recognizable season phrase (the
// caller then leaves the model to handle it). `available` must be the show's real season numbers.
export function parseSeasonSelection(userMessage: string, available: number[]): number[] | 'all' | null {
  const avail = [...new Set(available.filter(n => n > 0))].sort((a, b) => a - b);
  if (avail.length === 0) return null;
  const t = userMessage.toLowerCase().trim();
  const clamp = (ns: number[]) => {
    const out = [...new Set(ns.filter(n => avail.includes(n)))].sort((a, b) => a - b);
    return out.length ? out : null;
  };
  // "all" / "whole series" / "everything" / "every season" / "the full show"
  if (/\b(all|every|whole|entire|full)\b/.test(t) && !/\bexcept|but not\b/.test(t)) return 'all';
  const first = avail[0];
  const last = avail[avail.length - 1];
  // "the latest / newest / most recent / current / last (season)" — but NOT "first and last".
  const wantsLatest = /\b(latest|newest|most recent|current|last)\b/.test(t);
  const wantsFirst = /\b(first|earliest|original|1st)\b/.test(t);
  if (wantsFirst && (wantsLatest || /\blast\b/.test(t))) return clamp([first, last]); // "first and last"
  if (wantsLatest) return clamp([last]);
  if (wantsFirst) return clamp([first]);
  // Explicit ranges: "seasons 1-3", "season 1 to 3", "1 through 4", "2 thru 5"
  const range = t.match(/\b(\d{1,2})\s*(?:-|–|to|through|thru|until)\s*(\d{1,2})\b/);
  if (range) {
    const a = Number(range[1]), b = Number(range[2]);
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const out: number[] = [];
    for (let n = lo; n <= hi; n++) out.push(n);
    return clamp(out);
  }
  // Explicit numbers anywhere: "season 2", "seasons 1, 3 and 5", "1 and 2", "just 4".
  // Only treat as a season phrase if the word "season" appears OR the whole msg is basically numbers.
  const nums = (t.match(/\b\d{1,2}\b/g) || []).map(Number);
  if (nums.length && (/\bseasons?\b/.test(t) || /^[\s\d,andjust&+-]+$/.test(t))) return clamp(nums);
  return null;
}

// Did the user EXPLICITLY say whether they want a movie or a TV show? Used to gate the cross-type
// search fallback (net #13): when the request is type-AMBIGUOUS (a bare title with no movie/TV
// signal) and the first search comes back empty, Jedd must try the OTHER type before saying
// "couldn't find it" (Jeff's ask, 2026-05-23: "keep sweet pray and obey" is a TV show, but a
// movie-first search found nothing and Jedd gave up instead of trying TV). When the user DID
// specify a type ("the movie X", "the show X", "season 2 of X"), we respect it and skip the
// cross-search. Returns 'movie', 'tv', or null (ambiguous). Mirrors the prompt's MOVIE-vs-TV
// signal list so the gate matches how the model is told to route.
export function requestSpecifiesType(userMessage: string): 'movie' | 'tv' | null {
  const t = userMessage.toLowerCase();
  const tv = /\b(tv ?show|tv ?series|series|season|seasons|episode|episodes|sitcom|cartoon|anime|miniseries|mini-series|show)\b/.test(t);
  const movie = /\b(movie|film|feature|flick)\b/.test(t);
  // If somehow both signals appear, treat as ambiguous (don't guess) so the cross-search can run.
  if (tv && !movie) return 'tv';
  if (movie && !tv) return 'movie';
  return null;
}

// Did the USER ask for the status of something ("what's the status of X", "is X ready yet",
// "how's X coming", "any update on X", "did X finish")? Used to arm the status-stall net: a
// status request that the model answers with text and no check_status call is a stall — Jedd
// must JUST GO LOOK, never reply "I'm checking now, wait a moment" (Jeff's explicit ask,
// 2026-05-22). Kept lenient: this only ARMS a net that is otherwise gated on "no tool ran".
export function isStatusQuery(userMessage: string): boolean {
  const t = userMessage.toLowerCase();
  return /\bstatus\b/.test(t)
    || /\b(is|are|did)\b[^.!?]*\b(ready|done|finished|downloaded|available|in)\b/.test(t)
    // "how's X coming/going/...", "how is X doing/coming/going" — include the spelled-out "how is"
    // and "doing"/"looking" (missed "How is severance doing", 2026-05-22, letting a stall leak).
    || /\bhow'?s?\b[^.!?]*\b(coming|going|doing|looking|download|progress)\b/.test(t)
    || /\bhow is\b[^.!?]*\b(coming|going|doing|looking|download|progress)\b/.test(t)
    || /\b(any )?update(s)?\b/.test(t)
    || /\bhow far along\b/.test(t)
    || /\bwhat'?s? (downloading|in the queue|the progress)\b/.test(t);
}

// Pull the title the user is asking the status of, so a forced check_status can be title-scoped
// ("status of Severance" -> "Severance"). Strips the status framing words and trailing
// punctuation; returns '' when no specific title is named (a bare "what's downloading?" global
// query). Lenient by design — runTool's check_status falls back to a global sweep on a miss, so a
// slightly-off extraction can never make a status query fail.
export function extractStatusTitle(userMessage: string): string {
  let s = userMessage.trim().replace(/[?.!]+$/, '');
  // "status of X", "update on X", "how's X coming", "is X ready/done", "did X finish"
  const patterns = [
    /\b(?:the )?status (?:of|on|for) (.+)$/i,
    /\b(?:any )?updates? (?:of|on|for|about) (.+)$/i,
    /\bhow'?s? (.+?)(?: coming| going| doing| download| progress).*$/i,
    /\bis (.+?) (?:ready|done|finished|downloaded|available|in the library)/i,
    /\bare (.+?) (?:ready|done|finished|downloaded|available)/i,
    /\bdid (.+?) (?:finish|download|come in|land)/i,
    /\bhow far along is (.+)$/i,
  ];
  for (const p of patterns) {
    const m = s.match(p);
    if (m && m[1]) {
      const title = m[1].replace(/^["'`]+|["'`]+$/g, '').replace(/\byet\b/gi, '').trim();
      // Reject pure-pronoun / generic targets — those mean "the global queue", not a title.
      if (title && !/^(it|that|this|things|stuff|anything|everything|my (stuff|requests?|downloads?)|the (download|queue))$/i.test(title)) {
        return title;
      }
    }
  }
  return '';
}

// Detect a "which one did you mean?" disambiguation question — the model SEARCHED, has real
// results, but asks the user to pick instead of just adding the obvious dominant match. This is
// the over-disambiguation failure (Jeff's ask, 2026-05-22): "add The Matrix" / "Whiplash" should
// add the obvious well-known film directly, not ask. Distinct from claimsResultsWithoutSearching
// (net #3), which fires when NO search ran (parroted poisoned history); this one is gated in the
// loop on searchToolUsed AND a deterministic dominance check, so it only overrides a needless ask.
// Excludes the TV "which seasons?" question (that's a correct, separate ask we must preserve) and
// the canned non-Jeff refusal.
export function asksWhichOne(text: string): boolean {
  const t = text.toLowerCase();
  if (/i can help you find (movies|movies, tv)/.test(t)) return false;
  // NEVER treat a season question as disambiguation — the TV "which seasons?" ask stays.
  if (/which seasons?\b/.test(t) || /\bseasons?\b[^.!?]*\b(want|would you like|should i)\b/.test(t)) return false;
  // Only consider replies that are actually ASKING (end in a question) — a flat confirmation
  // ("Added The Matrix, it's downloading") must never be treated as an over-disambiguation.
  if (!/\?/.test(text)) return false;
  return /\bwhich (one|version|movie|film)\b/.test(t)
    || /\b(did|do) you mean\b/.test(t)
    || /\bwhich (of (these|those)|did you want)\b/.test(t)
    // "should I add that/it/this one?" — a needless confirm of the obvious top result.
    || /\bshould i add (that|it|this|the (\d{4}|first|top))\b/.test(t)
    // "would you like to add X ... or one of the others?" / "X from 1999, Y from 2021, or ...?" —
    // the model lists options and asks the user to choose instead of just adding the dominant one.
    || /\bwould you like to (add|get|grab)\b[^?]*\bor\b[^?]*\?/.test(t)
    || /\b(there are|i found|found)\b[^.!?]*\b(multiple|several|a few|two|three|\d+)\b[^.!?]*\b(results?|versions?|matches?|movies?|films?|options?)\b[^.!?]*\?/.test(t)
    // "the most likely one is the 2014 version. Should I add ...?" / "...is X. Add it?" — a
    // most-likely-but-asking-anyway confirm of the dominant match.
    || /\bmost likely\b[^?]*\?/.test(t)
    // "Is it the 2016 version of X you're looking for?" / "Did you mean X from 2022?" — a
    // year/version confirm of the obvious dominant match (live qwen2.5:7b TV phrasing, 2026-05-22).
    || /\bis it the\b[^?]*\b(version|one|\d{4})\b[^?]*\?/.test(t)
    || /\b(from|the)\s+\d{4}\b[^?]*\?/.test(t);
}

// Deterministic dominance check: given the user's query title and the search results (best-match
// first), decide whether the TOP result is a clearly-dominant match we should ADD directly rather
// than ask "which one?". Conservative by design — when in doubt, return false so the model's ask
// stands (a wrong auto-add is far worse than one extra question). Dominant when:
//   - the top result's title closely matches the query (normalized exact / substring either way), AND
//   - it is NOT already in the library (already-in-library is a different reply path), AND
//   - it is NOT genuinely ambiguous: no OTHER result also closely matches the query title (two
//     distinct well-known films of the same name → still ask). A single result is trivially dominant.
// `closeMatch` is STRICTER than titlesRoughlyMatch — it requires a near-exact title match
// (normalized equality, or equal after dropping leading articles), not just a shared content word,
// so "The Matrix" does not count "Matrix Reloaded" (a sequel) as the same work.
//
// When OTHER results also exactly match the query title (e.g. seven distinct films all titled
// "Whiplash"), the title alone can't disambiguate — so we fall back to POPULARITY: the top result
// is still dominant if it is FAR more popular than the best same-title runner-up (the 2014 Whiplash
// at popularity 21.7 vs the next at 1.5 — a clear winner the user obviously means). Without a clear
// popularity gap (or no popularity data), we keep asking — a coin-flip must never auto-add.
const POP_DOMINANCE_RATIO = 4;   // top must be >= 4x the runner-up's popularity
const POP_DOMINANCE_FLOOR = 3;   // ...and have at least this absolute popularity (filters noise)

// Shared near-exact title match used by the dominance + already-in-library checks. Normalized
// equality or equal after dropping a leading article, with a trailing year stripped from the query.
// STRICTER than titlesRoughlyMatch (which matches on any shared content word) so a sequel like
// "Matrix Reloaded" never counts as "The Matrix".
function closeTitleMatch(query: string, resultTitle: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const q = norm(query);
  const r = norm(resultTitle);
  if (!q || !r) return false;
  const qBare = q.replace(/\b(19|20|21)\d\d\b/, '').replace(/\s+/g, ' ').trim() || q;
  const stripArticle = (s: string) => s.replace(/^(the|a|an)\s+/, '');
  return r === qBare || r === q || stripArticle(r) === stripArticle(qBare) || stripArticle(r) === stripArticle(q);
}

// The user asked for a title whose dominant top result is ALREADY in the library. Used by the
// already-in-library net so Jedd says "you already have it" instead of listing options / re-adding
// (live qwen2.5:7b, 2026-05-22: "add Chernobyl" → "which Chernobyl?" even though the 2019 one is in
// the library). Returns the in-library result so the net can name it. Only fires when the top
// result both closely matches the query AND is flagged in_library.
export function topResultAlreadyInLibrary<T extends { title?: string; in_library?: boolean }>(
  query: string,
  results: T[],
): T | null {
  if (!results || results.length === 0) return null;
  const top = results[0];
  if (top && top.title && top.in_library === true && closeTitleMatch(query, top.title)) return top;
  return null;
}

export function topResultIsDominant(
  query: string,
  results: Array<{ title?: string; year?: number; in_library?: boolean; tmdb_id?: number; tvdb_id?: number; popularity?: number }>,
): boolean {
  if (!results || results.length === 0) return false;
  const top = results[0];
  if (!top || !top.title) return false;
  if (top.in_library === true) return false; // already-in-library is a different path
  if (!query) return false;
  const closeMatch = (resultTitle: string): boolean => closeTitleMatch(query, resultTitle);
  if (!closeMatch(top.title)) return false;
  // Other results that ALSO exactly match the query title. Different-year sequels ("Matrix
  // Reloaded") won't closeMatch the bare title, so they don't count here.
  const otherCloseMatches = results.slice(1).filter(r => r.title && closeMatch(r.title));
  if (otherCloseMatches.length === 0) return true; // only one title match -> trivially dominant
  // Multiple same-title films -> dominant ONLY if the top is far more popular than the best
  // same-title runner-up. Need real popularity numbers on both to make that call.
  const topPop = Number(top.popularity);
  if (!Number.isFinite(topPop) || topPop < POP_DOMINANCE_FLOOR) return false;
  const runnerUpPop = Math.max(...otherCloseMatches.map(r => Number(r.popularity) || 0));
  if (runnerUpPop <= 0) return topPop >= POP_DOMINANCE_FLOOR; // others have no popularity, top does
  return topPop >= runnerUpPop * POP_DOMINANCE_RATIO;
}

// Status-path stall: the user asked for a status and the model replied with text only (no
// check_status call) — either a "checking now, wait a moment" stall, a forward "I'll check"
// promise, OR (the bug, 2026-05-22) a status stall that ENDS IN A QUESTION MARK ("I'm checking
// the status of Severance now. Can you wait a moment?"). The trailing-? guard in
// promisesActionWithoutTool / stallsWithoutTool deliberately excludes those to protect clarifying
// questions — but on the status path there is nothing to clarify; "can you wait a moment?" is a
// stall, not a real question. So this detector does NOT bail on a trailing ?. It only excludes a
// reply that already contains a CONCRETE status answer (so a genuine post-check report is never
// re-forced). The loop arms this only when the user's message isStatusQuery AND no check_status
// ran — so a false positive can at worst trigger one real check_status, never a wrong action.
export function stallsOnStatus(text: string): boolean {
  const t = text.toLowerCase();
  if (/i can help you find (movies|movies, tv)/.test(t)) return false;
  // A "let me check what's downloading / I'll see what's in the queue" reply is a STALL even though
  // it contains the word "downloading" — the model is narrating intent, not stating a result. Treat
  // it as a stall by detecting the lead-in check/wait framing FIRST, so the concrete-answer check
  // below (which keys off "downloading") can't be fooled by the echoed word.
  const stallFraming = /\b(let me|i'?ll|i will|i'?m going to|gonna|i'?m about to)\b[^.!?]*\b(check|look|see|find out|pull up|get|fetch)\b/.test(t)
    || /\b(checking|looking|seeing)\b[^.!?]*\b(what'?s|on|for|into|right now|now)\b/.test(t)
    || /\bone (sec|moment|second|minute)\b/.test(t)
    || /\b(wait|hold on|hang on|bear with|stand by)\b/.test(t);
  // A reply that already STATES a concrete status is a real answer, not a stall — don't re-force.
  // Concrete = a download %, a terminal state, "not added", "still searching", etc. Only counts
  // when the reply is NOT just stall framing (so "let me check what's downloading" stays a stall).
  const concreteAnswer = !stallFraming && (
    /\b\d{1,3}\s?%/.test(t)
    || /\b(is|are|has|have)\b[^.!?]*\b(downloading|downloaded|ready to watch|finished downloading|already (in|available|added))\b/.test(t)
    || /\b(downloaded|ready to watch|finished downloading|already (in|available|added))\b/.test(t)
    || /\b(not (in your library|added|been added|downloading)|isn'?t (in your library|added|downloading)|nothing (is )?(currently )?downloading|no active downloads|hasn'?t (been )?(added|started))\b/.test(t)
    || /\b(couldn'?t find|can'?t find|don'?t see)\b/.test(t)
    || /\b(still )?(searching|queued|looking for a release)\b/.test(t));
  if (concreteAnswer) return false;
  // Otherwise: any check/look/wait/hold framing is a stall on the status path.
  const checkShape = /\bcheck(ing)?\b/.test(t)
    || /\b(i'?m|i am|i'?ll|i will|let me)\b[^.!?]*\b(look|see|find out|pull up|get)\b/.test(t)
    || /\b(look(ing)? into it|on it)\b/.test(t);
  const holdShape = stallsWithoutTool(text)
    || /\b(wait|hold on|hang on|one (sec|moment|second|minute)|just a (sec|moment)|give me a (sec|moment|minute)|bear with|stand by)\b/.test(t);
  return checkShape || holdShape;
}
