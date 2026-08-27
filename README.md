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

**The boundary is PROVEN at every boot, by running something.** `proveShellIdentityIsSafe()` reads
`id` on both ssh identities and requires **different uids**, a non-root shell identity and no
privileged group; then attempts the docker crossing with the admin identity succeeding as the
inverting control. `buildTools()` registers `hp_shell` only on a safe verdict, so **forgetting to
prove the boundary yields no shell** rather than one granted on a string comparison.

⚠️ It replaced a check that compared two ssh **aliases for inequality**, which meant
`HP_SHELL_SSH_HOST=jeff@hp` against `HP_ADMIN_SSH_HOST=hp` read as a live split while being one
account — and an empty value passed too. **A string comparison is not a boundary check.**

**The account exists and the boundary is live** (`jedd-shell@hp`, uid 1001, sole group
`jedd-shell` — no docker, no sudo, key auth only, Unix password locked). Provisioned 2026-08-24;
`JEDD_ALLOW_SHARED_SSH_IDENTITY` is gone from `.env` and the UNSAFE boot warning with it.

**Verified by crossing it, not by reading the config.** From that account: `docker ps` →
`permission denied … unix:///var/run/docker.sock`; the same through `awk 'BEGIN{system(…)}')`, through
`curl --unix-socket`, and through `python3`'s raw `AF_UNIX` connect → all denied; `sudo -n true` →
`a password is required`; `/etc/shadow` and `/home/user` → denied. **Control: every one of those
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

## The first safe autonomous fix, and why it is not a restart

`shed_host_load` throttles qBittorrent to free uplink and VPN-encryption CPU. It exists because of an
inversion that is easy to get backwards: **"I'm watching the game and it's stuttering" comes from an
ACTIVE VIEWER, so the report is proof that the restart-blocking condition holds.** The intuitive
response — restart something in the live-TV path — is the worst available action; a mid-game
Dispatcharr restart cost eight hours of live TV on 2026-04-27. Shedding torrent bandwidth is the one
documented fix that helps a viewer *without touching the stream*.

- **Precondition is four-state and three of them refuse.** `shed-warranted` is the only one that
  authorises the write. `clear` says the box was MEASURED and is fine; `qbit-not-the-cause` says the
  box is loaded but shedding would not help; `unknown` says the instruments were blind. **`unknown`
  and `clear` are deliberately different verdicts** — "I could not see" must never be reported as
  "nothing is wrong".
- **Two ways to be contended**, because one statistic cannot see both shapes: a sustained slowdown
  moves the median, and an intermittent stall does not move it at all — and intermittent is exactly
  what a stuttering viewer experiences.
- **The after-check re-measures the SYMPTOM**, never the mechanism. "The API returned 200" and
  "qBittorrent says alternate limits are on" are the fix grading its own homework.
- **It borrows qBittorrent's alternate limits and gives them back**, so qBittorrent itself remains
  the store of what "normal" means — which matters because Jedd has no persistence yet.
- ⚠️ The obvious implementation, `toggleSpeedLimitsMode`, would have made things **worse**: measured
  on this box, the alternate limits are 0 (unlimited) while the normal upload limit is 5 MB/s, so
  flipping modes would have removed the only cap in force.

## Persistence exists to finish a job

History survives a restart, per sender, in an append-only log. Eviction and repair are **appended**,
so a poisoned turn leaves replay without wiping the conversation or rewriting the audit trail
(`npm run history -- list <handle>` / `evict <id> "<reason>"`). The V1 trap this closes: a bad reply
keeps poisoning history after the bug that produced it is fixed.

🔴 **Tool results are NOT persisted and never replayed.** A tool result is an observation with a
timestamp; replaying one presents yesterday's reading as today's context, and the model has no way to
tell. The whole architecture rests on *"ground every claim in a tool result"*, so silently ageing
those results poisons the one thing the model is told to trust. **Jedd remembers what was said and
re-observes what is true.**

The replay bound (20 turns / 7 days) **announces its truncation** rather than hiding it. V1 replayed
the last 50 messages and silently lost the rest, so a conversation continuing across an outage came
back with a hole nobody could see.

## The only path by which Jedd speaks without being spoken to

`shed_host_load` leaves a throttle that nothing else would ever remove, so it schedules its own
return visit. Every follow-up record carries **why** it was scheduled, **to whom** it must speak, and
**what was observed** at the time; when it wakes it re-observes and reports both.

- **Refuses rather than guesses** — unreadable qBittorrent, unreadable `/Sessions`, unmeasurable host
  all defer, and none licenses touching the throttle.
- **Holds while anyone is watching.** Lifting puts load *back* on the box, so this is the direction
  that can disturb a viewer.
- **Deferral is bounded, and it says when it gave up.** A follow-up that quietly stops retrying has
  left a change on the box that nobody knows about.
- **No news is not news** — if there is nothing to do it resolves silently.
- The recipient's authorisation is **re-derived at send time**, never trusted from the record.
- ⚠️ Only a `clear` verdict lifts the throttle. `qbit-not-the-cause` must not: while the throttle is
  on, qBittorrent's throughput is capped by definition, so a successful shed is exactly what makes it
  look innocent. **A measurement taken through your own intervention is not independent of it.**

## Safety lives in code, not in the prompt

- `hp_shell` runs on **hp only** — never on this machine. Deny-by-default allowlist; every pipeline
  segment is checked, command substitution and file redirection are refused.
- `restart_container` gathers its own evidence (is it up? is anyone watching?) and refuses on
  UNKNOWN. Protected containers restart only when completely down and nobody is watching.
- gluetun is never restarted and its settings are never touched — no tool expresses it.
- Writes are off unless `JEDD_ALLOW_WRITES=true`. Absence of the flag is read-only.

None of this is phrased as an instruction the model could be argued out of.

## Known limitations

- **The identity split is asserted by string inequality on two ssh aliases**, nothing more.
  `HP_ADMIN_SSH_HOST=hp` with `HP_SHELL_SSH_HOST=jeff@hp` would read as a live boundary while being
  one account. The real evidence is a manual crossing (see above) that no longer runs. A boot-time
  behavioural probe — `id -nG` on the shell identity, refuse if `docker` appears — would close it.
- **`docker_logs` puts container log lines verbatim into the model's context**, which is a new
  untrusted-content channel. Bounded by the same tool boundary as everything else (a prompt-injected
  model still cannot reach a write except through a gated tool), but it is new surface.
- The command gate blocks `docker exec` for the shell, which is now correct and costs nothing: the
  shell account cannot reach docker anyway, and the netns-inode diagnostic came back as
  `container_netns` on the admin identity.
- Conversation history is in memory; a restart forgets everything.
- Pinned to `qwen3.8:27b-mlx` via Ollama. `LlmClient` is a seam, not an abstraction to build out.
  There is **no forced tool calling** on this stack (`tool_choice` is silently ignored — verified),
  so nothing may depend on it.
- No BlueBubbles connector yet — `Connector` is the seam.
