#!/usr/bin/env node
/**
 * Poke Messages.app so it never idles past the typing-indicator boundary.
 *
 * 🔴 REFUTED AS A REMEDY, 2026-08-26, the same day it was built. Matched pair
 * on the production path: poke ON, 10m50s gap, 6/6 firings confirmed → no
 * indicator; a 30s-gap message minutes later, same poke state → indicator.
 * The gap is the variable; this poke is not. Messages answered the Apple
 * event in 108ms after 43 poke-free minutes, so the scripting surface was
 * never the dormant component. Kept ONLY because the log labels idle gaps.
 * Do not re-derive this as a fix. Full record:
 * spaces/jedd-v2/knowledge/messages-poke-workaround.md.
 *
 * WHY THIS EXISTS — upstream bluebubbles-server issue #750 (open since
 * 2025-06-24, reproduced by a third party on macOS 15.7.5, our exact version):
 * after ~10–15 minutes of complete inactivity Messages.app stops delivering
 * outbound typing indicators until it is poked. `caffeinate` does not help —
 * it is Messages.app itself that idles, not the machine. Our own measured
 * boundary is tighter: every labelled success had an idle gap ≤ 20s, every
 * labelled failure ≥ 5m31s (12 points, monotonic, zero inversions,
 * 2026-08-25/26). The keepalive PR (#805) was rejected upstream, so there is
 * no version to upgrade to. The only remedy anyone reports working in the
 * field is exactly this: an AppleScript `count of chats` on a timer.
 *
 * WHY NODE AND NOT A BASH WRAPPER — TCC. Under launchd the job's root process
 * is the responsible process for the whole tree, and Automation grants are
 * per (responsible binary → target app). This nvm node binary already holds
 * an Automation grant for com.apple.MobileSMS (auth_value=2 in TCC.db since
 * 2026-03-09, earned by the v1 bridge); /bin/bash and tmux hold none — a
 * tmux-launched `osascript` poke was measured to hang 120s and die with
 * AppleEvent -1712, writing a fresh denial row for tmux. Run this script
 * under launchd with that node binary and the osascript child inherits the
 * grant. Do NOT "simplify" the plist to run osascript or a shell directly:
 * it will prompt, or silently time out, depending on session state.
 *
 * WHY THE 25s APPLESCRIPT TIMEOUT — the default AppleEvent timeout is 120s,
 * which is longer than the 120s poke interval; a wedged Messages would
 * stack overlapping pokes. 25s makes a dead Messages a fast, visible FAIL
 * line instead.
 *
 * The log is append-only, one line per run, and every line carries the
 * outcome — a run that errors is visibly different from a run that worked,
 * so a silent-failure poke cannot masquerade as coverage (every zero needs
 * a control).
 */
import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const LOG = '/Users/jeff/dev/jedd-v2/data/messages-poke.log';

// Local time with offset, so lines correlate with Jeff's reports and
// events.log without UTC arithmetic (Heroku-vs-Sentry taught that lesson).
function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.abs(off) / 60 | 0)}${p(Math.abs(off) % 60)}`
  );
}

const t0 = Date.now();
const script = 'with timeout of 25 seconds\ntell application "Messages" to count of chats\nend timeout';

execFile('/usr/bin/osascript', ['-e', script], { timeout: 30_000 }, (err, stdout, stderr) => {
  const ms = Date.now() - t0;
  const line = err
    ? `${stamp()} FAIL ${ms}ms ${(stderr || err.message || '').trim().slice(0, 200)}\n`
    : `${stamp()} ok ${ms}ms chats=${stdout.trim()}\n`;
  appendFileSync(LOG, line);
  process.exit(err ? 1 : 0);
});
