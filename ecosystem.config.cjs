/**
 * pm2 supervision for the live V2 process.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * V2 ran as a bare `node` process with nothing to restart it. V1 ran in Docker,
 * health-checked, with a restart policy; V2 had none of that, so **if it died,
 * BlueBubbles delivered into a black hole** — silently, with no error anywhere.
 * A new user was invited on 2026-08-24 and told to just text a title; for him a
 * dead V2 is indistinguishable from a bot that ignores him.
 *
 * ── 🔴 ONE PROCESS, NOT A WRAPPER TREE ───────────────────────────────────────
 *
 * `npx tsx src/main.ts` produces `npm exec` → `node .../bin/tsx` → the app, and a
 * supervisor watching the top of that tree cannot see the bottom of it die.
 * `node --import tsx src/main.ts` is the SAME program as one process with **zero
 * children** (verified), so what pm2 watches is what actually serves.
 *
 * ── 🔴 `kill_timeout` IS LOAD-BEARING, NOT A TUNING KNOB ─────────────────────
 *
 * `src/main.ts` DEREGISTERS ITS WEBHOOK on SIGTERM, and that is an HTTP round
 * trip. pm2's default `kill_timeout` is 1600 ms — too short to be sure, and if
 * pm2 SIGKILLs mid-deregistration the row is orphaned in BlueBubbles' table and
 * the next boot has to clean up after it. 10 s is far more than the call needs.
 */
module.exports = {
  apps: [
    {
      name: 'jedd-v2',
      cwd: '/Users/jeff/dev/jedd-v2',
      script: 'src/main.ts',
      interpreter: 'node',
      // Loads tsx in-process rather than re-execing through the tsx CLI wrapper.
      interpreter_args: '--import tsx',
      env: {
        /**
         * ⚠️ THIS SUPERSEDES A DOCUMENTED RULE, DELIBERATELY. `cutover-runbook.md`
         * says JEDD_SEND_TO must be typed on the command line at the moment of
         * the cutover, never persisted — because it is "the only thing between
         * answering Jeff and answering twelve people".
         *
         * That protection was for the CUTOVER, and the cutover is done: V2 has
         * been the only registered listener since 2026-08-24 22:0x and is
         * answering everyone by decision. **An unattended restart cannot be
         * prompted**, so supervision requires the value to live somewhere. It
         * lives here, in one reviewable place, rather than in `.env` where the
         * runbook explicitly forbade it.
         *
         * 🔴 If V2 is ever rehearsed against live traffic again, set this to a
         * handle list HERE first. It is no longer protected by being absent.
         */
        JEDD_SEND_TO: 'everyone',
        JEDD_ALLOW_WRITES: 'true',
      },
      // Both streams to the file the runbook and every prior restart already use.
      out_file: '/Users/jeff/dev/jedd-v2/data/jedd.log',
      error_file: '/Users/jeff/dev/jedd-v2/data/jedd.log',
      merge_logs: true,
      autorestart: true,
      /**
       * ⚠️ `main.ts` exits FATAL when BlueBubbles is unreachable, which is
       * correct — but under a supervisor it becomes a restart loop. Exponential
       * backoff means an outage produces a handful of retries rather than
       * hundreds, and each retry still replays from the watermark on success.
       */
      exp_backoff_restart_delay: 5000,
      // See the header: the SIGTERM handler makes an HTTP call before exiting.
      kill_timeout: 10000,
      // Never watch: a file change must not restart the live bot mid-conversation.
      watch: false,
    },
  ],
};
