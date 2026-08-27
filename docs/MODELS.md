# Choosing a local model for Jedd

Jedd's quality depends almost entirely on how well the local Ollama model handles **tool calling** —
picking the right tool out of the registry, passing the right arguments, and following a multi-turn
conversation without hallucinating a result or claiming an add that never happened.

## Recommendation

**`qwen3.8:27b`** (~18 GB) — the current default.

```bash
ollama pull qwen3.8:27b
```

On **Apple Silicon**, `qwen3.8:27b-mlx` is the MLX build of the same model and is what the project is
developed against. It is Apple-only; on Linux or x86 use the plain tag.

**Hard requirement:** the model must support **native tool calling** in Ollama. A model without tool
support cannot drive Jedd at all. Note also that **`tool_choice` is silently ignored** by this stack,
so Jedd never relies on forced tool calling.

For qwen3-family models, disable hidden "thinking" — it otherwise burns the token budget on
multi-turn tool calls.

---

## ⚠️ Everything below is a v1.x measurement, kept for its methodology

The table and scenarios below were measured against **Jedd v1.x**, whose tool registry, prompt and
session code all differ from the current version — v1 had a handful of movie/TV tools where v2 has 37
across media, homelab and delivery. **The pass rates are therefore not comparable to today's build and
`qwen2.5:7b` is no longer the recommended model.**

It is kept because the *method* is the useful part: a live scenario suite against real services beats
a mock suite for picking a driving model, and the false-success criterion is the one that matters
most. Re-running it against v2 has not been done.

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
| **qwen2.5:7b** | 4.7 GB | **12/12 (100%)** | ~4.0s | ~6–10s | ~10s | **v1 default.** Consistent 12/12 across repeated runs; zero false-success, zero hangs. |
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

Set `LLM_MODEL` in your `.env` (e.g. `LLM_MODEL=qwen3.8:27b`), make sure you've `ollama pull`ed it,
and restart Jedd. The model must support tool calling.

> v1 read this from `OLLAMA_MODEL`; the current variable is `LLM_MODEL`.
