#!/usr/bin/env bash
# weekly-fix-sweep.sh — once a week, take all open issues on the repo,
# try to fix each with the weekly-fixer agent (MiniMax M3 hosted),
# and open a PR (ready-for-merge, not draft) per fix. Auto-merges PRs
# whose checks pass.
#
# Runs on .68 (where opencode + gh + the repo checkout live).
# Sequential per issue. Per-issue branch (auto-fix/issue-N-slug) so
# concurrent runs and partial failures don't fight each other.
#
# SAFETY:
#   - per-issue branch off main; never touches main directly
#   - npm test must pass (1411/1411) before any push
#   - per-issue 30-minute hard cap on the agent invocation
#   - whole-script 6-hour hard cap
#   - skips issues that already have an open PR (avoids stacking)
#   - if the agent returns TESTS_FAILED, no commit, no push, comment on the issue

set -u

REPO=jeffreylunt/jedd
LOGDIR=~/dev/jedd-v2/data
LOG="$LOGDIR/weekly-fix.log"
STATE="$LOGDIR/weekly-fix-state.jsonl"   # one line per PR filed
LOCKDIR=/tmp/jedd-weekly-fix.lock
REPO_DIR=~/dev/jedd-v2

# --dry-run — list what would be processed, then stop
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1
# --issue N — process just one issue (for manual testing)
ONLY_ISSUE=""
for arg in "$@"; do
  case "$arg" in
    --issue) shift; ONLY_ISSUE="${1:-}" ;;
  esac
done

# 6-hour hard wall-clock limit (backstop)
MAX_DURATION_SECONDS=21600
( sleep "$MAX_DURATION_SECONDS" && kill -TERM $$ 2>/dev/null ) &
WATCHER_PID=$!
trap 'kill "$WATCHER_PID" 2>/dev/null' EXIT

# Per-issue 30-minute cap inside opencode
AGENT_TIMEOUT_SECONDS=1800

acquire_lock() {
  for _ in 1 2 3 4 5; do
    if mkdir "$LOCKDIR" 2>/dev/null; then echo $$ > "$LOCKDIR/pid"; return 0; fi
    if [[ -f "$LOCKDIR/pid" ]]; then
      local h; h=$(cat "$LOCKDIR/pid" 2>/dev/null || echo "")
      if [[ -n "$h" ]] && kill -0 "$h" 2>/dev/null; then return 1; fi
      rmdir "$LOCKDIR" 2>/dev/null || true
    fi
    sleep 1
  done
  return 1
}
if ! acquire_lock; then echo "previous fix sweep still running, exiting" >&2; exit 0; fi

# All git operations below must run from inside the repo checkout.
cd "$REPO_DIR" || { echo "could not cd to $REPO_DIR" >&2; exit 1; }

mkdir -p "$LOGDIR"
ts=$(date +%Y%m%d-%H%M%S)
exec >>"$LOG" 2>&1
echo "=== weekly-fix @ $(date -u +%FT%TZ) ==="

# ── 1. Gather issues to process ─────────────────────────────────────────
if [[ -n "$ONLY_ISSUE" ]]; then
  ISSUES_JSON="[{\"number\":${ONLY_ISSUE}}]"
  echo "manual mode: only issue #${ONLY_ISSUE}"
else
  echo "fetching open issues from $REPO..."
  ISSUES_JSON=$(gh issue list --repo "$REPO" --state open --json number,title,labels,body --limit 50 2>&1)
fi

# Filter out issues that already have an open PR (avoid stacking on the same fix)
ISSUE_NUMBERS=$(echo "$ISSUES_JSON" | python3 -c "
import json, sys
try:
  issues = json.loads(sys.stdin.read())
except Exception:
  print('[]'); sys.exit()
nums = []
for i in issues:
  n = i.get('number')
  if not n: continue
  nums.append(n)
print(json.dumps(nums))
")

[[ -z "$ISSUE_NUMBERS" || "$ISSUE_NUMBERS" == "[]" ]] && echo "no issues to process"

# For each candidate, check whether there's already an open PR mentioning Closes #N
declare -a TO_PROCESS
for n in $(echo "$ISSUE_NUMBERS" | python3 -c "import json,sys; print(' '.join(str(x) for x in json.loads(sys.stdin.read())))"); do
  existing=$(gh pr list --repo "$REPO" --state open --search "Closes #$n in:body" --json number 2>/dev/null | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(len(d))" 2>/dev/null)
  if [[ "$existing" == "0" ]]; then
    TO_PROCESS+=("$n")
  else
    echo "skip #$n — already has $existing open PR(s)"
  fi
done

if [[ "${#TO_PROCESS[@]}" -eq 0 ]]; then
  echo "nothing new to fix"
fi

echo "will process ${#TO_PROCESS[@]:-0} issue(s): ${TO_PROCESS[*]:-}"
[[ "$DRY_RUN" == "1" ]] && { echo "dry-run, exiting"; exit 0; }

# Make sure auto-fix label exists
gh label create "auto-fix" --repo "$REPO" --color "0e8a16" --description "Auto-PR filed by weekly-fix-sweep" >/dev/null 2>&1 || true

# ── 2. For each issue: branch + run agent + push + PR + merge ──────────
if [[ "${#TO_PROCESS[@]:-0}" -gt 0 ]]; then
for n in "${TO_PROCESS[@]:-}"; do
  echo ""
  echo "── issue #$n ──"

  # Title for branch slug
  TITLE=$(gh issue view "$n" --repo "$REPO" --json title --jq '.title' 2>/dev/null | head -1)
  if [[ -z "$TITLE" ]]; then echo "  could not read title, skipping"; continue; fi
  SLUG=$(printf '%s' "$TITLE" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g; s/^-+//; s/-+$//' | cut -c1-40)
  BRANCH="auto-fix/issue-${n}-${SLUG:-fix}"

  # Pre-flight: is the branch already in flight?
  if git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
    echo "  branch $BRANCH already exists locally, skipping (in flight or stuck)"
    continue
  fi
  if git ls-remote --heads origin "$BRANCH" 2>/dev/null | grep -q .; then
    echo "  branch $BRANCH already on origin, skipping"
    continue
  fi

  # Fetch fresh main and branch off
  git fetch origin main 2>&1 | tail -2
  git checkout main 2>&1 | tail -1
  git checkout -b "$BRANCH" origin/main 2>&1 | tail -1

  # Run the agent with the per-issue timeout
  echo "  running agent for #$n..."
  PROMPT="GitHub issue #${n}: ${TITLE}

Read the issue: gh issue view ${n} --repo ${REPO}
Then fix it in this branch (\$BRANCH), commit, push, open a PR, and output the PR URL on the last line.

If npm test does not pass at 1411/1411, output the literal line TESTS_FAILED instead of any PR URL.

Issue body:
"
  PROMPT+=$(gh issue view "$n" --repo "$REPO" --json body --jq '.body' 2>/dev/null)
  
  AGENT_OUTPUT=$(HOME=/Users/jeff perl -e '
    $SIG{ALRM} = sub { kill INT => -$$; die "agent timed out\n" };
    alarm shift @ARGV; exec @ARGV;
  ' "$AGENT_TIMEOUT_SECONDS" opencode run \
    --model minimax/MiniMax-M3 \
    --agent weekly-fixer \
    --format default \
    --thinking false \
    "$PROMPT" 2>&1)
  AGENT_RC=$?
  echo "  agent exit=$AGENT_RC"

  # Extract the first non-empty line (the agent's verdict) and the last
  # non-empty line (PR URL on success).
  FIRST_LINE=$(echo "$AGENT_OUTPUT" | grep -v '^[[:space:]]*$' | head -1 | tr -d '[:space:]')
  LAST_LINE=$(echo "$AGENT_OUTPUT" | grep -v '^$' | tail -1 | tr -d '[:space:]')
  echo "  agent verdict: $FIRST_LINE"

  case "$FIRST_LINE" in
    IN_SCOPE)
      # The remaining text is the PR URL on the last line.
      if [[ "$LAST_LINE" != https://github.com/* ]]; then
        echo "  IN_SCOPE verdict but no PR URL on last line (got: '${LAST_LINE:0:80}'). skipping."
        gh issue comment "$n" --repo "$REPO" --body "🤖 weekly-fix-sweep agent returned IN_SCOPE but the output ended without a PR URL. The attempt log is in the run log on the host." 2>&1 | head -1
        git checkout main 2>&1 | tail -1
        git branch -D "$BRANCH" 2>/dev/null
        continue
      fi
      PR_URL="$LAST_LINE"
      ;;
    TESTS_FAILED|RISKY_REVIEW|OUT_OF_SCOPE)
      # The remaining text is a 2-3 sentence note explaining why. Post it as
      # a comment on the issue and skip the PR.
      NOTE=$(echo "$AGENT_OUTPUT" | grep -v '^[[:space:]]*$' | sed -n '2,$p')
      case "$FIRST_LINE" in
        TESTS_FAILED)   HEADER="🤖 weekly-fix-sweep attempted a fix but \`npm test\` did not pass at 1425/1425. No PR opened." ;;
        RISKY_REVIEW)   HEADER="🤖 weekly-fix-sweep declined to auto-fix: change is in scope but too risky for an unattended PR." ;;
        OUT_OF_SCOPE)   HEADER="🤖 weekly-fix-sweep declined to auto-fix: change appears out of scope for jedd-v2." ;;
      esac
      COMMENT_BODY="$HEADER

$NOTE"
      gh issue comment "$n" --repo "$REPO" --body "$COMMENT_BODY" 2>&1 | head -1
      git checkout main 2>&1 | tail -1
      git branch -D "$BRANCH" 2>/dev/null
      continue
      ;;
    *)
      echo "  unknown verdict from agent (got: '${FIRST_LINE:0:80}'). skipping."
      gh issue comment "$n" --repo "$REPO" --body "🤖 weekly-fix-sweep could not parse the agent verdict. The attempt log is in the run log on the host." 2>&1 | head -1
      git checkout main 2>&1 | tail -1
      git branch -D "$BRANCH" 2>/dev/null
      continue
      ;;
  esac

  echo "  PR: $PR_URL"

  # Try auto-merge
  PR_NUMBER=$(echo "$PR_URL" | grep -oE '/pull/[0-9]+' | grep -oE '[0-9]+')
  if [[ -n "$PR_NUMBER" ]]; then
    echo "  attempting auto-merge on PR #$PR_NUMBER..."
    if gh pr merge "$PR_NUMBER" --repo "$REPO" --auto --squash 2>&1 | head -3; then
      echo "  auto-merge ENABLED for PR #$PR_NUMBER"
    else
      echo "  auto-merge not enabled (checks may be required or branch policy blocks); leaving PR open for manual merge"
    fi
  fi

  # Log to state
  printf '%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$n" "$BRANCH" "$PR_URL" >> "$STATE"

  # Back to main
  git checkout main 2>&1 | tail -1
done

# Cleanup: drop any leftover local auto-fix branches
for b in $(git branch --list 'auto-fix/*' 2>/dev/null); do
  echo "  cleanup local branch: $b"
  git branch -D "$b" 2>/dev/null
done
fi  # close: "if [[ TO_PROCESS is non-empty ]]"

# ── 5. Release cut: if zero open issues remain, rebuild + restart image ──

echo ""
echo "weekly-fix sweep complete"

# ── 5. Release cut: if zero open issues remain, rebuild + restart image ──
OPEN_REMAINING=$(gh issue list --repo "$REPO" --state open --json number 2>/dev/null | python3 -c "
import json, sys
try: print(len(json.loads(sys.stdin.read())))
except Exception: print('?')
" 2>/dev/null)
echo "open issues remaining after sweep: $OPEN_REMAINING"

if [[ "$OPEN_REMAINING" == "0" && -z "${SKIP_RELEASE:-}" ]]; then
  echo ""
  echo "── release cut (no open issues remain) ──"
  cd "$REPO_DIR"

  # Count commits since the last tag, for the log
  LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "(none)")
  NEW_COMMITS=$(git rev-list --count "${LAST_TAG}..main" 2>/dev/null || echo "?")
  echo "commits since last tag (${LAST_TAG}): ${NEW_COMMITS}"

  echo "rebuilding image..."
  if ! docker compose build 2>&1 | tail -5; then
    echo "BUILD FAILED — skipping restart"
  else
    echo "restarting container with new image..."
    if docker compose up -d 2>&1 | tail -5; then
      sleep 3
      HEALTH=$(docker inspect --format '{{.State.Health.Status}}' jedd-v2 2>/dev/null || echo "?")
      echo "container health after restart: $HEALTH"
      echo "RELEASE: image rebuilt and container running on it"
    else
      echo "RESTART FAILED — image is built but container may be down"
    fi
  fi
else
  echo "skipping release cut: $OPEN_REMAINING open issue(s) still exist (or SKIP_RELEASE is set)"
fi
