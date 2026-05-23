import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SONARR_API_KEY ??= 'test';
process.env.RADARR_API_KEY ??= 'test';
process.env.SONARR_ROOT_FOLDER ??= '/tv';
process.env.RADARR_ROOT_FOLDER ??= '/movies';
process.env.BLUEBUBBLES_PASSWORD ??= 'test';

const { promisesActionWithoutTool, claimsAddWithoutExecuting, splitQueryYear, titlesRoughlyMatch } = await import('./local-backend.js');
const { systemPromptV2, refusesWithoutSearching, claimsResultsWithoutSearching, isStatusQuery, extractStatusTitle, stallsOnStatus, isStallReply, asksWhichOne, topResultIsDominant, parseSeasonSelection, topResultAlreadyInLibrary, parseInlineToolCall, looksLikeRawToolCall, messageHasPlausibleTitle, stripTrailingOffer } = await import('./local-prompt.js');

// --- splitQueryYear: derive year from param OR a year stuffed into the query (Eternity regression) ---

test('splitQueryYear extracts a year stuffed into the query and strips it from the term', () => {
  assert.deepEqual(splitQueryYear('eternity 2025'), { term: 'eternity', year: 2025 });
  assert.deepEqual(splitQueryYear('Eternity 2025'), { term: 'Eternity', year: 2025 });
});

test('splitQueryYear prefers the explicit year param', () => {
  assert.deepEqual(splitQueryYear('Eternity', 2025), { term: 'Eternity', year: 2025 });
});

test('splitQueryYear leaves a yearless query alone', () => {
  assert.deepEqual(splitQueryYear('Dune Part Two'), { term: 'Dune Part Two', year: undefined });
});

test('splitQueryYear does not treat a non-year number as a year', () => {
  assert.deepEqual(splitQueryYear('300'), { term: '300', year: undefined });
});

// --- Search-then-no-add: claims an add it never made (the live Eternity/Dune-correction bug) ---

test('claimsAdd fires on "I added the 2021 version ... to the download library."', () => {
  assert.equal(claimsAddWithoutExecuting('I added the 2021 version of Dune to the download library. Let me know if you need anything else!'), true);
});

test('claimsAdd fires on "I\'ve added it!"', () => {
  assert.equal(claimsAddWithoutExecuting("I've added it!"), true);
});

test('claimsAdd fires on "It\'s been added to the library."', () => {
  assert.equal(claimsAddWithoutExecuting("It's been added to the library."), true);
});

test('claimsAdd fires on "I\'m adding it now."', () => {
  assert.equal(claimsAddWithoutExecuting("I'm adding it now."), true);
});

test('claimsAdd does NOT fire on already-in-library replies', () => {
  assert.equal(claimsAddWithoutExecuting("That one's already in the library, you're all set!"), false);
  assert.equal(claimsAddWithoutExecuting('Looks like Barbie is already added.'), false);
});

test('claimsAdd does NOT fire on a clarifying question', () => {
  assert.equal(claimsAddWithoutExecuting('I found two — which year did you want, 2021 or 1984?'), false);
});

test('claimsAdd does NOT fire on a not-found reply', () => {
  assert.equal(claimsAddWithoutExecuting("Couldn't find that one, sorry."), false);
});

test('claimsAdd fires on bare "Found it! Adding James and the Giant Peach (1996)."', () => {
  assert.equal(claimsAddWithoutExecuting('I found it! Adding "James and the Giant Peach" (1996) for you.'), true);
});

test('claimsAdd fires on "I\'ve started downloading X."', () => {
  assert.equal(claimsAddWithoutExecuting('I\'ve started downloading "Eternity 2025" for you. It should be available soon!'), true);
});

test('claimsAdd does NOT fire on "padding" or mid-word adding', () => {
  // guard the (^|[.!,]) anchor doesn't match "padding"/"loading" mid-word
  assert.equal(claimsAddWithoutExecuting('Loading the catalog took a moment.'), false);
});

// --- Refusal-without-searching: the model gives up ("couldn't find that") having never
// called a search tool, primed by a poisoned history of prior "couldn't find" replies
// (the live Eternity loop, 2026-05-22). The third safety net forces a real search. ---

test('refusesWithoutSearching fires on "Couldn\'t find that one, sorry."', () => {
  assert.equal(refusesWithoutSearching("Couldn't find that one, sorry."), true);
});

test('refusesWithoutSearching fires on "No luck finding that, sorry."', () => {
  assert.equal(refusesWithoutSearching('No luck finding that, sorry.'), true);
});

test('refusesWithoutSearching fires on "I couldn\'t find that movie."', () => {
  assert.equal(refusesWithoutSearching("I couldn't find that movie."), true);
});

test('refusesWithoutSearching fires on "That one doesn\'t seem to be available."', () => {
  assert.equal(refusesWithoutSearching("That one doesn't seem to be available."), true);
});

test('refusesWithoutSearching does NOT fire on an already-in-library reply', () => {
  assert.equal(refusesWithoutSearching("That one's already in the library, you're all set!"), false);
  assert.equal(refusesWithoutSearching('Looks like Eternity is already available, enjoy!'), false);
});

test('refusesWithoutSearching does NOT fire on a successful add reply', () => {
  assert.equal(refusesWithoutSearching('Added Eternity to the library, it\'s searching now.'), false);
});

test('refusesWithoutSearching does NOT fire on a clarifying question', () => {
  assert.equal(refusesWithoutSearching('I found a few — which year did you mean?'), false);
});

test('refusesWithoutSearching does NOT fire on the non-Jeff refusal', () => {
  assert.equal(
    refusesWithoutSearching('Hey! I can help you find movies, TV shows, and ebooks. Just tell me what you\'re looking for!'),
    false,
  );
});

// --- claimsResultsWithoutSearching: parroted "I found multiple results / which one?" with no
// search this session (poisoned-history shape b, 2026-05-22). ---

test('claimsResultsWithoutSearching fires on "I found multiple results for X. Which one?"', () => {
  assert.equal(claimsResultsWithoutSearching('I found multiple results for "Eternity". Could you please specify which one you mean?'), true);
});

test('claimsResultsWithoutSearching fires on "I found two versions ... which did you mean?"', () => {
  assert.equal(claimsResultsWithoutSearching('I found two versions of that movie. Which one did you mean?'), true);
});

test('claimsResultsWithoutSearching does NOT fire on a plain seasons question', () => {
  assert.equal(claimsResultsWithoutSearching('That show has 5 seasons — which seasons would you like, or all of them?'), false);
});

test('claimsResultsWithoutSearching does NOT fire on the non-Jeff refusal', () => {
  assert.equal(claimsResultsWithoutSearching('Hey! I can help you find movies, TV shows, and ebooks.'), false);
});

// --- messageHasPlausibleTitle: gate net #3 so gibberish / no-title requests never force a search
// that makes the small model hallucinate a title (live 2026-05-22: "asdkjfh" → searched+added
// "Barbie"). Real titles (incl. one-word and accented) must still pass. ---

test('messageHasPlausibleTitle: false for single-token gibberish', () => {
  assert.equal(messageHasPlausibleTitle('asdkjfh'), false);
  assert.equal(messageHasPlausibleTitle('qwrtplkjhg'), false);
});

test('messageHasPlausibleTitle: false for pure non-media requests', () => {
  assert.equal(messageHasPlausibleTitle('play music'), false);
  assert.equal(messageHasPlausibleTitle('can you add a book for me'), false);
  assert.equal(messageHasPlausibleTitle('download Spotify'), false);
  // "get the new Taylor Swift album" has a proper-noun ("Taylor Swift") title token, so it is left
  // to search (may match a concert film) rather than suppressed — the model will honestly report
  // "couldn't find an album" without inventing a title.
});

test('messageHasPlausibleTitle: true for real titles (incl. one-word and accented)', () => {
  assert.equal(messageHasPlausibleTitle('get Inception'), true);
  assert.equal(messageHasPlausibleTitle('add Barbie'), true);
  assert.equal(messageHasPlausibleTitle('Memento'), true);
  assert.equal(messageHasPlausibleTitle('add Amélie'), true);
  assert.equal(messageHasPlausibleTitle('get Eternity 2025'), true);
  assert.equal(messageHasPlausibleTitle('add The Last of Us'), true);
  assert.equal(messageHasPlausibleTitle('can yuo add intersteller plz'), true);
});

// --- stripTrailingOffer: remove a dangling "I'll check the other years if you're interested" style
// follow-up offer that qwen2.5:7b tacks on after a complete answer (live Apex reply, 2026-05-22).
// Never touch the actual answer. ---

test('stripTrailingOffer removes the Apex "I\'ll check the other years" offer', () => {
  assert.equal(
    stripTrailingOffer("The 2026 version of Apex is already in your library. I'll check the other years if you're interested."),
    'The 2026 version of Apex is already in your library.',
  );
});

test('stripTrailingOffer removes "Let me know and I\'ll look."', () => {
  assert.equal(
    stripTrailingOffer('Added Tenet (2020) — grabbing it now. Let me know and I\'ll look for anything else.'),
    'Added Tenet (2020) — grabbing it now.',
  );
});

test('stripTrailingOffer leaves a clean answer untouched', () => {
  assert.equal(stripTrailingOffer('Added Tenet (2020) — grabbing it now.'), 'Added Tenet (2020) — grabbing it now.');
  assert.equal(stripTrailingOffer("Couldn't find that one, sorry."), "Couldn't find that one, sorry.");
});

test('stripTrailingOffer does NOT strip a clarifying question or a needed prompt to the user', () => {
  // A genuine "what would you like" clarifying reply must survive (it is the whole answer).
  assert.equal(
    stripTrailingOffer("Couldn't find that one, sorry. Please provide the title of the movie or TV show you're looking for."),
    "Couldn't find that one, sorry. Please provide the title of the movie or TV show you're looking for.",
  );
});

test('stripTrailingOffer never empties a reply that is ONLY an offer', () => {
  // Degenerate: if the whole reply is an offer, keep it rather than return empty.
  const onlyOffer = "I'll look into that for you.";
  assert.equal(stripTrailingOffer(onlyOffer), onlyOffer);
});

test('claimsResultsWithoutSearching does NOT fire on a simple confirmation', () => {
  assert.equal(claimsResultsWithoutSearching("Added it, it's downloading now."), false);
});

// --- asksWhichOne + topResultIsDominant: over-disambiguation net #8 (2026-05-22) ---

test('asksWhichOne fires on "which one did you mean?"', () => {
  assert.equal(asksWhichOne('I found a few options. Which one did you mean?'), true);
});

test('asksWhichOne fires on "did you mean ..."', () => {
  assert.equal(asksWhichOne('Did you mean the 1999 film or the 2003 sequel?'), true);
});

test('asksWhichOne does NOT fire on a TV "which seasons?" question', () => {
  assert.equal(asksWhichOne('That show has 4 seasons — which seasons would you like?'), false);
});

test('asksWhichOne does NOT fire on the non-Jeff refusal', () => {
  assert.equal(asksWhichOne('Hey! I can help you find movies, TV shows, and ebooks.'), false);
});

test('asksWhichOne does NOT fire on a plain confirmation', () => {
  assert.equal(asksWhichOne("Added The Matrix (1999), it's downloading now."), false);
});

test('topResultIsDominant: single exact-title result is dominant', () => {
  assert.equal(topResultIsDominant('The Matrix', [
    { title: 'The Matrix', year: 1999, in_library: false, tmdb_id: 603 },
  ]), true);
});

test('topResultIsDominant: exact top result, sequels below it, still dominant', () => {
  assert.equal(topResultIsDominant('The Matrix', [
    { title: 'The Matrix', year: 1999, in_library: false, tmdb_id: 603 },
    { title: 'The Matrix Reloaded', year: 2003, in_library: false, tmdb_id: 604 },
    { title: 'The Matrix Resurrections', year: 2021, in_library: false, tmdb_id: 624860 },
  ]), true);
});

test('topResultIsDominant: Whiplash dominant via popularity gap (21.7 vs 1.5)', () => {
  assert.equal(topResultIsDominant('Whiplash', [
    { title: 'Whiplash', year: 2014, in_library: false, tmdb_id: 244786, popularity: 21.7 },
    { title: 'Whiplash', year: 2013, in_library: false, tmdb_id: 1, popularity: 1.5 },
    { title: 'Whiplash', year: 1948, in_library: false, tmdb_id: 2, popularity: 1.2 },
  ]), true, 'top is >4x the runner-up popularity → clear winner, add directly');
});

test('topResultIsDominant: multiple same-title films with CLOSE popularity → still ask', () => {
  assert.equal(topResultIsDominant('Crash', [
    { title: 'Crash', year: 2005, in_library: false, tmdb_id: 1, popularity: 12 },
    { title: 'Crash', year: 1996, in_library: false, tmdb_id: 2, popularity: 9 },
  ]), false, 'two distinct films of comparable popularity → genuinely ambiguous, ask');
});

test('topResultIsDominant: multiple same-title films, NO popularity data → still ask', () => {
  assert.equal(topResultIsDominant('Whiplash', [
    { title: 'Whiplash', year: 2014, in_library: false, tmdb_id: 244786 },
    { title: 'Whiplash', year: 1948, in_library: false, tmdb_id: 99999 },
  ]), false, 'no popularity to break the tie → ask, never coin-flip');
});

test('topResultIsDominant: NOT dominant when top title does not match the query', () => {
  assert.equal(topResultIsDominant('The Matrix', [
    { title: 'Matrix Reloaded Returns', year: 2010, in_library: false, tmdb_id: 1 },
  ]), false);
});

test('topResultIsDominant: NOT dominant when top result already in library', () => {
  assert.equal(topResultIsDominant('The Matrix', [
    { title: 'The Matrix', year: 1999, in_library: true, tmdb_id: 603 },
  ]), false);
});

test('topResultIsDominant: false on empty results', () => {
  assert.equal(topResultIsDominant('The Matrix', []), false);
});

test('topResultIsDominant: strips a year stuffed into the query', () => {
  assert.equal(topResultIsDominant('The Matrix 1999', [
    { title: 'The Matrix', year: 1999, in_library: false, tmdb_id: 603 },
  ]), true);
});

// --- Title cross-check: a hallucinated-but-VALID id resolves to a real WRONG title
// (the Ghost-Dad-for-James bug, 2026-05-22). add_movie/add_tv must reject a gross mismatch. ---

test('titlesRoughlyMatch rejects a gross mismatch (Ghost Dad vs James and the Giant Peach)', () => {
  assert.equal(titlesRoughlyMatch('James and the Giant Peach', 'Ghost Dad'), false);
});

test('titlesRoughlyMatch accepts an exact match', () => {
  assert.equal(titlesRoughlyMatch('Eternity', 'Eternity'), true);
});

test('titlesRoughlyMatch accepts case/punctuation differences', () => {
  assert.equal(titlesRoughlyMatch('Spider-Man: No Way Home', 'Spider Man No Way Home'), true);
});

test('titlesRoughlyMatch accepts a shared significant word (subtitle drift)', () => {
  assert.equal(titlesRoughlyMatch('Dune', 'Dune: Part Two'), true);
});

test('titlesRoughlyMatch does NOT match on stopwords alone', () => {
  // "The Movie" vs "The Other" share only the stopword "the" -> not a match.
  assert.equal(titlesRoughlyMatch('The Batman', 'The Notebook'), false);
});

test('titlesRoughlyMatch does not block when no requested title given', () => {
  assert.equal(titlesRoughlyMatch('', 'Anything'), true);
});

// --- System prompt regression guards (the broadened-scenario smoothing, 2026-05-21) ---

test('prompt defaults ambiguous title routing to search_movie', () => {
  const p = systemPromptV2(true);
  assert.match(p, /DEFAULT to search_movie/);
});

test('prompt forbids re-asking a year/option the user already gave', () => {
  const p = systemPromptV2(true);
  assert.match(p, /already named a year or picked an option/i);
});

test('prompt covers in_library for both movie and TV', () => {
  const p = systemPromptV2(true);
  assert.match(p, /Movie or TV search result has in_library/);
});

test('prompt tail differs for owner vs family member', () => {
  assert.match(systemPromptV2(true), /sender is the owner/);
  assert.match(systemPromptV2(false), /sender is a family member/);
});

test('prompt uses the configured display name', () => {
  assert.match(systemPromptV2(true, 'Alfred'), /You are Alfred,/);
  assert.match(systemPromptV2(true), /You are Jedd,/);
});

// --- Status-check promises (the 2026-05-21 regression) must fire the safety net ---

test('fires on "I\'m checking the status now."', () => {
  assert.equal(promisesActionWithoutTool("I'm checking the status now."), true);
});

test('fires on "Sure, I\'ll check on the status of X for you."', () => {
  assert.equal(
    promisesActionWithoutTool('Sure, I\'ll check on the status of "Mickey and the Roadster Racers" for you.'),
    true,
  );
});

test('fires on "Let me check how that\'s coming along."', () => {
  assert.equal(promisesActionWithoutTool("Let me check how that's coming along."), true);
});

// --- Existing search/add promises still fire ---

test('fires on "Sure, I\'ll search for that."', () => {
  assert.equal(promisesActionWithoutTool("Sure, I'll search for that."), true);
});

test('fires on "Got it! I\'ll add it from 2017."', () => {
  assert.equal(promisesActionWithoutTool("Got it! I'll add it from 2017."), true);
});

test('fires on "Searching for it now."', () => {
  assert.equal(promisesActionWithoutTool('Searching for it now.'), true);
});

// --- Must NOT fire: questions, refusals, real replies ---

test('does not fire on a clarifying question', () => {
  assert.equal(
    promisesActionWithoutTool('Which one did you mean — the 2017 show or the movie?'),
    false,
  );
});

test('does not fire on a seasons question', () => {
  assert.equal(promisesActionWithoutTool('Which seasons would you like?'), false);
});

test('does not fire on the non-Jeff refusal', () => {
  assert.equal(
    promisesActionWithoutTool('Hey! I can help you find movies, TV shows, and ebooks. Just tell me what you\'re looking for!'),
    false,
  );
});

test('does not fire on a real completion reply (tool already ran)', () => {
  // This reply is only emitted after a tool call, but the detector is also gated on
  // toolUsedThisSession; even so the text itself should not look like a forward promise.
  assert.equal(
    promisesActionWithoutTool('"Mickey and the Roadster Racers" is downloading, about 50% done.'),
    false,
  );
});

// --- Status-query detection: arm the status-stall net (the "status of severance" bug, 2026-05-22) ---

test('isStatusQuery fires on "What\'s the status of severance"', () => {
  assert.equal(isStatusQuery("What's the status of severance"), true);
});

test('isStatusQuery fires on "is Oppenheimer ready yet?"', () => {
  assert.equal(isStatusQuery('is Oppenheimer ready yet?'), true);
});

test('isStatusQuery fires on "how\'s Dune coming along?"', () => {
  assert.equal(isStatusQuery("how's Dune coming along?"), true);
});

test('isStatusQuery fires on a bare "what\'s downloading?"', () => {
  assert.equal(isStatusQuery("what's downloading?"), true);
});

test('isStatusQuery fires on "any update on severance"', () => {
  assert.equal(isStatusQuery('any update on severance'), true);
});

test('isStatusQuery does NOT fire on a plain add request', () => {
  assert.equal(isStatusQuery('can you add Oppenheimer'), false);
  assert.equal(isStatusQuery('I want to watch Barbie'), false);
});

// The 2026-05-22 leak: "How is severance doing" did not match isStatusQuery, so net #6 never armed
// and the "I'm checking the status... wait a moment?" stall reached the user.
test('isStatusQuery fires on "How is severance doing" (the leaked phrasing)', () => {
  assert.equal(isStatusQuery('How is severance doing'), true);
  assert.equal(isStatusQuery("how's severance doing?"), true);
  assert.equal(isStatusQuery('how is the matrix looking'), true);
});

// --- Raw tool-call string: NEVER deliver `toolName({...})` text to the user (live Apex bug, 2026-05-22) ---

test('parseInlineToolCall parses the exact leaked Apex string', () => {
  assert.deepEqual(parseInlineToolCall('search_movie({"query": "Apex"})'), { name: 'search_movie', arguments: { query: 'Apex' } });
});

test('parseInlineToolCall parses a call wrapped in prose', () => {
  assert.deepEqual(parseInlineToolCall('Sure! search_movie({"query":"Apex"}) is what I will do.'), { name: 'search_movie', arguments: { query: 'Apex' } });
});

test('parseInlineToolCall parses add_tv with multiple args', () => {
  assert.deepEqual(parseInlineToolCall('add_tv({"tvdb_id": 12345, "title": "Severance", "seasons": [1]})'), { name: 'add_tv', arguments: { tvdb_id: 12345, title: 'Severance', seasons: [1] } });
});

test('parseInlineToolCall returns null for normal prose', () => {
  assert.equal(parseInlineToolCall('Added Apex (2019) — grabbing it now.'), null);
  assert.equal(parseInlineToolCall("Couldn't find that one, sorry."), null);
  assert.equal(parseInlineToolCall(''), null);
});

test('parseInlineToolCall returns null for an unknown function name', () => {
  assert.equal(parseInlineToolCall('do_something({"x": 1})'), null);
});

test('parseInlineToolCall returns null when the arg blob is broken JSON', () => {
  assert.equal(parseInlineToolCall('search_movie({"query": "Apex"'), null);
});

test('looksLikeRawToolCall flags any raw tool-call shape, even malformed args', () => {
  assert.equal(looksLikeRawToolCall('search_movie({"query": "Apex"})'), true);
  assert.equal(looksLikeRawToolCall('search_movie({"query": "Apex"'), true);
  assert.equal(looksLikeRawToolCall('add_movie(tmdb_id=872585)'), true);
  assert.equal(looksLikeRawToolCall('check_status()'), true);
});

test('looksLikeRawToolCall does NOT flag a normal plain-language reply', () => {
  assert.equal(looksLikeRawToolCall('Added Apex (2019) — grabbing it now.'), false);
  assert.equal(looksLikeRawToolCall('Which one did you mean?'), false);
  assert.equal(looksLikeRawToolCall("I'll search for that show now."), false);
});

// --- Domain reinforcement: movies/TV only, never games (the "Found several games" Apex bug) ---

test('systemPromptV2 forbids games/apps framing and treats titles as movies/TV', () => {
  const p = systemPromptV2(true);
  assert.match(p, /MOVIES AND TV ONLY/);
  assert.match(p, /video games|mobile game/i);
  assert.match(p, /Apex/);
});

// --- isStallReply: the universal "doing it now / wait a moment" backstop (Jeff, 2026-05-22) ---

test('isStallReply catches the exact leaked status stall', () => {
  assert.equal(isStallReply('I\'m checking the status of "Severance" now. Can you wait a moment?'), true);
});

test('isStallReply catches every stall phrasing the team-lead listed', () => {
  for (const s of [
    "I'm checking the status now.",
    "I'm searching for that now, hang on.",
    "Let me look that up for you.",
    "I'll check on that and get back to you.",
    "Give me a sec.",
    "One moment while I look.",
    "I'm adding it now, wait a moment.",
    "On it!",
    "I'll let you know when it's ready.",
  ]) {
    assert.equal(isStallReply(s), true, `should flag stall: ${s}`);
  }
});

test('isStallReply does NOT flag a real result or a clarifying question', () => {
  assert.equal(isStallReply('Severance is downloading, about 45% done.'), false);
  assert.equal(isStallReply('Added Severance (2022) — grabbing all seasons now.'), false);
  assert.equal(isStallReply("Couldn't find that one, sorry."), false);
  assert.equal(isStallReply("That show has 4 seasons — which ones do you want, or all?"), false);
  assert.equal(isStallReply('Which one did you mean — the 2014 or the 1998 version?'), false);
  assert.equal(isStallReply("It's not in your library yet."), false);
  assert.equal(isStallReply('Still searching for a release.'), false);
});

// --- Title extraction: scope the forced check_status to the named title ---

test('extractStatusTitle pulls "Severance" from "What\'s the status of severance"', () => {
  assert.equal(extractStatusTitle("What's the status of severance").toLowerCase(), 'severance');
});

test('extractStatusTitle pulls the title from "is Oppenheimer ready yet?"', () => {
  assert.equal(extractStatusTitle('is Oppenheimer ready yet?'), 'Oppenheimer');
});

test('extractStatusTitle pulls the title from "any update on Dune Part Two"', () => {
  assert.equal(extractStatusTitle('any update on Dune Part Two'), 'Dune Part Two');
});

test('extractStatusTitle returns empty for a bare global query', () => {
  assert.equal(extractStatusTitle("what's downloading?"), '');
  assert.equal(extractStatusTitle('any updates?'), '');
});

test('extractStatusTitle returns empty for a pronoun target', () => {
  assert.equal(extractStatusTitle('is it ready yet?'), '');
});

// --- stallsOnStatus: catch the EXACT bug phrasing that ends in a question mark ---

test('stallsOnStatus fires on the EXACT bug reply (trailing ? included)', () => {
  assert.equal(
    stallsOnStatus('I\'m checking the status of "Severance" now. Can you wait a moment?'),
    true,
  );
});

test('stallsOnStatus fires on "Let me check on that."', () => {
  assert.equal(stallsOnStatus('Let me check on that.'), true);
});

test('stallsOnStatus fires on "Checking now, one sec."', () => {
  assert.equal(stallsOnStatus('Checking now, one sec.'), true);
});

test('stallsOnStatus fires on "Hang on, I\'ll look into it."', () => {
  assert.equal(stallsOnStatus("Hang on, I'll look into it."), true);
});

test('stallsOnStatus does NOT fire on a concrete progress answer', () => {
  assert.equal(stallsOnStatus('Severance is downloading, about 40% done.'), false);
});

test('stallsOnStatus does NOT fire on a concrete not-added answer', () => {
  assert.equal(stallsOnStatus("Severance isn't in your library yet — want me to add it?"), false);
});

test('stallsOnStatus does NOT fire on a "nothing downloading" answer', () => {
  assert.equal(stallsOnStatus('Nothing is currently downloading.'), false);
});

test('stallsOnStatus does NOT fire on a "still searching" answer', () => {
  assert.equal(stallsOnStatus('Oppenheimer is added and still searching for a release.'), false);
});

// --- parseSeasonSelection: deterministic season-phrase -> numbers (net #9) -----------------------

const FIVE = [1, 2, 3, 4, 5];

test('parseSeasonSelection: "all seasons" -> all', () => {
  assert.equal(parseSeasonSelection('all seasons', FIVE), 'all');
});
test('parseSeasonSelection: "the whole series" -> all', () => {
  assert.equal(parseSeasonSelection('grab the whole series', FIVE), 'all');
});
test('parseSeasonSelection: "just season 1" -> [1]', () => {
  assert.deepEqual(parseSeasonSelection('just season 1', FIVE), [1]);
});
test('parseSeasonSelection: "season 2" -> [2]', () => {
  assert.deepEqual(parseSeasonSelection('season 2', FIVE), [2]);
});
test('parseSeasonSelection: "seasons 1-3" range -> [1,2,3]', () => {
  assert.deepEqual(parseSeasonSelection('seasons 1-3', FIVE), [1, 2, 3]);
});
test('parseSeasonSelection: "season 1 to 4" range -> [1,2,3,4]', () => {
  assert.deepEqual(parseSeasonSelection('season 1 to 4', FIVE), [1, 2, 3, 4]);
});
test('parseSeasonSelection: "the latest season" -> [last]', () => {
  assert.deepEqual(parseSeasonSelection('just the latest season', FIVE), [5]);
});
test('parseSeasonSelection: "the newest one" -> [last]', () => {
  assert.deepEqual(parseSeasonSelection('the newest one', FIVE), [5]);
});
test('parseSeasonSelection: "the first season" -> [1]', () => {
  assert.deepEqual(parseSeasonSelection('the first season', FIVE), [1]);
});
test('parseSeasonSelection: "first and last" -> [1, last]', () => {
  assert.deepEqual(parseSeasonSelection('the first and last season', FIVE), [1, 5]);
});
test('parseSeasonSelection: "1 and 2" bare numbers -> [1,2]', () => {
  assert.deepEqual(parseSeasonSelection('1 and 2', FIVE), [1, 2]);
});
test('parseSeasonSelection: clamps out-of-range numbers (season 8 of a 5-season show)', () => {
  assert.deepEqual(parseSeasonSelection('seasons 1 and 8', FIVE), [1]);
});
test('parseSeasonSelection: returns null for a non-season message', () => {
  assert.equal(parseSeasonSelection('what is the weather', FIVE), null);
});
test('parseSeasonSelection: returns null when no seasons available', () => {
  assert.equal(parseSeasonSelection('season 1', []), null);
});

// --- topResultAlreadyInLibrary (net #11) ---------------------------------------------------------

test('topResultAlreadyInLibrary: dominant in-library top result is detected', () => {
  const r = topResultAlreadyInLibrary('Chernobyl', [
    { title: 'Chernobyl', year: 2019, in_library: true },
    { title: 'Chernobyl (2022)', year: 2022, in_library: false },
  ]);
  assert.ok(r);
  assert.equal(r!.year, 2019);
});
test('topResultAlreadyInLibrary: returns null when top is NOT in library', () => {
  assert.equal(topResultAlreadyInLibrary('The Bear', [{ title: 'The Bear', year: 2022, in_library: false }]), null);
});
test('topResultAlreadyInLibrary: returns null when top does not match the query', () => {
  assert.equal(topResultAlreadyInLibrary('Severance', [{ title: 'Some Other Show', in_library: true }]), null);
});

// --- asksWhichOne: new TV year/version confirm phrasings -----------------------------------------

test('asksWhichOne fires on "Is it the 2016 version of Fleabag you want?"', () => {
  assert.equal(asksWhichOne('Is it the 2016 version of Fleabag you want?'), true);
});
test('asksWhichOne fires on "Did you mean The Bear from 2022?"', () => {
  assert.equal(asksWhichOne('Did you mean The Bear from 2022?'), true);
});
test('asksWhichOne still ignores a "which seasons?" question (TV ask preserved)', () => {
  assert.equal(asksWhichOne('Which seasons would you like? It has 5.'), false);
});
