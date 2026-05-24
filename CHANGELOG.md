# Changelog

All notable changes to Jedd are documented here. Versions follow [semver](https://semver.org/);
each release also ships a multi-arch image at `ghcr.io/jeffreylunt/jedd:<version>`.

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
