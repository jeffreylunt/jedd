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
      /**
       * 🔴 PINNED ABSOLUTE ON PURPOSE — do NOT relax this back to bare 'node'.
       *
       * macOS Local Network privacy denies LAN-PEER access PER BINARY, and the
       * denial presents as EHOSTUNREACH with no prompt and nothing in any log.
       * Measured 2026-08-25, same machine, same minute, literal IP (no DNS):
       *
       *   /opt/homebrew/bin/node        v25.2.1   192.168.1.7:8096 -> CONNECT ok
       *   ~/.nvm/.../v24.12.0/bin/node  v24.12.0  192.168.1.7:8096 -> EHOSTUNREACH
       *   ~/.nvm/.../v22.22.2/bin/node  v22.22.2  192.168.1.7:8096 -> EHOSTUNREACH
       *
       * CONTROLS that make it a permission boundary rather than a routing or
       * library fault: all three reach the public internet fine, and all three
       * reach the GATEWAY 192.168.1.1 — the gateway is EXEMPT, so "the router
       * works" is not evidence the LAN works. Re-signing an nvm node with a
       * fresh unique ad-hoc identity did NOT clear it, so it is not a stale
       * grant keyed to Node Foundation's signing identity.
       *
       * Jedd ran on the nvm v24 build until 2026-08-25, which made EVERY
       * direct-fetch homelab read fail while curl and ssh from the same machine
       * succeeded — a total, binary-specific outage that looked intermittent and
       * service-specific for days.
       *
       * ⚠️ BEFORE changing node versions, probe the CANDIDATE binary first:
       *   <candidate> -e 'require("net").connect(8096,"192.168.1.7")
       *      .on("connect",()=>console.log("ok")).on("error",e=>console.log(e.code))'
       * A version bump that silently loses LAN access is invisible until a user
       * asks Jedd something about the homelab.
       */
      interpreter: '/opt/homebrew/bin/node',
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
