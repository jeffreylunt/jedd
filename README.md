# Jedd V2 — proof of concept

A thin agent loop for the homelab. The bet: the model is good at tool calls, so the code's job is
to decide **what may be called**, not to police **what gets said**.

```
npm install
cp .env.example .env      # fill in OWNER_HANDLE and JELLYFIN_API_KEY
npm test                  # 34 tests, no network needed
npm run chat              # talk to it on stdout
```

In the chat REPL, `sender:+15559998888` switches which identity you are speaking as. That is how you
exercise the permission boundary by hand.

## The shape

```
connector  ──▶  agent loop  ──▶  permission gate  ──▶  tool  ──▶  homelab
(stdout /       (history +       (role vs             (its own
 BlueBubbles)    tool calls)      tool.minRole)        preconditions)
```

- **`src/agent.ts`** — the loop. Ask the model, run the tools it asked for, append results, repeat
  (max 8 steps). There is no output filtering anywhere in it.
- **`src/permissions.ts`** — one owner, everyone else a guest. Fails closed.
- **`src/command-gate.ts`** — deny-by-default allowlist for the generic shell.
- **`src/safety.ts`** — restart preconditions, including "UNKNOWN is not idle".
- **`src/connector.ts`** — the transport seam. Nothing above it knows the transport.

## Why there are no prose guards

V1 grew ~20 predicates that read Jedd's own words looking for lies, because a stateless
replay-the-history design let the model claim an action it never took. Grounding answers *"is that
true"*; it can never answer *"did you do it"*.

In a real loop that second question is answered by the transcript: a tool either executed and
returned a result, or it is absent. Every turn is appended to `data/audit.jsonl` with the tools it
called and whether each succeeded — so a claim can be checked against the record instead of against
a regex.

**Read the honest limit of that claim before relying on it:** the loop makes the answer *auditable*,
not *impossible to misstate*. A model can still narrate a write it never performed. What makes that
harmless here is that writes are unreachable except through gated tools — so a bluffed claim moves
no bytes, and shows up as a turn with no matching tool call.

## Safety lives in code, not in the prompt

- `hp_shell` runs on **hp only** — never on this machine. Deny-by-default allowlist; every pipeline
  segment is checked, command substitution and redirection are refused.
- `restart_container` gathers its own evidence (is it up? is anyone watching?) and refuses on
  UNKNOWN. Protected containers restart only when completely down and nobody is watching.
- gluetun is never restarted and its settings are never touched — no tool expresses it.
- Writes are off unless `JEDD_ALLOW_WRITES=true`. Absence of the flag is read-only.

None of this is phrased as an instruction the model could be argued out of.

## Known limitations

- `docker exec` is blocked by the gate, which also blocks legitimate read-only diagnostics that need
  it (e.g. the netns-inode check, `docker exec <c> readlink /proc/self/ns/net`). Fixing this means
  gating the nested command with the same allowlist.
- Conversation history is in memory; a restart forgets everything.
- Only the Ollama client exists. `LlmClient` is the seam for an Anthropic one.
- No BlueBubbles connector yet — `Connector` is the seam.
