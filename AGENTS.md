# Working in this repo, for agents

You are about to change a bot that **texts a real person from a real phone
number**. Jedd is running right now. Most of what follows is here because it
looks correct and is not.

This is not a tour. [README.md](README.md) explains what Jedd is and why it is
built this way; [SETUP.md](SETUP.md) covers wiring it to a homelab. This file
only covers things that are **true of this repo** and that a competent agent
would otherwise get wrong.

Every non-obvious claim below names how it was established. Where I did not
verify something, it says so — see [What I am not sure of](#what-i-am-not-sure-of)
at the end. Prefer a line with a measurement behind it over one without.

---

## 1. Where the code actually runs

**Jedd runs under pm2 as `jedd-v2`, on THIS Mac.** Not Docker, not the `hp`
homelab box.

```bash
export PATH=/opt/homebrew/bin:$PATH
pm2 describe jedd-v2     # -> online; script path /Users/jeff/dev/jedd-v2-prod/src/main.ts
```

### 🔴 THIS SECTION SAID THE OPPOSITE UNTIL 2026-09-17. READ THE MEASUREMENT.

It said Jedd was the Docker container `jedd-v2`, and — in bold, with a 🔴 —
that **the pm2 entry must be left stopped**. Following that today stops the
live bot. What is actually true, measured 2026-09-17 on `Mac-Studio.local`
(which IS `192.168.1.71` — there is no "second Mac"):

| check | result |
|---|---|
| `pm2 describe jedd-v2` | **online**, `src/main.ts`, interpreter `/opt/homebrew/bin/node --import tsx` |
| `docker ps` | **500 Internal Server Error** — the daemon does not answer at all |
| any `jedd-v2` container | none; Docker Desktop's VM never comes up |
| BlueBubbles webhook table (`GET /webhook` on `:1234`) | exactly **one** row, pointing at the pm2 process |

The pm2 process served a full live turn end-to-end on 2026-09-17 13:44 (owner
message in, reply delivered, confirmed in the receiving inbox), so it is not
merely running — it **is** production.

I did not establish WHEN or WHY the deployment moved back off Docker; the
`Dockerfile` and `docker-compose.yml` are still in the tree and still build.
What is established is the state above. If you find Docker serving again,
re-measure rather than trusting either version of this section.

### 🔴 A pm2 restart DOES deploy your working tree — including uncommitted edits

`ecosystem.config.cjs` runs `src/main.ts` through `tsx` **straight off disk**
(`interpreter: '/opt/homebrew/bin/node'`, `interpreter_args: '--import tsx'`).
There is no build step and nothing is baked into an image, so:

```bash
export PATH=/opt/homebrew/bin:$PATH
pm2 restart jedd-v2
```

ships whatever `src/` says at that instant. **Commit before you restart** — a
restart with a half-finished edit in the tree puts that edit in front of a real
person.

⚠️ This inverts the previous advice, which told you a restart could not deploy.
`spaces/jedd-v2/knowledge/restart-deploys-the-working-tree.md` — which this
file used to dismiss as STALE — is the one that now matches reality.

### Proving what is actually running

pm2's uptime is the check the Docker era lacked: compare it against when your
commit landed.

```bash
pm2 jlist | python3 -c "import json,sys;[print(p['pm2_env']['pm_uptime']) for p in json.load(sys.stdin)]"
```

A process older than your commit is not running your code, however healthy it
looks. Better still, find a request only your build can make and watch for it
in BlueBubbles' own log (`~/Library/Logs/bluebubbles-server/main.log`) — the
live-guid fix was confirmed that way on 2026-09-17 by the `/api/v1/chat/query`
call, which no earlier build ever emitted.

### Rebuilding (Docker only — NOT the current deployment, see above)

Kept because the image still builds and the trap below is real if you ever use
it. It is **not** how code reaches production today; `pm2 restart` is.

```bash
export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
/usr/local/bin/docker compose up -d --build
```

🔴 **The `PATH` export is required, not decoration.** `~/.docker/config.json`
sets `"credsStore": "desktop"`, and `docker-credential-desktop` lives in
Docker.app's bundle and is **not on PATH**. Without it the build dies with:

```
failed to solve: error getting credentials - err: exec:
"docker-credential-desktop": executable file not found in $PATH
```

Measured 2026-09-01 during this project's own deploy.

🔴 **A recreate DESTROYS `docker logs` history.** Measured the same session: a
turn failure timestamped `2026-09-02T04:34:27Z` was readable beforehand; after
`docker compose up -d --build` the oldest line was `2026-09-02T05:02:17Z`, the
new boot. The 04:34 line was gone.

**So capture any log evidence you still need BEFORE you rebuild.** If you are
diagnosing a failure and the fix is a rebuild, you are about to delete the
evidence for the thing you are fixing.

### Proving what is actually running

A boot line is **not** proof of which build you are on if older builds print it
too. Find a string that exists **only** in the commit you are checking:

```bash
/usr/local/bin/docker exec jedd-v2 grep -c "<string unique to your commit>" /app/src/<file>.ts
```

And include a control, or a `0` is indistinguishable from a typo'd path:

```bash
/usr/local/bin/docker exec jedd-v2 grep -c "BREVITY IS THE FIRST RULE" /app/src/agent.ts   # -> 1
```

This is not hypothetical: on 2026-09-01 a deploy was verified with the boot
line `inbound images ON: …`, which **all five commits on that branch emit**. It
could not distinguish the shipped build from the one that still contained a
sentence telling users something false. The unique-string check is what caught
it.

---

## 2. Before you change anything

**The checkout is shared with other agents.** Assume someone else is editing
right now.

- **Commit before you do anything destructive** (mutation sweeps, refactors).
  A dirty tree is the one state nobody else can reason about.
- **Never** `git checkout .`, `git stash`, `git clean -f`, or `reset --hard`.
  Those have destroyed another worker's uncommitted edits here before.
- Stage files **by name**. `git add -A` will sweep in work that is not yours —
  there is routinely an untracked `scripts/daily-issue-sweep.sh` and similar in
  the tree.
- Work on a feature branch. `main` is what ships.

**Read the identifier you report.** `git commit | tail -3` cuts the line
carrying the sha; use `git rev-parse HEAD`. On 2026-09-01 a report named a sha
that did not exist, caught only by `git cat-file -t <sha>` returning
`Not a valid object name`.

---

## 3. The test discipline that is actually enforced

```bash
npm test          # every test/*.test.ts — no network needed
npm run typecheck # tsc --noEmit
```

**Run both.** Green tests with a red typecheck is a real state, and `npm test`
will not tell you about it.

### A guard you have never seen fail is not verified

The bar here is that every guard is **shown able to go red**. There is a
harness for it — use it instead of hand-rolling a loop:

```bash
scripts/mutation-sweep.sh src/thing.ts test/thing.test.ts <<'CASES'
name of the mutation
<<<FROM<<<exact single line to replace>>>TO<<<replacement>>>END
CASES
```

🔴 **Use the harness even though an ad-hoc `perl -pi` loop looks equivalent.**
It is not. A search string that fails to apply leaves the suite green, which is
**indistinguishable from the mutation being caught** — so an ad-hoc sweep
inflates its own score in the one direction nobody audits. The harness header
records this measured at **3 of 6 in one sweep, from whitespace alone**. It
asserts `applied == intended` and refuses to call a sweep valid otherwise. It
also restores the file on any exit, and refuses to start on a dirty tree.

`FROM`/`TO` are single-line; use `\n` for a newline. Pick the shortest *unique*
line — replacement hits the first occurrence.

### Fakes must be stateful, and reads must see your writes

A fake that answers reads from a source your writes do not update **cannot test
a write** — it will pass whether or not the write happened.

Seams to inject at rather than mocking globals:

- `FetchImpl` (`src/bluebubbles/client.ts:8`) — lets a test assert on the exact
  request, including that a refused operation produced **no request at all**.
  A guard that still made the call is invisible in a return value.
- `ExecImpl` (`src/tools/types.ts:21`) for shelling out.

Prefer a real `Response` over a hand-rolled `{ arrayBuffer }` object when the
code under test reads a body stream — otherwise every test silently takes a
fallback path and the streaming path production uses never executes. See
`test/attachments.test.ts` (the `response()` helper and the ceiling test that
builds a genuine `ReadableStream` with `highWaterMark: 0`).

### Assert the CONTROL

A test that proves an absence needs a companion proving the check *could* have
seen a presence. The tree is full of these, e.g.
`test/add-season-tool.test.ts:464` — `'CONTROL: the fake was actually
exercised'` — and `test/agent-boundary.test.ts:62`, a failing control that runs
the identical request as the owner.

### Test config points at nowhere ON PURPOSE

`test/helpers.ts` sets ssh hosts to `*.invalid` (RFC 2606, can never resolve).
The comment there records why: a test whose exec seam had a hole fell through
to the real `execFile` and **restarted sonarr on the real homelab**. Do not
"tidy" those to real hostnames.

---

## 4. The BlueBubbles seam

All of the following was measured against the live server on 2026-09-01 and
cross-read against the TypeScript sources shipped inside
`/Applications/BlueBubbles.app/Contents/Resources/app.asar` (extract with
`npx asar extract`; the full TS is under `src/server/`). Fuller writeup:
`~/.superbot2/spaces/jedd-v2/knowledge/inbound-images-measured-2026-09-01.md`.

### 🔴 `:1234` is Jedd. `:1235` is Jeff's personal account.

Both use the literal default password `password` and expose an identical API,
so a copy-pasted `.env` connects **successfully** to the wrong identity and
Jedd texts from the wrong person. Nothing about that failure looks like an
error. That is why `client.assertIdentity()` (called at `src/main.ts:111`)
reads `detected_imessage` off the server at boot and refuses to start on a
mismatch — and why the self-address loop guard compares against **the server's**
account rather than a value from config.

**Jedd (`:1234`) is iMessage-only.** Measured: all 200 most recent messages and
all 68 chats report `service: "iMessage"` — zero SMS. Rules about
MMS-over-SMS attachment loss belong to `:1235`, which also bridges forwarded
SMS. Do not carry them over; a corrected build had already shipped a sentence
telling users their photo "was sent as a text/SMS", which that account cannot
produce.

### The webhook payload is not the shape the API docs suggest

`Server.handleNewMessage` serialises **twice**. The rich copy goes to the socket
server and never reaches a webhook. Webhooks get the
`isForNotification: true` copy, which **strips six attachment fields**:
`transferState`, `isOutgoing`, `hideAttachment`, `isSticker`, `originalGuid`,
`hasLivePhoto`.

⚠️ So a readiness guard on `transferState` silently evaluates `undefined`
forever. `/message/query` *does* return those fields, which is how you talk
yourself into the wrong shape.

Webhook dispatch is fire-and-forget: not awaited, no retry, no timeout, no
signature. At-most-once.

### Attachment gotchas

| fact | consequence |
|---|---|
| An attachment-only message has `text: ""` — never U+FFFC (the server's `sanitizeStr` strips it before serialisation) | You cannot detect "has an attachment" from `text`. Use `attachments.length`. This one line in `payload.ts` silently dropped every inbound photo until 2026-09-01. |
| `?width=1024` makes the server transcode HEIC → PNG via `sips` | **No libheif is needed in the container.** Never `original=true` — that returns raw HEIC nothing downstream decodes. |
| `totalBytes` under-reports the download by **~49%** (3,631,404 declared → 5,409,496 delivered) | A ceiling on `totalBytes` alone admits a file half again over it *while looking like it checked*. Count bytes off the wire. |
| An unknown guid returns **500**, not 404 (a null-deref in BB's own route, because `force` defaults true and the private API is on) | Do not build a taxonomy on their status codes. Classify on your own attempt. |
| An empty `attachments: []` is byte-identical to a plain text message | Nothing says an attachment was *intended*. Any "your photo didn't arrive" line derived from an empty array fires on every text ever sent. |

---

## 5. The model, and the loop

- `num_ctx: 16384` is deliberate — it keeps the model **fully resident in
  VRAM**. Raising it to buy headroom is what produces 110-second turns. The
  reasoning is written out in `src/llm.ts`.
- **`tool_choice` is silently ignored** on this stack. The loop cannot compel a
  call and must tolerate a turn that answers without one. Sending it would imply
  a guarantee that does not exist.
- One model call is capped at **900s** (`TURN_TIMEOUT_MS`), and a turn makes up
  to `MAX_STEPS` of them — the worst case is the product, not that number.
  `presence.ts` derives the typing-indicator ceiling from the same constant on
  purpose, so they cannot drift apart.
- History images are bounded per **request**, not per turn — see
  `buildRequestMessages` in `src/llm.ts`. An image left in history is re-sent on
  every later call, and the failure mode is not an error: Ollama truncates from
  the front and Jedd appears to *forget the conversation*.

### Untrusted text, and where it lands

`ctx.userTurns` is the provenance evidence for `appearsInOwnTurns`
(`src/kindle.ts`), which is the **only** gate on storing a Kindle address and on
minting a Jellyfin invite. It must contain only what the person actually typed.

🔴 **Moving machine-composed text out of a `user` turn into a `system` note
makes injection WORSE, not better** — `system` is the highest-trust role. A
sender-chosen filename reached one in this repo. Sanitise at the boundary *into*
the privileged role (`safeLabel`, `src/bluebubbles/attachments.ts`), and do not
let that boundary depend on its caller having remembered.

---

## 6. Things that look correct and are not

- **`cmd && echo "clean"`** tests the exit code, not your condition.
  `git status` exits 0 when the tree is dirty. Assert on the string:
  `[ -z "$(git status --porcelain)" ]`.
- **🔴 NEVER WRITE A TEST COUNT DOWN. Assert on the outcome — `fail 0`, exit
  code — never on a number.** This repo carried **five** different counts
  (1218, 1286, 1411, 1425, 1501) across the README, the Dockerfile and
  `scripts/weekly-fix-sweep.sh`, disagreeing with each other and with reality.
  All were removed 2026-09-01; if you find you have written a new one, that is
  this trap refiring.

  The reason it earns a 🔴 rather than a shrug is where one of them ended up.
  `scripts/weekly-fix-sweep.sh` told the autonomous weekly-fix agent *"If npm
  test does not pass at 1411/1411, output TESTS_FAILED instead of any PR URL"* —
  and **that line is a prompt to an LLM, not a shell conditional.** So it did
  not fail cleanly and always. It failed **indeterminately**: one run may read
  `1411/1411` literally against a 1501 suite and refuse to open a PR, the next
  may read it as "the suite must be green" and proceed. A gate that fails at
  random is worse than one that is reliably dead, because nothing in its output
  tells the two apart, so it cannot be diagnosed from its own logs.

  ⚠️ **A number is a dated fact. Writing one into an instruction turns it into a
  rule that expires without telling anyone.**
- **Backticks inside a double-quoted shell string** are command substitution and
  will eat your text. Build prose in a quoted heredoc.
- **A green test on a file you never `git add`ed** ships nothing. `git add -u`
  skips new files.
- **"The container is healthy"** says the process started, not that it is your
  code (§1) and not that the machine underneath is well. On 2026-09-01 twenty
  orphaned busy-loops from an unrelated test had the Mac at **load 148** with
  swap exhausted; BlueBubbles took 19s to answer `server/info` and Jedd's turns
  failed in ways that looked like application bugs. Check host load before
  believing a timeout is yours.

---

## 7. What I am not sure of

Stated plainly so you know which lines to trust:

- **I did not exercise the release/tagging flow** in README "Cutting a
  release". I only read it.
- **The `worthAnswering` skip list** (`src/bluebubbles/attachments.ts`) drops
  captionless non-image attachments. I verified voice memos and contact-card
  types by classification, **not** by sending real ones through iMessage.
- **Group chats are unsupported** and I did not test them. `chatGuidFor` is 1:1
  only; a message from a group is answered as a stray DM to the sender.
- **Outbound image sending is not implemented.** Inbound only.
- Everything in §4 is measured, but against **one** server on **one** day. If
  BlueBubbles is upgraded past 1.9.9, re-measure rather than trusting the table.
