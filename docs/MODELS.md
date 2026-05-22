# Choosing a local model for Jedd

Jedd's quality depends almost entirely on how well the local Ollama model handles **tool calling** —
picking the right tool (`search_movie` / `search_tv` / `add_movie` / `add_tv` / `check_status`),
passing the right arguments (title, year, season), and following a multi-turn conversation without
hallucinating a result or claiming an add that never happened.

This document records the models we tested and why we recommend the default.

## Recommendation

**`qwen2.5:7b`** (4.7 GB) — the config default (`OLLAMA_MODEL=qwen2.5:7b`).

- Best correctness in the live tool-calling suite (perfect score), with no false-success and no hangs.
- ~2x faster than the larger coding model it replaced.
- A general **instruct** model beat the coding-specialized models at Jedd's actual task. Coding models
  tended to over-disambiguate (list every same-title result and ask "which one?") instead of just
  adding the obvious match, and were slower.

**Lighter alternative:** `qwen3:8b` (5.2 GB) is fast and nearly as reliable if you want a smaller
resident model. For qwen3-family models in Ollama, disable hidden "thinking" (it otherwise burns the
token budget on multi-turn tool calls).

**Hard requirement:** the model must support **native tool calling** in Ollama. A model without tool
support cannot drive Jedd at all. `ollama pull qwen2.5:7b` and you're set.

## Methodology

The authoritative test for Jedd is a **live scenario suite**, not a generic coding benchmark. It
drives Jedd's real session code against **real Sonarr/Radarr** (the same path production uses), one
model per process (exactly how the deployed bot loads a model). For each scenario it measures:

- **Correctness** — did the bot do the right thing (right tool, right args, right multi-turn flow)?
- **No false-success** — a scenario that expects a specific title fails if the bot reports "added it"
  but landed the *wrong* item (or nothing). This catches the most damaging failure: a confident
  reply with a wrong/hallucinated id.
- **No hang** — turns are capped; a model that stalls fails the scenario.
- **Latency** — per-turn p50/p95/max, with each model warmed before timing.

### Scenarios (12)

The suite covers the things people actually text the bot:

- **Movie adds:** simple add, fuzzy/typo title, an item already in the library (must not re-add),
  a title that doesn't exist (must refuse cleanly).
- **TV adds & seasons:** single-season show (add directly), multi-season show (ask which seasons
  first), "all of them" / specific-seasons follow-ups.
- **Routing:** a cartoon/series routed to TV vs. a film routed to movies.
- **Disambiguation:** same-title-different-year (e.g. multiple "Whiplash"/"Eternity" results) — pick
  the obvious match for a bare title, or use the year the user gave instead of re-asking.
- **Status:** "is it ready?", "what's downloading?" — check status, never a spurious add.
- **Access control:** owner/family allowed; a stranger gets a canned refusal with no tool call.

### Settings

`temperature=0`, `num_ctx=8192`, qwen3-family run with thinking disabled. Hardware: Apple M1 Max,
32 GB, contention-free. Latency scales with hardware; correctness rankings should not.

## Full results (live suite)

| Model | Size | Pass rate | p50 | p95 | max | Notes |
|---|---|---|---|---|---|---|
| **qwen2.5:7b** | 4.7 GB | **12/12 (100%)** | ~4.0s | ~6–10s | ~10s | **Recommended default.** Consistent 12/12 across repeated runs; zero false-success, zero hangs. |
| qwen2.5-coder:14b | 9.0 GB | 10/12 (83%) | ~7s | 9–30s | 30s | Previous default. Over-disambiguates and ignores the add-first rule; slower. |
| qwen3:8b | 5.2 GB | 9/12 (75%) | ~2.7s | ~10s | 10s | Fast; missed a recovery case. Good lighter alternative. |
| qwen2.5:14b | 9.0 GB | 8/12 (67%) | ~5.3s | ~16s | 16s | Called the wrong tool on a movie pick (a false-success). |
| llama3.1:8b | 4.9 GB | 7/12 (58%) | ~4.6s | ~8.7s | — | Weak routing; spurious tool call on a plain greeting. |
| mistral-nemo | 7.1 GB | 7/12 (58%) | ~11s | ~17s | — | Slow; missed disambiguation/recovery cases. |
| granite3.3:8b | 4.9 GB | 2/12 (17%) | ~3.9s | ~15s | — | Poor tool-caller — not viable for Jedd. |

A separate, mock-based suite (tools mocked, so it isolates tool-calling form) ranked qwen2.5-coder:14b
highest — but the live suite exposed failures the mock hid (over-disambiguation against real multi-year
lookups, bare "Adding X" false-success). **Prefer the live result for picking the driving model.**

## Switching models

Set `OLLAMA_MODEL` in your `.env` (e.g. `OLLAMA_MODEL=qwen3:8b`), make sure you've `ollama pull`ed it,
and restart Jedd. The model must support tool calling.
