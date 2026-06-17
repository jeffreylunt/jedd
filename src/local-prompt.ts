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

SETTING UP A NEW JELLYFIN USER (account provisioning) — OWNER ONLY:
- When the OWNER asks to invite / set up / create / add / make a NEW Jellyfin account (or "streaming"/"media server" account) for a person, call provision_jellyfin with that person's EMAIL ADDRESS or PHONE NUMBER in the recipient field (prefer the email if both are given). Examples that should call it: "make a Jellyfin account for my friend, their email is sam@example.com", "invite 801-555-1234 to Jellyfin", "set my buddy up on Jellyfin, his number is +1801...".
- If they want to set someone up but did NOT include an email or phone, ASK for one ("What's their email or phone number?") and call NO tool yet. NEVER call provision_jellyfin without a real email or phone, and NEVER invent, guess, or use a placeholder like friend@example.com — only ever pass a contact the user literally typed.
- This is ONLY for creating a PERSON'S account — never call provision_jellyfin for a movie/TV request.
- After it returns, give the result in ONE message. If it returns ok:false (declined, not configured, not on iMessage, delivery failed, or error), relay its message honestly — do NOT claim an invite was sent when it wasn't.

REPLY STYLE: plain text, casual, 1-3 sentences. No markdown. Never mention internal services or technical details.

${owner
  ? `The sender is the owner. They have full access — help with anything, including setting up new Jellyfin accounts via provision_jellyfin.`
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

// Detect a reply that PRESENTS search-derived details about a title — it FOUND the show, states a
// SEASON COUNT, or offers a season selection ("which seasons would you like?", "I can add all") —
// the kind of reply that is only legitimate AFTER a real search this session. qwen2.5:7b fabricates
// this whole shape from CONVERSATION HISTORY without ever calling search_tv (the live Star City bug,
// 2026-05-31: "Found Star City. It has 4 seasons. Which seasons would you like?" — the count was
// invented and the show was never actually looked up; live Sonarr says Star City 2026 has 1 season).
// Net #3b uses this (gated on !searchToolUsed) to force a real search so the match AND the season
// count come from Sonarr, not the model's memory. The !searchToolUsed gate guarantees a GENUINE
// post-search "found it / which seasons?" reply is never second-guessed — this fires only when no
// search ran this turn. claimsResultsWithoutSearching covers the "multiple results, which one?"
// shape; this covers the SINGLE-show "found it / N seasons" shape it deliberately leaves out.
export function claimsFoundWithoutSearching(text: string): boolean {
  const t = text.toLowerCase();
  if (/i can help you find (movies|movies, tv)/.test(t)) return false;
  // "already in your library / already added" is a legit terminal reply, handled elsewhere.
  if (/already (added|in (the )?library|available|have)/.test(t)) return false;
  // A NEGATED "found" ("couldn't find", "haven't found", "didn't find", "not found") is a refusal,
  // not a found-claim — refusesWithoutSearching owns that. Don't double-handle it here.
  if (/\b(could ?n'?t|can'?t|did ?n'?t|have ?n'?t|has ?n'?t|do ?n'?t|not|never|no)\s+(yet\s+)?(been\s+)?(able to\s+)?(seem to\s+)?(find|found|locate)\b/.test(t)) return false;
  return /(^|[.!?]\s*)(i\s+)?found\b/.test(t)                    // "Found X" / "I found X"
    || /\bhere'?s what i found\b/.test(t)
    || /\bi\s+found\b/.test(t)
    || /\b\d+\s+seasons?\b/.test(t)                              // "4 seasons", "has 4 seasons"
    || /\bseasons?\b[^.!?]*\bavailable\b/.test(t)                // "... seasons available"
    || /\bwhich seasons?\b[^.!?]*\b(would|do)\s+you\b/.test(t)   // "which seasons would you like"
    || /\bi\s+can\s+add\s+(all|them|it|every)/.test(t);          // "I can add all"
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
const KNOWN_TOOL_NAMES = ['search_movie', 'search_tv', 'add_movie', 'add_tv', 'check_status', 'provision_jellyfin'];
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
export function closeTitleMatch(query: string, resultTitle: string): boolean {
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

// --- Multi-movie / franchise request detection (sequential add + collection add, 2026-05-24) ---
// Jeff's live failure: "Get 3 and 4 as well" and "get all the despicable me movies" — multi-title
// requests in one message overwhelm the single-title-per-turn flow (the small model thrashes,
// emits malformed tool calls, hallucinates ids). These detectors drive a DETERMINISTIC handler
// (resolve the real TMDB collection + real ids, add the members) instead of trusting the model.

// "get all the despicable me movies" / "download the whole star wars saga" → the franchise query
// ("despicable me" / "star wars"). null when it's not a whole-franchise request. Conservative: needs
// an explicit all/whole/every + a media noun (movies/films/series/collection/franchise/saga/trilogy).
export function parseFranchiseAllRequest(msg: string): string | null {
  if (!msg) return null;
  const m = msg.match(/\b(?:all|every|the whole|the entire|each)\s+(?:of\s+)?(?:the\s+)?(.+?)\s+(?:movies|films|movie|film|series|collection|franchise|saga|trilogy)\b/i);
  if (!m) return null;
  let franchise = m[1].trim().replace(/^the\s+/i, '').trim();
  // Drop a leading request verb if the capture swallowed one ("get all the X" already handled, but
  // "all of the despicable me" is clean). Reject empties / too-generic single stopwords.
  if (franchise.length < 2) return null;
  if (/^(the|a|an|of|those|these|them|it|that|this|my|some|good|best|new|other)$/i.test(franchise)) return null;
  return franchise;
}

// "get 3 and 4 as well" → [3,4]; "1, 2 and 3" → [1,2,3]; "2 & 3" → [2,3]. Requires a LIST of >=2
// bare numbers joined by and/comma/&. null for a single number ("get 3" — leave to the model), an
// ordinal ("the 3rd one"), a count ("get 3 movies"), or a season/episode phrase (handled elsewhere).
export function parseSequelNumberList(msg: string): number[] | null {
  if (!msg) return null;
  const t = msg.toLowerCase();
  if (/\b(seasons?|episodes?|eps?|series)\b/.test(t)) return null; // TV territory, not movie sequels
  // Must look like a join of two numbers (list intent), not a lone number in a sentence.
  if (!/\b\d{1,2}\s*(?:,|and|&|\+)\s*\d{1,2}\b/.test(t)) return null;
  const nums: number[] = [];
  // \b\d\b excludes ordinals like "3rd"/"4th" (no word boundary before the letters). Negative
  // lookahead drops counts like "3 movies" / "4 films".
  const re = /\b(\d{1,2})\b(?!\s*(?:movies?|films?|times?|of))/gi;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(t)) !== null) {
    const n = parseInt(mm[1], 10);
    if (n >= 1 && n <= 20 && !nums.includes(n)) nums.push(n);
  }
  return nums.length >= 2 ? nums.sort((a, b) => a - b) : null;
}

// Derive a franchise base name from recent conversation (for the bare "get 3 and 4" case where the
// franchise is only in history). Pulls the most recent "Title (YYYY)" mention and strips a trailing
// sequel number — "I've added Despicable Me 2 (2013)…" → "Despicable Me". null if none found.
export function franchiseQueryFromHistory(history?: Array<{ role: string; text: string }>): string | null {
  if (!history || history.length === 0) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    const text = history[i]?.text || '';
    // Capture a Title (Year). Lowercase connector words (of/the/and/&/in/on/to/a/an/part/vol/chapter)
    // are allowed WITHIN the run so multi-word titles survive ("The Lord of the Rings", not "Rings").
    // Connector words are matched as WHOLE words (no trailing [\w]* — otherwise "a" would eat
    // "added", "of" would eat "office"). Only the Title-case/number branch takes a suffix.
    const m = text.match(/([A-Z][\w']*(?:\s+(?:the|and|of|an|a|in|on|to|part|vol\.?|chapter|&|[A-Z0-9][\w'.]*))*)\s*\((?:19|20)\d{2}\)/);
    if (m) {
      let base = m[1].trim();
      // The capture can swallow a sentence-leading reply verb that's also capitalized ("Added
      // Despicable Me 2 (2013)" → "Added Despicable Me 2"). Strip ONLY unambiguous reply-lead words
      // (NOT title-plausible verbs like "Get"/"I"/"Finding" — those start real titles: Get Out, I Am
      // Legend, Finding Nemo). Loop in case more than one leads.
      let prev: string;
      do {
        prev = base;
        base = base.replace(/^(?:added|adding|grabbing|grabbed|downloading|here'?s)\s+/i, '');
      } while (base !== prev);
      base = base.replace(/\s+\d{1,2}$/, '').trim(); // drop a trailing sequel number
      if (base.length >= 2) return base;
    }
  }
  return null;
}

// True when the message looks like it's asking for MORE THAN ONE title at once — used as a graceful
// fallback (net C): if a turn exhausts tool hops on such a request, guide the user instead of the
// dead-end "give it another try" (which just fails the same way). Broader than the two parsers above.
export function looksLikeMultiItemRequest(msg: string): boolean {
  if (!msg) return false;
  if (parseFranchiseAllRequest(msg) !== null || parseSequelNumberList(msg) !== null) return true;
  // A bare number list, but not a TV season/episode phrase (which is handled elsewhere).
  return !/\b(seasons?|episodes?|eps?)\b/i.test(msg)
    && /\b\d{1,2}\s*(?:,|and|&|\+)\s*\d{1,2}\b/.test(msg);
}

// The sequel index of a title within its franchise: a trailing integer ("Despicable Me 3" → 3), else
// the first film is 1 ("Despicable Me" → 1). Used to map a number-list selection to real members.
export function sequelNumberOfTitle(title: string): number {
  const m = (title || '').match(/\b(\d{1,2})\s*$/);
  return m ? parseInt(m[1], 10) : 1;
}

// --- Always-search-both + cross-type (movie ⇄ TV) disambiguation (2026-06-16) ---------------------
// Jeff's ask: for a type-AMBIGUOUS bare title request, search BOTH Radarr (movie) and Sonarr (TV)
// and consider the result sets together. When a title matches a clearly-dominant MOVIE *and* a
// clearly-dominant SHOW (or several comparable works), don't silently pick one — present a numbered
// list and let the user choose. A SINGLE dominant match proceeds straight through (the existing
// model loop / nets add it). These helpers are the zero-dep presentation + pick-parsing layer; the
// arr-driven orchestration lives in local-backend's handleCrossTypeRequest.

export interface CrossTypeCandidate {
  type: 'movie' | 'tv';
  title: string;
  year?: number;
  // Optional ids/season-count when known from a fresh search (the handler re-searches before adding,
  // so the id is always taken from a live result, never from this candidate's stale value).
  tmdb_id?: number;
  tvdb_id?: number;
  season_count?: number;
}

// Build the user-facing numbered choice list. Movies are listed before shows, each in the order
// given. The "N. Title (Year) — movie|TV show" shape is parseable back out of history on the pick
// turn (parseCrossTypeChoiceList), so a stateless resume can map a "1" / "the show" reply to a pick.
export function buildCrossTypeChoiceList(query: string, candidates: CrossTypeCandidate[]): string {
  const lines = candidates.map((c, i) => {
    const yr = c.year ? ` (${c.year})` : '';
    const kind = c.type === 'movie' ? 'movie' : 'TV show';
    return `${i + 1}. ${c.title}${yr} — ${kind}`;
  });
  const q = query ? ` for "${query}"` : '';
  return `I found a couple of matches${q} — there's both a movie and a show (or a few options). Which one do you want?\n${lines.join('\n')}\nJust reply with the number (or say "movie" or "show").`;
}

// Parse a previously-presented choice list back into ordered candidates, or null when the text is not
// one. Requires >= 2 numbered "N. Title (Year) — movie|TV show" lines so it never false-matches prose.
// A SINGLE numbered line is accepted only when the text also carries an explicit choice/did-you-mean
// sentinel — that covers the one-candidate "did you mean X?" prompt without risking a prose match on a
// stray "1. ..." line.
const CHOICE_LINE_RE = /^\s*(\d{1,2})[.)]\s+(.+?)\s*(?:\((\d{4})\))?\s*[—–-]\s*(movie|tv show)\s*$/i;
const CHOICE_SENTINEL_RE = /did you mean|which one do you want|reply with the number/i;
export function parseCrossTypeChoiceList(text: string): CrossTypeCandidate[] | null {
  if (!text) return null;
  const out: CrossTypeCandidate[] = [];
  for (const raw of text.split('\n')) {
    const m = raw.match(CHOICE_LINE_RE);
    if (!m) continue;
    out.push({
      type: /tv/i.test(m[4]) ? 'tv' : 'movie',
      title: m[2].trim(),
      year: m[3] ? Number(m[3]) : undefined,
    });
  }
  if (out.length >= 2) return out;
  if (out.length === 1 && CHOICE_SENTINEL_RE.test(text)) return out;
  return null;
}

// The most recent cross-type choice list Jedd presented, so a stateless resume can resolve the user's
// pick against it. Only the MOST RECENT assistant message counts — if Jedd's last message wasn't a
// choice list, the user isn't replying to one (returns null → treat as a fresh request).
export function findCrossTypeChoiceInHistory(history?: Array<{ role: string; text: string }>): CrossTypeCandidate[] | null {
  if (!history) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== 'assistant') continue;
    return parseCrossTypeChoiceList(history[i].text);
  }
  return null;
}

// Map the user's reply to one of the presented candidates: a year ("the 2023 one"), a position number
// or ordinal ("2", "the second", "option 1"), a type word ("the movie" / "show" / "tv" / "series"), or
// a title match. Returns the chosen candidate, or null when the reply doesn't clearly select one (the
// caller then falls through to the model loop — it may be a brand-new request, not a pick).
export function resolveCrossTypePick(userMessage: string, candidates: CrossTypeCandidate[]): CrossTypeCandidate | null {
  if (!userMessage || !candidates || candidates.length === 0) return null;
  const t = userMessage.toLowerCase().trim();
  // 0) A bare affirmation ("yes", "yeah", "do it") only resolves when there is exactly ONE candidate
  //    — i.e. confirming a single-item "did you mean X?" prompt. With multiple options "yes" is
  //    ambiguous, so it falls through to the position/type/title logic below. A negation or
  //    "something else" correction is explicitly excluded so "please don't add it" / "no, the other
  //    one" never read as a confirmation.
  if (candidates.length === 1
      && !/\b(no|not|don'?t|doesn'?t|never|nope|nah|wrong|else|different|other)\b/.test(t)
      && /^(yes|yep|yeah|yup|sure|ok|okay|that one|do it|add it|correct|right)\b/.test(t)) {
    return candidates[0];
  }
  // 1) Year ("the 2023 one") — a 4-digit year that uniquely matches one candidate.
  const yearMatch = t.match(/\b(?:19|20|21)\d{2}\b/);
  if (yearMatch) {
    const byYear = candidates.filter(c => c.year === Number(yearMatch[0]));
    if (byYear.length === 1) return byYear[0];
  }
  // 2) Type word — checked BEFORE the bare position number so a reply like "season 1" / "the show"
  //   resolves to the TV candidate (TV intent) rather than position 1 (which would be the movie).
  //   Works only when there is exactly one candidate of that type.
  const wantsMovie = /\b(movie|film)\b/.test(t);
  const wantsTv = /\b(show|series|tv|cartoon|seasons?|episodes?)\b/.test(t);
  if (wantsMovie && !wantsTv) {
    const movies = candidates.filter(c => c.type === 'movie');
    if (movies.length === 1) return movies[0];
  }
  if (wantsTv && !wantsMovie) {
    const tvs = candidates.filter(c => c.type === 'tv');
    if (tvs.length === 1) return tvs[0];
  }
  // 3) Position number ("2", "number 2", "option 1") — 1-2 digits, never inside a 4-digit year.
  const numMatch = t.match(/\b(\d{1,2})\b/);
  if (numMatch) {
    const n = Number(numMatch[1]);
    if (n >= 1 && n <= candidates.length) return candidates[n - 1];
  }
  // 4) Ordinal words.
  const ordinals: Array<[RegExp, number]> = [
    [/\b(first|1st)\b/, 1], [/\b(second|2nd)\b/, 2], [/\b(third|3rd)\b/, 3], [/\b(fourth|4th)\b/, 4],
  ];
  for (const [re, n] of ordinals) if (re.test(t) && n <= candidates.length) return candidates[n - 1];
  // 5) Title match — the reply names exactly one candidate's title.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const tn = norm(userMessage);
  if (tn) {
    const hits = candidates.filter(c => { const cn = norm(c.title); return cn && (tn === cn || tn.includes(cn)); });
    if (hits.length === 1) return hits[0];
  }
  return null;
}

// --- Fuzzy "did you mean?" typo / wrong-title handling (2026-06-16) ------------------------------
// When a request returns no near-exact match (a typo or slightly-wrong title), Jedd retries with
// looser queries and, if plausible candidates surface, presents a numbered "did you mean?" list that
// REUSES the cross-type choice format ("N. Title (Year) — movie|TV show") so the existing pick path
// (findCrossTypeChoiceInHistory → parseCrossTypeChoiceList → resolveCrossTypePick) resolves the reply.
// Candidates are ranked by string-similarity to what the user typed, then provider popularity; a match
// is only auto-added when it is a near-exact, dominant hit, otherwise Jedd asks (the low-confidence guard).

const DYM_STOPWORDS = new Set(['the', 'a', 'an', 'and', 'of', 'to', 'in', 'on', 'for', 'part', 'movie', 'film', 'show', 'series', 'season', 'seasons']);

// Looser query variants to retry when the original search came back empty: punctuation stripped, a
// trailing year dropped, and the first few significant words (for an over-long / partly-wrong query).
// Returns deduped non-empty variants in priority order; the caller skips any equal to the term it
// already searched. Imperfect by design — a bad variant just yields no results → honest not-found.
export function cleanedQueryVariants(title: string): string[] {
  const variants: string[] = [];
  const push = (s: string) => { const t = s.replace(/\s+/g, ' ').trim(); if (t && !variants.includes(t)) variants.push(t); };
  const noPunct = (title || '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!noPunct) return [];
  push(noPunct);
  push(noPunct.replace(/\b(?:19|20|21)\d\d\b\s*$/, '').trim());
  const sig = noPunct.split(' ').filter(w => w.length > 1 && !/^\d+$/.test(w) && !DYM_STOPWORDS.has(w.toLowerCase()));
  if (sig.length > 4) push(sig.slice(0, 4).join(' '));
  if (sig.length > 2) push(sig.slice(0, 3).join(' '));
  if (sig.length > 1) push(sig.slice(0, 2).join(' '));
  const toks = noPunct.split(' ');
  if (toks.length > 2) push(toks.slice(0, -1).join(' '));
  return variants;
}

function normForSim(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

// Similarity in [0,1] between two titles — the MAX of normalized edit-distance similarity (catches a
// misspelling) and token Jaccard overlap (catches reordering / a missing or extra word); a full
// substring relationship scores high too. 1 = identical (after normalization), 0 = nothing in common.
export function titleSimilarity(a: string, b: string): number {
  const x = normForSim(a);
  const y = normForSim(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const maxLen = Math.max(x.length, y.length);
  const lev = maxLen ? 1 - levenshtein(x, y) / maxLen : 0;
  const ax = new Set(x.split(' ').filter(Boolean));
  const ay = new Set(y.split(' ').filter(Boolean));
  let inter = 0; for (const w of ax) if (ay.has(w)) inter++;
  const union = new Set([...ax, ...ay]).size;
  const jac = union ? inter / union : 0;
  const contains = (x.includes(y) || y.includes(x)) ? 0.9 : 0;
  return Math.max(lev, jac, contains);
}

// Build the user-facing "did you mean?" list. Same parseable "N. Title (Year) — movie|TV show" line
// shape as buildCrossTypeChoiceList, so the reply resolves through the exact same pick path; the
// "did you mean" lead-in also acts as the sentinel that lets a SINGLE-candidate list parse back out.
export function buildDidYouMeanList(query: string, candidates: CrossTypeCandidate[]): string {
  const lines = candidates.map((c, i) => {
    const yr = c.year ? ` (${c.year})` : '';
    const kind = c.type === 'movie' ? 'movie' : 'TV show';
    return `${i + 1}. ${c.title}${yr} — ${kind}`;
  });
  const q = query ? ` an exact match for "${query}"` : ' an exact match';
  return `I couldn't find${q} — did you mean one of these?\n${lines.join('\n')}\nReply with the number (or the name), or tell me the exact title.`;
}

// Pull the media TITLE out of a request message by stripping a leading request frame ("can you get",
// "add", "download", "i want to watch", a greeting/please) and trailing politeness. ANCHORED so it
// only removes a clear lead, never the middle of a title; the trailing `\s+` after each verb protects
// single-word titles ("Watchmen" is not "watch" + "men"). Imperfect by design — it only gates the
// cross-type handler, and a slightly-off title just yields no dominant match → safe fall-through.
export function extractRequestTitle(userMessage: string): string {
  if (!userMessage) return '';
  let s = userMessage.trim().replace(/[?!.]+\s*$/, '').replace(/["“”'`]/g, '').trim();
  s = s.replace(/^(?:hey|hi|hello)[,!\s]+/i, '');
  s = s.replace(/^(?:can|could|would|will)\s+(?:you|we|u|i)\s+(?:please\s+)?/i, '');
  s = s.replace(/^(?:please|pls|plz)\s+/i, '');
  s = s.replace(/^(?:i\s+(?:want|need)|i'?d\s+like|i\s+would\s+like|lemme|let\s+me)\s+(?:to\s+(?:watch|see|get|download|add)\s+)?/i, '');
  s = s.replace(/^(?:get|add|download|grab|find|put on|pull up|watch|see)\s+(?:me\s+|us\s+)?/i, '');
  s = s.replace(/\s+(?:for me|please|pls|plz|thanks?|thx)\s*$/i, '').trim();
  return s;
}

// --- jfa-go Jellyfin provisioning helpers (owner-only) ------------------------------------------
// Provisioning is driven by the `provision_jellyfin` tool: the OWNER asks Jedd to set up a new
// Jellyfin user, the model calls the tool with the recipient (email or phone), and runTool does the
// owner gate + iMessage check + invite create/deliver. These helpers parse the recipient, build the
// invite message a phone recipient is texted, and detect a fabricated "invite sent" claim (guard).

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

export interface InviteRecipient { kind: 'email' | 'phone'; value: string; }

// Pull a single recipient out of a string — an email (preferred) or a phone number. Phone detection
// requires a 10- or 11-digit run (optionally +-prefixed; spaces/dashes/parens/dots allowed) so it
// won't grab a stray year or season number. Returns null if neither is present.
export function extractInviteRecipient(msg: string): InviteRecipient | null {
  if (!msg) return null;
  const email = msg.match(EMAIL_RE);
  if (email) return { kind: 'email', value: email[0] };
  const phoneMatch = msg.match(/\+?\d[\d\s().-]{8,}\d/);
  if (phoneMatch) {
    const cleaned = phoneMatch[0].replace(/[^\d+]/g, '');
    const onlyDigits = cleaned.replace(/\D/g, '');
    if (onlyDigits.length === 10 || onlyDigits.length === 11) return { kind: 'phone', value: cleaned };
  }
  return null;
}

// Short "how to connect" blurb appended to a texted invite. Empty when no public Jellyfin URL is set.
export function connectBlurb(jellyfinUrl: string): string {
  if (!jellyfinUrl) return '';
  return `Once you've picked a username and password, watch at ${jellyfinUrl} — open it in any web browser, or get the free Jellyfin app (iPhone/iPad, Android, Apple TV, Fire TV) and point it at that URL, then sign in.`;
}

// "How to request media via Jedd" explainer appended to a new user's invite. The live Jedd accepts
// media requests from ALL senders (ALLOW_ALL_SENDERS=true), so a freshly-invited user CAN text Jedd
// to request movies/shows. Apostrophes are intentional (don't / you're / I'll) — keep them correct.
// The iMESSAGE variant says "just text this number": the recipient already has Jedd's number in the
// same thread. For the EMAIL path the recipient has no number — that explainer (with Jedd's iMessage
// handle jeffreylunt@outlook.com) is delivered by jfa-go's email footer ([messages].message) and the
// post-signup success page, configured server-side on the jfa-go host, NOT built here.
export const MEDIA_REQUEST_BLURB =
  'Want to watch something we don\'t have yet? Just text this number what you\'re looking for — e.g. "add Dune Part Two" or "can you get The Bear" — and I\'ll add it automatically.';

// The full invite message Jedd TEXTS a phone recipient: the single-use signup link, how to connect,
// and how to request new media. (This is the iMessage path only; the email path is sent by jfa-go.)
export function buildInviteText(link: string, hours: number, jellyfinUrl: string): string {
  const blurb = connectBlurb(jellyfinUrl);
  const base = `You've been invited to set up a Jellyfin account! Create your login here (single-use link, expires in ${hours}h): ${link}`;
  const parts = [base];
  if (blurb) parts.push(blurb);
  parts.push(MEDIA_REQUEST_BLURB);
  return parts.join('\n\n');
}

// Build the OWNER-facing confirmation for a SUCCESSFUL provision, using ONLY the verified tool result
// — the REAL recipient (the email/phone the user actually gave) and the read-back-verified invite
// link (createInviteAndGetLink confirmed the code via GET /invites before this runs). The success
// reply must NEVER be the local 7b's free narration: on 2026-06-06 a real invite WAS created, yet the
// model reported a hallucinated "joey@example.com". runLocalSession therefore OVERRIDES the model's
// final text with this builder whenever a provision_jellyfin call returned ok:true, guaranteeing the
// owner always sees the true recipient + the verified link (acceptance criteria #1 and #3).
export function buildProvisionConfirmation(r: {
  channel?: string; recipient?: string; invite_url?: string; hours?: number; imessage_unverified?: boolean;
}): string {
  const hours = typeof r.hours === 'number' && r.hours > 0 ? r.hours : 24;
  const to = r.recipient || '';
  const link = r.invite_url || '';
  if (r.channel === 'email') {
    return `Done — I created a Jellyfin invite and emailed it to ${to} (single-use, expires in ${hours}h). If it doesn't arrive, share this link directly: ${link}`;
  }
  // phone / iMessage path
  if (r.imessage_unverified) {
    return `Done — I created a Jellyfin invite and texted it to ${to} (single-use, expires in ${hours}h). I couldn't fully confirm it landed on iMessage, so if it doesn't show up, share this link directly: ${link}`;
  }
  return `Done — I created a Jellyfin invite and texted it to ${to} (single-use, expires in ${hours}h). If it doesn't show up, share this link directly: ${link}`;
}

// Detect a reply that CLAIMS a Jellyfin account/invite was set up or sent. Used as a FINAL DELIVERY
// GUARD: if the model claims provisioning success but no provision_jellyfin call returned ok this
// session, the claim is a fabrication and must be suppressed (mirrors claimsAddWithoutExecuting).
export function claimsProvisionWithoutExecuting(text: string): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  // Must reference an account/invite/jellyfin so it doesn't fire on a movie "I've added X" reply.
  if (!/\b(invite|account|jellyfin)\b/.test(t)) return false;
  return /\b(invite|account)\b[^.!?]*\b(sent|created|set up|emailed|texted|sent over|on its way|is ready)\b/.test(t)
    || /\b(sent|emailed|texted|created|set up)\b[^.!?]*\b(invite|account)\b/.test(t)
    || /\b(i'?ve|i have|just)\b[^.!?]*\b(set up|created|sent|emailed|texted)\b[^.!?]*\b(invite|account|jellyfin)\b/.test(t);
}
