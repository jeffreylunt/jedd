# Changelog

All notable changes to Jedd are documented here. Versions follow [semver](https://semver.org/);
each release also ships a multi-arch image at `ghcr.io/jeffreylunt/jedd:<version>`.

## [2.0.2] — 2026-08-27

Completes what 2.0.1 stood in for. The book searches choose for you again — but
only after settling **which book**.

### Added
- **Book searches pin the work before ranking releases**, against
  [Open Library](https://openlibrary.org) — free, no key, `OPEN_LIBRARY_URL` if
  you want a mirror. *"The Hobbit J.R.R. Tolkien"* resolves to `/works/OL27482W`
  and the Corey Olsen study guide is a separate work in the same response.
  Releases are then scored against that work — a different author credited, a
  guide, a box set, or a numbered volume of a series is not a candidate — and
  the healthiest swarm among the survivors is chosen. **Nobody is asked about a
  torrent.**
- **A question about books when the catalogue cannot settle it.** *"Mistborn"*
  is a series rather than a book, so Jedd asks which one and searches nothing
  until you answer. Answer *The Final Empire* and it searches for that book
  specifically rather than for what you typed.
- **`OPEN_LIBRARY_URL`**, documented in `.env.example`. Never a hard dependency:
  if the catalogue is unreachable or knows no such book, the searches fall back
  to 2.0.1's behaviour — show the releases and ask — and say which happened.

### Fixed
- A `.mobi` pick is refused with the compatible options named rather than
  silently swapped (carried from 2.0.1, and still right: substituting a row can
  substitute a book).

### Unchanged
- **TV.** `search_episode` pins the episode against Sonarr before it ranks
  anything, so swarm health was always answering the right question there.

### Known limitation
- **There is no `releasesFor(workId)` for books.** Prowlarr and the IRC bots
  index filenames and have no notion of a work, so pinning gives Jedd a title
  and an author to compare filenames against rather than a scoped result set.
  That is weaker than the TV guarantee and the matching is a heuristic. When it
  declines everything, Jedd says the book does not appear to be on the indexers
  rather than offering you something else.

## [2.0.1] — 2026-08-27

### Fixed
- **Book searches now ask which book, instead of choosing one.** `search_ebook` and
  `search_audiobook` take free text, so the releases they rank are frequently *different works* —
  the novel, an abridged edition, a companion volume, a study guide *about* the book. Ranking them
  on swarm health answers "which copy", which is the wrong question: asking for *"The Hobbit,
  J.R.R. Tolkien"* ranked a Corey Olsen study guide first on 24 seeders and the novel third on 8.
  The ranking was correct — every candidate was a healthy-swarm `.epub` — so no reordering fixes
  it. Both searches return the numbered list again, and `send_ebook` / `add_audiobook` now
  **require** the number that was chosen rather than defaulting to the top-ranked release: a
  search that asks and a consumer that acts without an answer disagree, and the consumer is the
  half that runs.
- **A `.mobi` pick is refused rather than silently swapped.** `send_ebook` used to substitute the
  best Kindle-compatible release in the list, which was correct while the list was one work's
  releases. With different works in the list, substituting sends a book nobody asked for. It now
  declines and names the compatible options.

### Unchanged
- **TV still chooses for you.** Sonarr's release search is scoped to an episode, so every candidate
  is an encoding of the same episode and swarm health is the right instrument. `search_episode` and
  `grab_release` behave exactly as they did in 2.0.0.

### Known limitation
- The book list mixes *which work* with *which copy* into a single question. Pinning book search to
  a work identifier first — so that only one book's releases are ranked, and the best of those can
  be chosen for you again — is not implemented.

## [2.0.0] — 2026-08-27

A rewrite. Jedd is now a real agent loop rather than a stateless replay, runs in a container, and
reaches well beyond movie/TV requests into homelab operations and ebook delivery.

**This is a breaking change.** The configuration variables, the tool set and the deployment model are
all different from 1.x; treat it as a new install rather than an upgrade.

### Added
- **37 tools**, up from a handful. Sonarr/Radarr/Prowlarr search and adds, Jellyfin sessions and
  invites, qBittorrent queue triage, ebook and audiobook delivery to Kindle, live TV and channel
  health, container inspection, and a deliberately unprivileged shell. The set is assembled per turn
  from what you have configured and what the requester is allowed to use.
- **Release selection ranks on swarm health, not on the name.** Releases fall into `healthy`
  (≥5 seeders) / `thin` / `dead` bands and quality only breaks ties *within* a band. A pool of
  well-named 720p releases that every quality profile approved once sat for 50–60 hours with zero
  bytes moved; a 1080p WEB-DL the profile liked less finished in minutes. Bands rather than a raw
  seeder sort, so a 900-seed CAM cannot outrank a 40-seed WEB-DL.
- **One turn per burst.** Double-texting used to produce two concurrent turns sharing one history
  array — they answered each other's questions and ran every tool twice. The queue now serialises per
  sender and merges a burst into a single turn, while different senders still run concurrently.
- **Conversation history survives a restart**, per sender, in an append-only log. Eviction and repair
  are appended rather than rewritten (`npm run history -- list|evict`), so a poisoned turn leaves
  replay without wiping the conversation or the audit trail. Tool results are deliberately never
  replayed — a stale observation presented as current is the one thing the model cannot detect.
- **The ssh privilege boundary is proven at boot**, by running `id` on both identities and requiring
  different uids, a non-root shell identity and no privileged group, with the admin identity's
  success as the inverting control. The generic shell is not registered at all on a failed verdict.
- **Containerised.** `docker compose up -d --build`, with a healthcheck and a restart policy.

### Changed
- **Recommended model is now `qwen3.8:27b`** (`qwen3.8:27b-mlx` on Apple Silicon), configured through
  **`LLM_MODEL`**. v1 read `OLLAMA_MODEL` and defaulted to `qwen2.5:7b`.
- **`OWNER_HANDLE` and `JEDD_SEND_TO` have no defaults and the process refuses to start without
  them.** Both decide who Jedd will talk to, and an empty `JEDD_SEND_TO` is a refusal rather than a
  permissive default.
- Writes are off unless `JEDD_ALLOW_WRITES=true`, and every tool must declare its write-ness at
  registration or it is refused.
- The image now also carries a `:X.Y` tag (`2.0`) alongside the existing `:X.Y.Z` and `:latest`.

### Removed
- The prose guards. v1 grew ~20 predicates that read the bot's own words looking for lies; a real
  loop answers "did you do it" from the transcript instead. There is no output filtering in the loop.

## [1.4.5] — 2026-06-16

Handle typos and slightly-wrong titles gracefully instead of a flat "couldn't find it."

### Added
- **"Did you mean…?" for misspelled or slightly-wrong titles.** When a request doesn't match anything
  exactly, Jedd now retries with a looser version of the title (dropping stray punctuation, a wrong
  trailing year, or extra words) and — if it turns up plausible matches — offers a short numbered list
  ranked by how closely each result matches what you typed: *"I couldn't find an exact match for
  'the outsdier' — did you mean one of these? 1. The Outsider (2018) — movie / 2. The Outsider (2020)
  — TV show."* Reply with the number (or the name) and Jedd adds the movie (or short show) or asks
  which seasons for a long series — reusing the same pick flow as the movie/show chooser.
- **Confident corrections just go through.** When the closest match is a near-exact, clearly-dominant
  hit (e.g. a single-letter typo), Jedd adds it directly without an extra question.

### Changed
- **Low-confidence matches always ask first.** Jedd never silently adds a fuzzy match that isn't a
  near-exact hit — if it's unsure, it shows the "did you mean?" list rather than guessing. A clean,
  exact request is unaffected and still goes straight through with no added friction, and the
  anti-fabrication guard is intact — Jedd never claims an add unless it really succeeded.

## [1.4.4] — 2026-06-16

Always search both movies and TV, and ask which you meant when a title is both.

### Added
- **Every title request now searches BOTH movies and TV.** When you ask for something without saying
  whether it's a movie or a show, Jedd now looks it up in both libraries at once and considers the
  results together — instead of guessing one type and only checking the other as a fallback.
- **A movie-and-a-show with the same name now asks which you want.** If a title matches both a movie
  *and* a TV show (or a few comparable options), Jedd presents a short numbered list and lets you
  pick — *"1. Twisted Metal (2017) — movie / 2. Twisted Metal (2023) — TV show"*. Reply with the
  number (or just "movie" / "show"), and Jedd adds the movie (or short show) or asks which seasons
  for a long series. A single clear match still goes straight through with no extra question, so the
  common case is unchanged. The anti-fabrication guard is intact — Jedd never claims it added
  something unless the add really succeeded.

## [1.4.3] — 2026-06-16

Bugfix release for the cross-type (movie↔TV) search fallback.

### Fixed
- **A found title is no longer dropped after a cross-type search.** When you ask for something
  without saying whether it's a movie or a show, Jedd searches one type first; if that comes up
  empty it now searches the other type. Previously, even when that second search *found* the title,
  the model sometimes still replied *"couldn't find it as a movie or TV show"* — so you had to nudge
  *"it's a tv show"* before it worked. Jedd now carries the found match forward: it adds the show (or
  asks which seasons for a long series) instead of discarding it. The anti-fabrication guard is
  unchanged — Jedd still never claims it added something unless the add really succeeded.

## [1.2.0] — 2026-05-24

Reliability release for the local-model (qwen2.5:7b) request flow — fixes a message-leak bug and
makes Jedd handle media that's *in your library but not actually downloaded*. All changes verified
live against real Sonarr/Radarr.

### Added
- **In-library-but-missing media is now grabbed, not glossed over.** If you ask for a movie that was
  added earlier but never downloaded, Jedd triggers a fresh search, tracks it, and tells you
  *"…already in your library but hasn't downloaded yet — I'm grabbing it now"* instead of the
  misleading "already in your library."
- **TV equivalent for incomplete shows.** Asking for a series that's in your library but missing
  episodes triggers a series search and reports *"…some episodes haven't downloaded yet — I'm
  grabbing them now."* Completeness is read from real Sonarr episode-file counts.

### Fixed
- **No more raw tool-call strings in your messages.** The model sometimes emitted a tool call as
  plain text in a no-parenthesis form (e.g. `search_movie {"query":"Hook"}`, `check_status {}`); these
  slipped the existing guard and were delivered verbatim. They're now recovered and executed (or
  suppressed), never sent to you.

### Changed
- Internal dead-code cleanup (removed unused functions/fields; no behavior change).

## [1.1.0] — 2026-05-23

First feature release since 1.0.0 — hardening for the local-model request flow.

- **Search is the source of truth** — handles brand-new releases the model's training data doesn't know.
- **No "wait a moment" stalls** — a universal backstop forces a real tool call instead of a "checking now" message.
- **Never leaks a raw tool-call string** — inline `tool(...)` calls are parsed + executed or suppressed.
- **Movies & TV only** — declines games/apps/music; never frames an ambiguous title as "the mobile game?".
- **No hallucinated adds** — gibberish/title-less messages get an honest clarifying reply; bad TMDB/TVDB ids are rejected.
- English-preferred releases via Custom Formats; 720p-preferred (1080p fallback) TV quality profile.

## [1.0.0] — 2026-05-22

Initial public release: iMessage media-request bot (BlueBubbles + local LLM) that finds and downloads
movies/TV via Sonarr/Radarr and follows up until they're ready. Default-deny access control.
