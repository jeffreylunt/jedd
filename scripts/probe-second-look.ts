/**
 * Exercise the second look against the LIVE model, on the turn that produced
 * the bug.
 *
 *   npx tsx scripts/probe-second-look.ts [reps]
 *
 * ── 🔴 WHY THIS EXISTS AND WHY A UNIT TEST IS NOT ENOUGH ────────────────────
 *
 * Everything in `test/second-look.test.ts` drives a SCRIPTED model: it proves
 * the loop does the right thing when the model denies, and nothing whatsoever
 * about whether the real model, holding the real registry, actually reaches a
 * different tool when it is asked to look again. Several fixes in this space
 * were "complete in code" and had never run end to end. This is the difference.
 *
 * ── 🔴 THE REGISTRY IS CHECKED AGAINST THE RUNNING CONTAINER, NOT ASSUMED ────
 *
 * The last measurement taken on this defect was invalidated because the harness
 * built its own registry and disagreed with production by three tools — a
 * reconstruction of production, quoted as production. The running process prints
 * its own tool list at boot, so that number is available and was never compared:
 *
 *   docker logs jedd-v2 2>&1 | grep '^\[jedd\] tools='
 *
 * `EXPECTED_TOOLS` below is that line, copied verbatim, and this script REFUSES
 * TO RUN if what it builds differs by even one name.
 *
 * ── ⚠️ WHAT IS DELIBERATELY NOT PRODUCTION, SO NOBODY QUOTES THIS AS AN A/B ──
 *
 *  - Every tool that declares `writes: true`, plus `hp_shell`, has its BODY
 *    replaced with a refusal. Names, descriptions and schemas — the entire
 *    surface tool selection sees — are untouched, so the thing being measured
 *    is unchanged. Reads run for real against the live homelab.
 *  - History starts EMPTY. The real 2026-08-28 turn followed an invite for the
 *    same person, so this is the harder case, not the identical one.
 *  - The control is WITHIN each run, not a second arm: when the guard fires,
 *    `deniedText` is exactly what the unguarded build would have sent and
 *    `replyText` is what this build sends. Same sample, both outcomes, so
 *    sampling variance cannot separate them.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../src/agent.js';
import { loadConfig } from '../src/config.js';
import { InviteLedger } from '../src/invite-ledger.js';
import { JfagoClient } from '../src/jfago.js';
import { OllamaClient } from '../src/llm.js';
import { buildTools } from '../src/tools/index.js';
import type { Tool } from '../src/tools/types.js';

/** `docker logs jedd-v2 | grep 'tools='`, verbatim, 2026-08-28. */
const EXPECTED_TOOLS =
  'library_search, homelab_read, catalogue_search, check_status, resolve_choice, search_audiobook, ' +
  'find_gaps, search_episode, sports_fixture, add_movie, add_series, add_season, grab_release, ' +
  'add_audiobook, jellyfin_sessions, livetv_status, diagnose_host_contention, docker_ps, ' +
  'docker_inspect, docker_logs, container_netns, channel_health, restart_container, ' +
  'restart_arr_stack, shed_host_load, restore_qbit_speed, indexer_admin, stuck_downloads, hp_shell, ' +
  'read_runbook, invite_to_jellyfin, send_ebook, search_ebook, save_kindle_email, kindle_status, ' +
  'whats_popular, title_details';

/** The exact question Jeff asked at 2026-08-28T23:15:17Z. */
const QUESTION = 'Has tom watched anything yet';
/**
 * A POSITIVE CONTROL, and it is doing real work rather than decoration: it is
 * the question Jedd answered CORRECTLY on 2026-08-26 via `homelab_read`. If it
 * fails here, the capability is broken in this harness and every denial below
 * would be TRUE — which would make the whole run meaningless rather than
 * negative.
 */
const CONTROL_QUESTION = 'Look at what Jeff has watched';

function stubWrites(tools: Tool[]): Tool[] {
  return tools.map((t) =>
    t.writes || t.name === 'hp_shell'
      ? {
          ...t,
          async run() {
            return { ok: false, content: `PROBE: "${t.name}" is stubbed. Nothing ran.` };
          },
        }
      : t,
  );
}

async function main(): Promise<void> {
  const reps = Number(process.argv[2] ?? 5);
  /**
   * 🔴 `readOnly: false` — AND THIS IS FIDELITY, NOT A SHORTCUT.
   *
   * `registerable()` drops every `writes: true` tool when writes are off, so a
   * read-only build offers 23 tools where the running container offers 37. The
   * defect under measurement is a SELECTION failure whose only serious rival
   * explanation is registry size, so measuring it at 23 tools would answer a
   * different question and quietly answer it wrong.
   *
   * This is caught rather than trusted: the registry check below compares what
   * is built against the running container's own boot banner and exits non-zero
   * on any difference. The first run of this script did exit — it was read-only,
   * 23 tools, and said so instead of measuring.
   *
   * Safe because every write tool's BODY is stubbed by `stubWrites` a few lines
   * on. The model sees all 37 and can pick any of them; only reads can act.
   */
  const config = { ...loadConfig(), readOnly: false };
  const jfagoDir = mkdtempSync(join(tmpdir(), 'jedd-probe-'));
  const tools = buildTools(config, { safe: true, reason: 'probe' } as never, {
    // Inert, but present — `buildTools` gates these tools on the deps existing,
    // and their absence would silently shrink the registry by five.
    invite: {
      jfago: new JfagoClient(config.jfago),
      ledger: new InviteLedger(join(jfagoDir, 'invites.jsonl')),
      send: async () => {
        throw new Error('probe cannot send');
      },
    },
    ebook: {
      send: async () => {
        throw new Error('probe cannot send');
      },
      onlySendTo: 'nobody@invalid',
    },
  });

  /**
   * 🔴 PREFLIGHT: CAN THIS BINARY REACH THE HOMELAB AT ALL?
   *
   * The first live run of this script produced five clean "did not fire"
   * results and they meant NOTHING. Every homelab read had failed with
   * EHOSTUNREACH, so every denial in the run was TRUE and correctly licensed —
   * a null result that looked exactly like a negative one.
   *
   * The cause is the macOS landmine the Dockerfile already documents: **"Local
   * Network" privacy denies LAN-peer access PER BINARY.** `curl` reached
   * Jellyfin in 18 ms from the same shell in the same minute, and
   * `/opt/homebrew/bin/node` returns 200 — while the nvm node on PATH gets
   * EHOSTUNREACH. `ecosystem.config.cjs` pins the Homebrew binary for exactly
   * this reason, and `npx` does not.
   *
   *   /opt/homebrew/bin/node --import tsx scripts/probe-second-look.ts
   *
   * ⚠️ A GREEN `curl` IS NOT EVIDENCE FOR THIS PROCESS. Reproduce in the
   * runtime that failed, or measure nothing and call it a finding.
   */
  const probe = await fetch(`${config.jellyfin.baseUrl}/System/Info/Public`, {
    signal: AbortSignal.timeout(8000),
  }).catch((e: unknown) => e as Error);
  if (probe instanceof Error) {
    console.error(
      `🔴 THIS PROCESS CANNOT REACH JELLYFIN (${(probe as { cause?: { code?: string } }).cause?.code ?? probe.message}).\n` +
        '   Every homelab read would fail, every denial would be TRUE, and the run would look\n' +
        '   like a clean negative. Refusing to measure.\n' +
        '   If curl works from the same shell, this is the macOS per-binary Local Network policy:\n' +
        '     /opt/homebrew/bin/node --import tsx scripts/probe-second-look.ts',
    );
    process.exit(1);
  }
  console.error(`[probe] homelab reachable from THIS binary: HTTP ${probe.status}`);

  const built = tools.map((t) => t.name).join(', ');
  if (built !== EXPECTED_TOOLS) {
    console.error('🔴 REGISTRY MISMATCH — this harness is not production. Refusing to measure.');
    console.error(`  running : ${EXPECTED_TOOLS}`);
    console.error(`  built   : ${built}`);
    process.exit(1);
  }
  console.error(`[probe] registry matches the running container exactly: ${tools.length} tools`);

  const llm = new OllamaClient(config);
  const runs: { q: string; label: string }[] = [
    { q: CONTROL_QUESTION, label: 'CONTROL' },
    ...Array.from({ length: reps }, () => ({ q: QUESTION, label: 'SUBJECT' })),
  ];

  /**
   * 🔴 ONE BAD TURN MUST NOT VOID THE RUN.
   *
   * A ten-rep run died on rep 0 and collected NOTHING: the model hit its
   * `num_predict` budget with reasoning alone (`done_reason=length`), `llm.ts`
   * threw as designed, and this loop had no handler — so twenty minutes of
   * queued model time produced a stack trace instead of nine perfectly good
   * data points. A measurement harness that is less fault-tolerant than the
   * production loop it measures will keep throwing away its own evidence.
   *
   * ⚠️ A THROWN REP IS RECORDED AS `errored`, NOT SILENTLY DROPPED. Dropping it
   * would quietly shrink the denominator, which is how a run of four reps
   * reports "4 of 4" while having attempted six.
   */
  let errored = 0;
  for (const [i, { q, label }] of runs.entries()) {
    // A FRESH Agent per rep: one mutable history array per sender, so reusing
    // one would let each rep read the previous rep's answer.
    const agent = new Agent(config, llm, undefined, stubWrites(tools));
    const startedAt = Date.now();
    const r = await agent.handle(config.ownerHandle, q).catch((e: unknown) => e as Error);
    const secs = ((Date.now() - startedAt) / 1000).toFixed(0);
    if (r instanceof Error) {
      errored++;
      console.error(`\n─── ${label} ${i} (${secs}s) — ⚠️ ERRORED, not a result: ${r.message}`);
      if (label === 'CONTROL') {
        console.error(
          '🔴 THE CONTROL ERRORED. It has not shown the capability is reachable, so nothing below\n' +
            '   can be read as a denial being FALSE. Re-run before quoting any number from it.',
        );
      }
      continue;
    }
    console.error(
      `\n─── ${label} ${i} (${secs}s) ─────────────────────────────────────────`,
    );
    console.error(`  Q      : ${q}`);
    console.error(`  tools  : ${r.toolCalls.map((c) => `${c.name}${c.ok ? '' : '!'}`).join(', ') || 'NONE'}`);
    if (r.secondLook) {
      const verdict = !r.secondLook.changed
        ? 'SAME — it looked again and repeated itself verbatim'
        : r.secondLook.stillDenies
          ? 'REWORDED — changed the words and denied anyway. NOT a repair.'
          : '🔴 WITHDRAWN — the denial was wrong and the second look caught it';
      console.error(`  🔴 SECOND LOOK FIRED — ${verdict}`);
      console.error(`  WOULD HAVE SENT: ${r.secondLook.deniedText.replace(/\n/g, ' ')}`);
      console.error(`  SENT INSTEAD   : ${r.replyText.replace(/\n/g, ' ')}`);
    } else {
      console.error('  second look: did not fire');
      console.error(`  SENT   : ${r.replyText.replace(/\n/g, ' ')}`);
    }
  }
  if (errored > 0) {
    console.error(`\n⚠️ ${errored} of ${runs.length} reps ERRORED and are not in any count above.`);
  }
}

void main();
