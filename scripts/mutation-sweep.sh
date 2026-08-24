#!/bin/bash
#
# Mutation sweep harness.
#
# ── 🔴 WHY THIS EXISTS RATHER THAN AN AD-HOC SCRIPT PER SWEEP ────────────────
#
# Hand-written search strings fail to apply CONSTANTLY — measured at 3 of 6 in
# one sweep here, from whitespace alone. **A mutation that never applied is
# indistinguishable from one that was caught**: both leave the suite green. So an
# ad-hoc sweep silently inflates its own score, and it inflates it in the one
# direction nobody audits.
#
# Two requirements follow, and this harness enforces both:
#   1. print DIDNOTAPPLY explicitly, never let a bad string read as a pass;
#   2. ASSERT applied-count == intended-count at the end. "All caught" is not a
#      claim until you know how many actually ran.
#
# It also restores the file on ANY exit. A sweep that dies mid-mutation leaves a
# guard DELETED in the working tree — that has happened twice in this project,
# once costing an uncommitted test seam and a test that restarted sonarr on hp.
# The trap limits the damage; **committing before the sweep is what makes it
# free**, and this refuses to start on a dirty tree for that reason.
#
# Usage:
#   scripts/mutation-sweep.sh <source-file> <test-file> <<'CASES'
#   name of the mutation
#   <<<FROM<<<literal text to replace>>>TO<<<replacement>>>END
#   CASES

set -uo pipefail
SRC="${1:?usage: mutation-sweep.sh <source-file> <test-file>}"
TESTS="${2:?usage: mutation-sweep.sh <source-file> <test-file>}"
cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain "$SRC")" ]; then
  echo "REFUSING: $SRC has uncommitted changes. Commit before sweeping — that is what makes a" >&2
  echo "          mid-sweep death free rather than destructive." >&2
  exit 2
fi

trap 'git checkout -- "$SRC" 2>/dev/null; echo "[trap] restored $SRC"' EXIT INT TERM

INTENDED=0; APPLIED=0; CAUGHT=0; SURVIVED=0; NOTAPPLIED=0

while IFS= read -r line; do
  [ -z "$line" ] && continue
  name="$line"
  IFS= read -r spec || break
  from="${spec#*<<<FROM<<<}"; from="${from%%>>>TO<<<*}"
  to="${spec#*>>>TO<<<}";     to="${to%%>>>END*}"
  INTENDED=$((INTENDED+1))

  if ! FROM="$from" TO="$to" python3 -c '
import os,sys
p=sys.argv[1]; f=os.environ["FROM"]; t=os.environ["TO"]
s=open(p).read()
if f not in s: sys.exit(9)
open(p,"w").write(s.replace(f,t,1))
' "$SRC"; then
    echo "DIDNOTAPPLY  $name"
    NOTAPPLIED=$((NOTAPPLIED+1))
    git checkout -- "$SRC"
    continue
  fi
  APPLIED=$((APPLIED+1))
  if timeout 120 npx tsx --test --test-timeout=5000 "$TESTS" >/dev/null 2>&1; then
    echo "❌ SURVIVED   $name"; SURVIVED=$((SURVIVED+1))
  else
    echo "✅ caught     $name"; CAUGHT=$((CAUGHT+1))
  fi
  git checkout -- "$SRC"
done

echo
echo "intended=$INTENDED applied=$APPLIED caught=$CAUGHT survived=$SURVIVED not-applied=$NOTAPPLIED"
if [ "$APPLIED" -ne "$INTENDED" ]; then
  echo "🔴 SWEEP INVALID: $NOTAPPLIED mutation(s) never applied, so the score is not a claim about"
  echo "   the code. Fix the search strings and re-run before quoting a result."
  exit 1
fi
if [ "$SURVIVED" -ne 0 ]; then
  echo "🔴 $SURVIVED mutation(s) SURVIVED — those tests do not pin what they claim to."
  exit 1
fi
echo "✅ sweep valid: every intended mutation applied, and every applied mutation was caught."
