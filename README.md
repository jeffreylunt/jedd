# Jedd

A self-hosted agent that runs your homelab from a text message.

> **Current deployment (v2.1.0, 2026-08-31):** running as the `jedd-v2` Docker container on `jeffs-MacBook-Pro.local` (192.168.1.68), webhook `http://127.0.0.1:18796/webhook` registered with BlueBubbles. Source at `~/dev/jedd-v2`, tag `v2.1.0`. Images published to `ghcr.io/jeffreylunt/jedd:X.Y`.
>
> To rebuild + restart: `cd ~/dev/jedd-v2 && docker compose up -d --build`
> To watch logs:        `docker logs -f jedd-v2`
> Daily log sweep:       `com.jeff.jedd-issue-sweep` LaunchAgent runs at 03:00 MDT (09:00 UTC) and files GitHub issues for real problems the local model identifies in the last 24h.
> Weekly auto-fix:       `com.jeff.jedd-weekly-fix` LaunchAgent runs Sunday 03:00 MDT (09:00 UTC); for each open issue it checks out a branch off `main`, runs the `weekly-fixer` agent (MiniMax M3), pushes a branch, opens a PR (ready-for-merge, not draft), and enables auto-merge.

Ask it for a film and it searches your indexers, picks a release that will
actually finish, and adds it to Sonarr or Radarr. Ask it why live TV is
stuttering and it measures the box before it touches anything. It answers on
iMessage via BlueBubbles, or on stdout for development.

The bet: **a modern model is good at calling tools, so the code's job is to
decide what may be called — not to police what gets said.** There is no output
filtering anywhere in the loop.

---

## Quickstart

```bash
git clone https://github.com/jeffreylunt/jedd.git && cd jedd
cp .env.example .env
docker compose up -d --build
docker compose logs -f
```

### 🔴 Two variables have no default and the process REFUSES to start without them

This is deliberate — both decide *who Jedd will talk to*, and guessing either
one wrong means texting the wrong people.

| variable | why it fails closed |
|---|---|
| `OWNER_HANDLE` | who is the owner. Everyone else is a guest with a smaller tool list. |
| `JEDD_SEND_TO` | who Jedd may reply to at all. `everyone`, or a comma-separated handle list. |

`JEDD_SEND_TO=""` is **also** a refusal, not a default — an empty value that
parsed to an empty list would be an ambiguous audience, so it declines to boot
rather than pick the permissive reading. Both failures print
`[jedd] FATAL: …` and exit non-zero.

Everything else in `.env.example` has a working default. Fill in the API keys
for the services you actually run; tools for services you have not configured
simply do not appear.

**Running it without Docker**, or wiring it to a real homelab, is covered in
[SETUP.md](SETUP.md).

## The model

Recommended: **`qwen3.8:27b`** via [Ollama](https://ollama.com) (~18 GB).

```bash
ollama pull qwen3.8:27b
```

On **Apple Silicon**, `qwen3.8:27b-mlx` is the MLX build of the same model and
is what this project is developed against. It is Apple-only — on Linux or
x86 use the plain `qwen3.8:27b` tag above.

`LlmClient` is a seam, not an abstraction to build out. Any Ollama-compatible
model with tool-calling will run, but note that **`tool_choice` is silently
ignored by this stack** (verified: `tool_choice:"required"` on a message needing
no tool returned no call), so nothing may depend on forced tool calling.

## The tools

**37 tools**, and the set you get is assembled from what you have configured and
what the requester is allowed to use — so a default install exposes fewer than
37, and a guest sees fewer than the owner. Counting the tools you see and
getting a smaller number is the system working.

They cover Sonarr/Radarr/Prowlarr search and adds, Jellyfin sessions and
invites, qBittorrent queue triage, ebook and audiobook delivery to Kindle, live
TV and channel health, container inspection, and a deliberately unprivileged
shell.

Three independent gates decide what exists on any given turn:

- **What you configured.** No TMDB token, no `whats_popular`. No JFA-GO
  password, no `invite_to_jellyfin`. A tool whose dependency is absent is never
  registered, rather than registered and failing at call time.
- **Who is asking.** One owner, everyone else a guest; `src/permissions.ts`
  fails closed. Identity is resolved from the transport's sender handle in code
  and expressed as *which tools exist this turn* — a guest's list has no admin
  tools in it, and **no text in the context window can add one.**
- **Whether writes are on.** `JEDD_ALLOW_WRITES` is off by default. Absence of
  the flag is read-only, and every tool must declare its write-ness at
  registration or it is refused.

Authorisation and safety are kept apart on purpose. Being the owner unlocks the
restart tool; it does not unlock restarting while someone is watching.

## Picking a release on the swarm, not the name

Releases are ranked on **swarm health first**, with quality only breaking ties
*within* a band — `healthy` (≥5 seeders), `thin`, `dead`.

This encodes a specific failure. A Sonarr search returned a pool of 720p
releases that every quality profile approved: right show, right season, right
format. In qBittorrent they sat for 50–60 hours with zero bytes moved, ever.
Blocklisting them and taking a 1080p WEB-DL the profile liked *less* completed
in minutes.

> **A well-named release with an empty swarm is the worst option, not the best.**

It is a band rather than a raw seeder sort so that a 900-seed CAM cannot outrank
a 40-seed WEB-DL: above a handful of seeds the marginal seed buys nothing, and
sorting on the raw count would hand the quality decision to popularity.

### ⚠️ This ranking answers "which copy", and only where the work is already pinned

The mechanism depends on a precondition that is easy to miss, because it holds
on the path it was built for and not on every path that uses it.

**On TV it holds.** Sonarr's release search is scoped to an episode
(`/release?episodeId=…`), so every candidate is already an encoding of the *same
episode*. The only open question is which copy to take, and swarm health is a
good answer to that question.

**On books it does not.** `search_ebook` and `search_audiobook` take free text —
a title and, if you know it, an author. Nothing pins the *work*. So the
candidate list can contain genuinely different things: the novel, an abridged
edition, a companion volume, a study guide *about* the book. Ranking cannot
answer "which of these is the thing you asked for", and preferring the healthiest
swarm can prefer a well-seeded study guide over a thinly-seeded novel.

Asking for *"The Hobbit, J.R.R. Tolkien"* ranked a Corey Olsen study guide first
on 24 seeders; the novel itself was third on 8. The ranking was *correct* — every
candidate was a healthy-swarm `.epub`, so the seeder count decided, and the study
guide really did have the biggest swarm. The defect was in the question.

**So the book searches pin the work first**, against [Open
Library](https://openlibrary.org) — free, no key, nothing to configure. The
question becomes two questions asked in order:

1. **Which book?** The catalogue turns *"The Hobbit J.R.R. Tolkien"* into
   `/works/OL27482W` — *The Hobbit*, J.R.R. Tolkien, 1937. The Corey Olsen study
   guide is a separate work in the same response, under its own author.
2. **Which copy?** Releases are then scored against that work — a release
   crediting a different author, or announcing itself as a guide, a box set or a
   numbered volume of a series, is not a candidate — and the healthiest swarm
   among the survivors is chosen for you. Nobody is asked about a torrent.

If the catalogue cannot settle the first question, Jedd asks **which book** and
searches nothing until you answer. *"Mistborn"* is a series rather than a book,
so it asks; answer *The Final Empire* and it finds that book specifically. And
if the catalogue is unreachable, it falls back to showing you the releases and
asking — worse, and labelled as the fallback it is.

### ⚠️ What pinning the work can and cannot buy

**There is no `releasesFor(workId)` for books.** Sonarr can scope a release
search to an episode id. Prowlarr and the IRC bots index filenames and have no
notion of a work at all, so pinning does not hand Jedd a scoped set of releases
the way an `episodeId` does — it hands it a title and an author to compare
filenames against. That is genuinely weaker than the TV guarantee, and the
comparison is a heuristic over release names.

What it buys is a much narrower question, asked one release at a time: *is this
filename a copy of **this** work* rather than *which of these six filenames is
the book*. On the searches it has been measured against it gets the right book;
on a filename that carries neither the author nor a recognisable title it can
still decline a release that was fine, in which case Jedd says the book does not
appear to be on the indexers rather than offering you something else.

## One turn per burst

People double-text. Two messages seconds apart used to become two concurrent
turns sharing one history array — they answered each other's questions and ran
every tool twice.

The queue serialises **per sender** and merges a burst into a single turn.
Different senders still run concurrently, so one person's slow homelab query
never blocks another's.

## Shape

```
connector  ──▶  turn queue  ──▶  agent loop  ──▶  permission gate  ──▶  tool  ──▶  homelab
(stdout /       (one turn        (history +       (role vs             (its own
 BlueBubbles)    per burst,       tool calls)      tool.minRole)        preconditions)
                 per sender)
```

- **`src/turn-queue.ts`** — serialises per sender, merges bursts.
- **`src/agent.ts`** — ask the model, run the tools it asked for, append
  results, repeat (max 8 steps). No output filtering.
- **`src/capability-denial.ts`** — **counts** turns where the reply asserted a
  limit on Jedd's own tools that nothing in the turn licensed. It has told its
  owner three times that it could not do something it could, and a false denial
  closes the question — one of them produced a feature request for a capability
  he already had. Purely observational: the reply is already final, so *no output
  filtering* stays literally true. ⚠️ The count is a **floor** — a phrase list
  caught 74% of such turns across the historical log but only 25% of eight live
  denials of one question. Report "at least N".
- **`src/permissions.ts`** — one owner, everyone else a guest. Fails closed.
- **`src/command-gate.ts`** — deny-by-default allowlist for the generic shell.
- **`src/safety.ts`** — restart preconditions, including "UNKNOWN is not idle".
- **`src/store.ts`** — append-only conversation history.
- **`src/connector.ts`** — the transport seam. Nothing above it knows the
  transport.

```bash
npm install
npm test        # 1411 tests, no network needed
npm run chat    # talk to it on stdout
```

### Cutting a release

```bash
# 1. make sure tests are green
npm test

# 2. tag the release
git tag -a vX.Y.Z -m "vX.Y.Z — <one-line summary>"

# 3. rebuild the image
docker compose build

# 4. (manually) tag and push to ghcr.io — see "Releases" below
docker tag jedd-v2:local ghcr.io/jeffreylunt/jedd:X.Y.Z
docker push ghcr.io/jeffreylunt/jedd:X.Y.Z

# 5. restart the running container
docker compose up -d
```

### Releases

Versioned images are published to `ghcr.io/jeffreylunt/jedd:X.Y.Z`. Each tag corresponds to a `git tag` of the same name. The current image ID and SHA are visible with `docker inspect jedd-v2` — cross-reference against the git log to confirm the running container matches the tag you expect to be running.

A change should not be deployed until it is on a tag: rolling from `git pull` is not supported, because the bind-mounted `data/` directory and the BlueBubbles webhook registration are persistent and a mid-flight process restart has to be deliberate.

### Daily log sweep

`com.jeff.jedd-issue-sweep` (LaunchAgent on the host) runs at 03:00 MDT / 09:00 UTC daily. It:

1. Pulls the last 24h of `docker logs jedd-v2` filtered for `FATAL|ERR|UNKNOWN|timeout|fail|refused|threw|cannot|panic|denial=fail|denial=unlicensed`
2. Pulls the last 24h of `data/audit.jsonl` — only entries with at least one failed tool call
3. Sends both to Ollama (`qwen3.8:27b-mlx`) with a structured prompt; the model returns strict JSON: `[{title, body, severity, dedupe_key}]`
4. Deduplicates against existing open issues by title (lowercase), and against a local `data/issue-sweep-state.jsonl` by `dedupe_key` for same-day collisions
5. Opens new issues via `gh issue create --repo jeffreylunt/jedd --label auto-sweep` (the label is auto-created on first run)

The model is told explicitly **not** to file an issue for the design-feature log lines (the `[notice]` 240s timeout line, the `[presence] stop typing … timeout (ignored; a reply is unaffected)` line, the `skipped rowid … outbound echo` lines, the boot banner) — they would be noise. Better to file nothing than to file noise.

Manual run (does not respect the schedule):
```bash
bash ~/dev/jedd-v2/scripts/daily-issue-sweep.sh          # actually file
bash ~/dev/jedd-v2/scripts/daily-issue-sweep.sh --dry-run # print what would be filed, do not file
```

Sweep log: `~/dev/jedd-v2/data/issue-sweep.log`. State log: `~/dev/jedd-v2/data/issue-sweep-state.jsonl`. LaunchAgent logs: `~/Library/Logs/opencode-stack/jedd-issue-sweep.{stdout,stderr}.log`.

**The sweep requires `gh auth` to be valid on the host.** If you see `HTTP 401` in the sweep log, re-auth with `gh auth login --insecure-storage -h github.com` (the `--insecure-storage` flag writes the token to `~/.config/gh/hosts.yml` so SSH-launched processes can read it; the default keychain path is unreachable from non-GUI sessions).

### Weekly auto-fix

`com.jeff.jedd-weekly-fix` (LaunchAgent on the host) runs Sunday at 03:00 MDT / 09:00 UTC. For each open issue on the repo that does not already have an open PR:

1. Fetches `origin/main`, creates a new branch `auto-fix/issue-<NUMBER>-<short-slug>` off it
2. Invokes the `weekly-fixer` opencode agent (model `minimax/MiniMax-M3`) with the issue body + standing rules. The agent investigates the code, writes the minimum fix, runs `npm test` (must pass at the current count — 1425 as of this writing), commits (`fix #<NUMBER>: <summary>`), pushes the branch, and opens a PR
3. The agent's last line of output is the PR URL — the script enables auto-merge on it (`gh pr merge --auto --squash`); if checks fail the PR stays open for manual review
4. If `npm test` fails the agent returns `TESTS_FAILED` instead of a PR URL; the script then comments on the issue and skips

**Standing rules baked into the agent:**
- Never push to `main`, never force-push, never delete other branches
- Never modify `data/`, `scripts/messages-poke.mjs`, secrets, or `.env`
- All 1425 tests must pass before any commit/push

Manual run (does not respect the schedule):
```bash
bash ~/dev/jedd-v2/scripts/weekly-fix-sweep.sh                       # process all open issues
bash ~/dev/jedd-v2/scripts/weekly-fix-sweep.sh --dry-run             # list what would be processed
bash ~/dev/jedd-v2/scripts/weekly-fix-sweep.sh --issue 42            # process just issue 42
```

Per-run log: `~/dev/jedd-v2/data/weekly-fix.log`. State log: `~/dev/jedd-v2/data/weekly-fix-state.jsonl`. LaunchAgent logs: `~/Library/Logs/opencode-stack/jedd-weekly-fix.{stdout,stderr}.log`.

In the chat REPL, `sender:+15559998888` switches which identity you are speaking
as. That is how you exercise the permission boundary by hand.

---

# Why it is built this way

The rest of this file is design rationale. You do not need it to run Jedd.

## Why there are no prose guards

An earlier version grew ~20 predicates that read the bot's own words looking for
lies, because a stateless replay-the-history design let the model claim an
action it never took. Grounding answers *"is that true"*; it can never answer
*"did you do it"*.

In a real loop that second question is answered by the transcript: a tool either
executed and returned a result, or it is absent. Every turn is appended to
`data/audit.jsonl` with the tools it called and whether each succeeded — so a
claim can be checked against the record instead of against a regex.

**Read the honest limit of that claim before relying on it:** the loop makes the
answer *auditable*, not *impossible to misstate*. A model can still narrate a
write it never performed. What makes that harmless here is that writes are
unreachable except through gated tools — so a bluffed claim moves no bytes, and
shows up as a turn with no matching tool call.

## 🔴 The security boundary is the OS, not the command filter

`src/command-gate.ts` is defence-in-depth, **not** the boundary. A review found
`awk 'BEGIN{system("docker restart gluetun")}'` passed it — and the lesson was
not "add awk to a denylist" but that a filter reading command *text* to predict
its *effect* is the same losing game as prose nets. **Every allowlisted binary
is a potential interpreter.**

So `hp_shell` connects as an **unprivileged ssh identity with no docker group**
(`HP_SHELL_SSH_HOST`), while structured tools use a privileged one
(`HP_ADMIN_SSH_HOST`) and carry the safety preconditions. A smuggled interpreter
then fails at the kernel regardless of what the filter believed. **`hp_shell` is
not registered at all when the two are equal.**

**The boundary is proven at every boot, by running something.**
`proveShellIdentityIsSafe()` reads `id` on both ssh identities and requires
different uids, a non-root shell identity, and no privileged group; then it
attempts the docker crossing with the admin identity succeeding as the inverting
control. `buildTools()` registers `hp_shell` only on a safe verdict, so
**forgetting to prove the boundary yields no shell** rather than one granted on
a string comparison.

⚠️ It replaced a check that compared two ssh **aliases for inequality**, which
meant `HP_SHELL_SSH_HOST=user@host` against `HP_ADMIN_SSH_HOST=host` read as a
live split while being one account — and an empty value passed too. **A string
comparison is not a boundary check.**

**Verified by crossing it, not by reading the config.** From the unprivileged
account: `docker ps` → `permission denied … unix:///var/run/docker.sock`; the
same through `awk 'BEGIN{system(…)}'`, through `curl --unix-socket`, and through
`python3`'s raw `AF_UNIX` connect → all denied; `sudo -n true` → `a password is
required`. **Control: every one of those succeeds as the admin identity**, so
the refusals are caused by the identity and not by something being broken.

**Docker reads are structured tools** (`docker_ps`, `docker_inspect`,
`docker_logs`, `container_netns`) on the admin identity, parameterized by a
validated container name and clamped numbers. **No socket proxy was built** —
those reads were never shell-shaped, so the boundary cost no capability.

## Persistence exists to finish a job

History survives a restart, per sender, in an append-only log (`src/store.ts`).
Eviction and repair are **appended**, so a poisoned turn leaves replay without
wiping the conversation or rewriting the audit trail:

```bash
npm run history -- list <handle>
npm run history -- evict <id> "<reason>"
```

🔴 **Tool results are NOT persisted and never replayed.** A tool result is an
observation with a timestamp; replaying one presents yesterday's reading as
today's context, and the model has no way to tell. The whole architecture rests
on *"ground every claim in a tool result"*, so silently ageing those results
poisons the one thing the model is told to trust. **Jedd remembers what was said
and re-observes what is true.**

The replay bound (20 turns / 7 days) **announces its truncation** rather than
hiding it. Replaying a fixed window and silently losing the rest means a
conversation continuing across an outage comes back with a hole nobody can see.

## The first safe autonomous fix, and why it is not a restart

`shed_host_load` throttles qBittorrent to free uplink and VPN-encryption CPU. It
exists because of an inversion that is easy to get backwards: **"I'm watching
the game and it's stuttering" comes from an ACTIVE VIEWER, so the report is
proof that the restart-blocking condition holds.** The intuitive response —
restart something in the live-TV path — is the worst available action; a
mid-game restart once cost eight hours of live TV. Shedding torrent bandwidth is
the one documented fix that helps a viewer *without touching the stream*.

- **The precondition is four-state and three of them refuse.**
  `shed-warranted` is the only one that authorises the write. `clear` says the
  box was measured and is fine; `qbit-not-the-cause` says the box is loaded but
  shedding would not help; `unknown` says the instruments were blind.
  **`unknown` and `clear` are deliberately different verdicts** — "I could not
  see" must never be reported as "nothing is wrong".
- **Two ways to be contended**, because one statistic cannot see both shapes: a
  sustained slowdown moves the median, and an intermittent stall does not move
  it at all — and intermittent is exactly what a stuttering viewer experiences.
- **The after-check re-measures the SYMPTOM**, never the mechanism. "The API
  returned 200" and "qBittorrent says alternate limits are on" are the fix
  grading its own homework.
- ⚠️ The obvious implementation, `toggleSpeedLimitsMode`, would have made things
  **worse**: on the box this was written for, the alternate limits are unlimited
  while the normal upload limit is capped, so flipping modes would have removed
  the only cap in force.

## The only path by which Jedd speaks without being spoken to

`shed_host_load` leaves a throttle that nothing else would ever remove, so it
schedules its own return visit. Every follow-up record carries **why** it was
scheduled, **to whom** it must speak, and **what was observed** at the time;
when it wakes it re-observes and reports both.

- **Refuses rather than guesses** — unreadable qBittorrent, unreadable
  `/Sessions`, unmeasurable host all defer, and none licenses touching the
  throttle.
- **Holds while anyone is watching.** Lifting puts load *back* on the box, so
  this is the direction that can disturb a viewer.
- **Deferral is bounded, and it says when it gave up.** A follow-up that quietly
  stops retrying has left a change on the box that nobody knows about.
- **No news is not news** — if there is nothing to do it resolves silently.
- The recipient's authorisation is **re-derived at send time**, never trusted
  from the record.
- ⚠️ Only a `clear` verdict lifts the throttle. `qbit-not-the-cause` must not:
  while the throttle is on, qBittorrent's throughput is capped by definition, so
  a successful shed is exactly what makes it look innocent. **A measurement
  taken through your own intervention is not independent of it.**

## Safety lives in code, not in the prompt

- `hp_shell` runs on the homelab host only — never on the machine Jedd runs on.
  Deny-by-default allowlist; every pipeline segment is checked, command
  substitution and file redirection are refused.
- `restart_container` gathers its own evidence (is it up? is anyone watching?)
  and refuses on UNKNOWN. Protected containers restart only when completely down
  and nobody is watching.
- The VPN container is never restarted and its settings are never touched — no
  tool expresses it.
- Writes are off unless `JEDD_ALLOW_WRITES=true`. Absence of the flag is
  read-only.

None of this is phrased as an instruction the model could be argued out of.

## Known limitations

- **`docker_logs` puts container log lines verbatim into the model's context**,
  which is an untrusted-content channel. It is bounded by the same tool boundary
  as everything else — a prompt-injected model still cannot reach a write except
  through a gated tool — but it is real surface.
- **The permission model has exactly two roles**, owner and guest. There is no
  per-tool grant, no group, and no way to give one guest more than another.
- **There is no forced tool calling on this stack.** `tool_choice` is silently
  ignored, so the loop cannot compel a call and must tolerate a turn that
  answers without one.
- **`hp_shell` requires two genuinely separate ssh accounts.** If you only have
  one, the boot probe refuses the verdict and the tool is simply absent — safe,
  but it means the generic shell is unavailable until you provision the second
  account.
- **The connector implements stdout and BlueBubbles.** `Connector` is the seam;
  any other transport is unwritten.

## License

MIT — see [LICENSE](LICENSE).
