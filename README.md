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

## 🔴 The security boundary is the OS, not the command filter

`src/command-gate.ts` is defence-in-depth, **not** the boundary. A review found
`awk 'BEGIN{system("docker restart gluetun")}'` passed it — and the lesson was not "add awk to a
denylist" but that a filter reading command *text* to predict its *effect* is the same losing game
as V1's prose nets. Every allowlisted binary is a potential interpreter.

So `hp_shell` connects to hp as an **unprivileged ssh identity with no docker group**
(`HP_SHELL_SSH_HOST`), while structured tools use a privileged one (`HP_ADMIN_SSH_HOST`) and carry
the safety preconditions. A smuggled interpreter then fails at the kernel regardless of what the
filter believed. **`hp_shell` is not registered at all when the two are equal.**

**The account exists and the boundary is live** (`jedd-shell@hp`, uid 1001, sole group
`jedd-shell` — no docker, no sudo, key auth only, Unix password locked). Provisioned 2026-08-24;
`JEDD_ALLOW_SHARED_SSH_IDENTITY` is gone from `.env` and the UNSAFE boot warning with it.

**Verified by crossing it, not by reading the config.** From that account: `docker ps` →
`permission denied … unix:///var/run/docker.sock`; the same through `awk 'BEGIN{system(…)}')`, through
`curl --unix-socket`, and through `python3`'s raw `AF_UNIX` connect → all denied; `sudo -n true` →
`a password is required`; `/etc/shadow` and `/home/jeff` → denied. **Control: every one of those
succeeds as `jeff`**, so the refusals are caused by the identity and not by something being broken.

**Docker reads are structured tools now** (`docker_ps`, `docker_inspect`, `docker_logs`,
`container_netns`) on the admin identity, parameterized by a validated container name and clamped
numbers. **No socket proxy was built** — those reads were never shell-shaped, so the boundary cost
no capability. A live run confirmed the model routes correctly: host questions to `hp_shell`,
container questions to the structured tools, no permission-denied in between.

## Identity comes from the transport, never from the message

The system prompt does not say who it is talking to. An identity assertion in the context window can
be contended with by anything else in that window. Identity is resolved from the sender handle in
code and expressed as **which tools exist this turn** — a guest's list has no admin tools in it, and
no text can add one.

Two orthogonal axes, kept apart on purpose:
- **Authorisation** — who you are → which tools exist.
- **Safety preconditions** — is this action safe *right now* → binds the owner just as hard.

Owner authorisation unlocks the restart tool. It does not unlock restarting while someone is
watching.

## Safety lives in code, not in the prompt

- `hp_shell` runs on **hp only** — never on this machine. Deny-by-default allowlist; every pipeline
  segment is checked, command substitution and file redirection are refused.
- `restart_container` gathers its own evidence (is it up? is anyone watching?) and refuses on
  UNKNOWN. Protected containers restart only when completely down and nobody is watching.
- gluetun is never restarted and its settings are never touched — no tool expresses it.
- Writes are off unless `JEDD_ALLOW_WRITES=true`. Absence of the flag is read-only.

None of this is phrased as an instruction the model could be argued out of.

## Known limitations

- **The unprivileged ssh account is not provisioned**, so the OS boundary is not yet real. It does
  **not** need a docker socket proxy: `docker ps/inspect/logs` are read-only, fixed-shape and
  parameterized only by a container name, so they belong as structured tools on the admin identity.
  A boundary that appears to cost a capability usually just relocates the call.
- Blast-radius **tiers** are missing: the protected-container set is flat, so an unclassified
  container defaults *permissive*, which is the wrong default.
- `docker exec` is blocked by the gate, which also blocks legitimate read-only diagnostics that need
  it (e.g. the netns-inode check, `docker exec <c> readlink /proc/self/ns/net`). Fixing this means
  gating the nested command with the same allowlist.
- Conversation history is in memory; a restart forgets everything.
- Pinned to `qwen3.8:27b-mlx` via Ollama. `LlmClient` is a seam, not an abstraction to build out.
  There is **no forced tool calling** on this stack (`tool_choice` is silently ignored — verified),
  so nothing may depend on it.
- No BlueBubbles connector yet — `Connector` is the seam.
