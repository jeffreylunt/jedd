/**
 * Does a narrow tool's RESULT declaring its own scope stop the model denying a
 * capability it holds? TWO ARMS, against the live model, on the question that
 * produced the bug.
 *
 *   /opt/homebrew/bin/node --import tsx scripts/probe-result-scope.ts [repsPerArm]
 *
 * ── 🔴 WHY BOTH ARMS RUN HERE, RATHER THAN COMPARING TO LAST NIGHT'S 8/10 ────
 *
 * The baseline for this defect is 80% (8 of 10) measured on 2026-08-28. Quoting
 * that as the control for a run taken now would compare across a different model
 * server state, a different queue depth, and a different day — everything that
 * moves in an LLM measurement, moving at once, with one number attributed to the
 * one thing I changed. So BARE and SCOPED are both measured in this process,
 * INTERLEAVED, and the only difference between them is `scopeNote` being
 * stripped from every tool in the BARE arm. One variable, ablated.
 *
 * ⚠️ The historical 8/10 is still reported alongside, as a sanity check on the
 * BARE arm. If BARE comes out nothing like 80%, the harness has drifted from the
 * one that produced that figure and NEITHER number should be believed.
 *
 * ── 🔴 THE REGISTRY IS READ FROM THE RUNNING CONTAINER, NOT PINNED ───────────
 *
 * A measurement on this defect was already invalidated once by a harness that
 * built its own registry and disagreed with production by three tools — a
 * reconstruction of production, quoted as production. The running process prints
 * its tool list at boot, so this script SHELLS OUT AND READS IT, and refuses to
 * measure on any difference. A pinned copy of that line would have been correct
 * on the day it was pasted and silently wrong afterwards.
 *
 * ⚠️ `scopeNote` changes no tool NAME, so the banner check stays valid across
 * this change. It is checking that the SELECTION SURFACE is production's, which
 * is the thing the defect is about.
 *
 * ── ⚠️ WHAT IS DELIBERATELY NOT PRODUCTION ──────────────────────────────────
 *
 *  - Every `writes: true` tool, plus `hp_shell`, has its BODY replaced with a
 *    refusal. Names, descriptions and schemas — the whole surface selection sees
 *    — are untouched. Reads run for real against the live homelab.
 *  - History starts EMPTY, which is the harder case than the real turn, not the
 *    identical one.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../src/agent.js';
import { loadConfig } from '../src/config.js';
import { InviteLedger } from '../src/invite-ledger.js';
import { JfagoClient } from '../src/jfago.js';
import { OllamaClient } from '../src/llm.js';
import { buildTools } from '../src/tools/index.js';
import type { Tool } from '../src/tools/types.js';

/** The exact question Jeff asked at 2026-08-28T23:15:17Z. */
const QUESTION = 'Has tom watched anything yet';
/**
 * A POSITIVE CONTROL that does real work. It is the question Jedd answered
 * CORRECTLY on 2026-08-26 via `homelab_read`. If it fails, the capability is
 * broken in this harness, every denial below would be TRUE, and the run is
 * meaningless rather than negative. Five clean "did not fire" results meant
 * nothing on an earlier run for exactly this reason: every read had failed
 * EHOSTUNREACH and nobody had checked.
 */
const CONTROL_QUESTION = 'Look at what Jeff has watched';

const OUT = join(process.cwd(), 'data', `probe-result-scope-${Date.now()}.jsonl`);
// Created UP FRONT. Appending lazily meant a wrong cwd threw AFTER the whole
// preflight had passed and the first rep had already burned model time.
mkdirSync(join(process.cwd(), 'data'), { recursive: true });

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

/**
 * 🔴 THE ABLATION. One field removed and nothing else — same tools, same names,
 * same descriptions, same schemas, same bodies. Anything else changed here and
 * the two arms stop being a comparison.
 */
function stripScopeNotes(tools: Tool[]): Tool[] {
  return tools.map((t) => {
    const { scopeNote: _dropped, ...rest } = t;
    return rest as Tool;
  });
}

/** The running container's own boot banner. Not a copy of it. */
function runningRegistry(): string {
  const docker = ['/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/usr/bin/docker'].find((p) =>
    existsSync(p),
  );
  if (!docker) {
    console.error(
      '🔴 No docker binary found, so the running registry cannot be read and this harness cannot be\n' +
        '   shown to match production. Refusing to measure — a reconstruction of production quoted\n' +
        '   as production is what invalidated the last measurement on this defect.',
    );
    process.exit(1);
  }
  // ⚠️ BOTH STREAMS. The boot banner is written with `console.error`, so it
  // arrives on the container's STDERR — `docker logs` keeps the two apart and an
  // stdout-only read finds nothing and reports "no banner", which looks like a
  // dead container rather than a harness bug. Cost one run to learn.
  const res = spawnSync(docker, ['logs', 'jedd-v2'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const logs = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  const line = logs.split('\n').filter((l) => l.startsWith('[jedd] tools=')).at(-1);
  if (!line) {
    console.error('🔴 The container printed no `[jedd] tools=` banner. Refusing to measure.');
    process.exit(1);
  }
  return line.slice('[jedd] tools='.length).trim();
}

type Outcome = 'errored' | 'recorded';

async function main(): Promise<void> {
  const repsPerArm = Number(process.argv[2] ?? 10);
  /**
   * 🔴 `readOnly: false` — FIDELITY, NOT A SHORTCUT. `registerable()` drops every
   * `writes: true` tool when writes are off, giving 23 tools where the container
   * offers 37. The defect is a SELECTION failure whose main rival explanation is
   * registry size, so measuring at 23 would answer a different question and
   * answer it wrong. Every write body is stubbed below.
   */
  const config = { ...loadConfig(), readOnly: false };
  const jfagoDir = mkdtempSync(join(tmpdir(), 'jedd-scope-probe-'));
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
   * 🔴 PREFLIGHT: CAN **THIS BINARY** REACH THE HOMELAB?
   *
   * macOS "Local Network" privacy denies LAN-peer access PER BINARY. `curl`
   * reaches Jellyfin in 18 ms from the same shell while the nvm node on PATH
   * gets EHOSTUNREACH; `ecosystem.config.cjs` pins the Homebrew node for exactly
   * this reason and `npx` does not. A GREEN `curl` IS NOT EVIDENCE FOR THIS
   * PROCESS — reproduce in the runtime that fails, or measure nothing and call
   * it a finding.
   */
  const probe = await fetch(`${config.jellyfin.baseUrl}/System/Info/Public`, {
    signal: AbortSignal.timeout(8000),
  }).catch((e: unknown) => e as Error);
  if (probe instanceof Error) {
    console.error(
      `🔴 THIS PROCESS CANNOT REACH JELLYFIN (${(probe as { cause?: { code?: string } }).cause?.code ?? probe.message}).\n` +
        '   Every homelab read would fail, every denial would be TRUE, and the run would look like a\n' +
        '   clean negative. Refusing to measure. Try:\n' +
        '     /opt/homebrew/bin/node --import tsx scripts/probe-result-scope.ts',
    );
    process.exit(1);
  }
  console.error(`[probe] homelab reachable from THIS binary: HTTP ${probe.status}`);

  const running = runningRegistry();
  const built = tools.map((t) => t.name).join(', ');
  if (built !== running) {
    console.error('🔴 REGISTRY MISMATCH — this harness is not production. Refusing to measure.');
    console.error(`  running : ${running}`);
    console.error(`  built   : ${built}`);
    process.exit(1);
  }
  console.error(`[probe] registry matches the running container exactly: ${tools.length} tools`);

  const scoped = stubWrites(tools);
  const bare = stubWrites(stripScopeNotes(tools));
  const noteCount = scoped.filter((t) => t.scopeNote).length;
  if (noteCount === 0) {
    console.error('🔴 The SCOPED arm carries ZERO scope notes — the arms are identical. Refusing.');
    process.exit(1);
  }
  if (bare.some((t) => t.scopeNote)) {
    console.error('🔴 The BARE arm still carries a scope note — the ablation did not apply.');
    process.exit(1);
  }
  // ⚠️ The ablation rest-spreads every tool, which copies `run` only because
  // every Tool in this repo is an object literal. If one ever became a class
  // instance the spread would drop `run` — and it is applied to BARE ONLY, so
  // the CONTROL arm would silently get broken tools while the treatment arm kept
  // working. That is the one harness failure that would look like a huge effect.
  if (!bare.every((t) => typeof t.run === 'function')) {
    console.error('🔴 The ablation destroyed a tool body in the BARE arm. Refusing to measure.');
    process.exit(1);
  }
  console.error(`[probe] arms differ by exactly ${noteCount} scope note(s) and nothing else`);
  console.error(`[probe] raw replies → ${OUT}`);

  const llm = new OllamaClient(config);
  /**
   * 🔴 ONE CONTROL PER ARM, AT OPPOSITE ENDS OF THE RUN.
   *
   * The control's job is to show the capability is REACHABLE, so that a denial
   * can be called false. Running it only under SCOPED tools would show that for
   * one arm and leave the other arm's denials arguably TRUE — the exact hole
   * that made an earlier run's five clean results worthless. Opposite ends also
   * bracket the run in time: if the homelab or the model server dies halfway,
   * the closing control says so instead of the run reporting a improvement it
   * did not measure.
   */
  const plan: { arm: 'CONTROL-BARE' | 'CONTROL-SCOPED' | 'BARE' | 'SCOPED'; q: string; tools: Tool[] }[] = [
    { arm: 'CONTROL-BARE', q: CONTROL_QUESTION, tools: bare },
  ];
  // 🔴 INTERLEAVED, not blocked. A model server that slows, warms or drifts over
  // an hour would otherwise load all of that drift onto whichever arm ran second.
  for (let i = 0; i < repsPerArm; i++) {
    /**
     * 🔴 COUNTERBALANCED, and interleaving alone was NOT enough.
     *
     * Interleaving kills drift ACROSS the run. It does nothing about order
     * WITHIN the pair: run A pushed BARE then SCOPED every time, so SCOPED was
     * always the second call against a shared client and a server the BARE rep
     * had just warmed, on prompts identical up to the tool result. Any
     * prefix-cache or scheduling asymmetry landed on the treatment arm every
     * single time, in the FAVOURABLE direction — the one structural way this
     * harness could flatter the thing being tested.
     *
     * ⚠️ RUN A (2026-08-28, 9/10 → 0/10) PREDATES THIS. Its effect is far larger
     * than warmth plausibly buys and the objective metric separated perfectly,
     * but it is a real hole and the number should be re-taken here.
     */
    const pair = [
      { arm: 'BARE' as const, q: QUESTION, tools: bare },
      { arm: 'SCOPED' as const, q: QUESTION, tools: scoped },
    ];
    plan.push(...(i % 2 === 0 ? pair : [pair[1]!, pair[0]!]));
  }
  plan.push({ arm: 'CONTROL-SCOPED', q: CONTROL_QUESTION, tools: scoped });

  /**
   * Set only by a CONTROL rep that actually reached `homelab_read`. Consulted at
   * the end, so a control that failed to do its job says so loudly instead of
   * showing up as a zero in a table nobody reads.
   */
  let controlProved = false;
  const tally: Record<string, { reps: number; errored: number; reachedHistory: number }> = {
    'CONTROL-BARE': { reps: 0, errored: 0, reachedHistory: 0 },
    'CONTROL-SCOPED': { reps: 0, errored: 0, reachedHistory: 0 },
    BARE: { reps: 0, errored: 0, reachedHistory: 0 },
    SCOPED: { reps: 0, errored: 0, reachedHistory: 0 },
  };

  for (const [i, step] of plan.entries()) {
    // A FRESH Agent per rep: history is one mutable array per sender, so reusing
    // one would let each rep read the previous rep's answer.
    const agent = new Agent(config, llm, undefined, step.tools);
    const startedAt = Date.now();
    const r = await agent.handle(config.ownerHandle, step.q).catch((e: unknown) => e as Error);
    const secs = ((Date.now() - startedAt) / 1000).toFixed(0);
    const t = tally[step.arm]!;
    t.reps++;

    /**
     * ⚠️ A THROWN REP IS RECORDED AS `errored`, NOT DROPPED. A ten-rep run on
     * this defect already died on rep 0 (`done_reason=length`) and collected
     * nothing. Dropping a rep quietly shrinks the denominator, which is how a
     * run reports "4 of 4" while having attempted six.
     */
    let row: Record<string, unknown>;
    let outcome: Outcome;
    if (r instanceof Error) {
      t.errored++;
      outcome = 'errored';
      row = { i, arm: step.arm, q: step.q, secs, outcome, error: r.message };
      console.error(`\n─── ${step.arm} ${i} (${secs}s) — ⚠️ ERRORED, not a result: ${r.message}`);
      if (step.arm.startsWith('CONTROL')) {
        console.error(
          '🔴 A CONTROL ERRORED. It has not shown the capability is reachable, so no denial below\n' +
            '   can be read as FALSE. Re-run before quoting any number from this.',
        );
      }
    } else {
      outcome = 'recorded';
      const called = r.toolCalls.map((c) => `${c.name}${c.ok ? '' : '!'}`);
      // Objective, not a phrase list: did the turn reach the tool that actually
      // holds watch history? This is a fact about the tool-call record and does
      // not depend on anybody's reading of the prose.
      const reachedHistory = r.toolCalls.some((c) => c.name === 'homelab_read' && c.ok);
      if (reachedHistory) t.reachedHistory++;
      /**
       * 🔴 THE CONTROL'S PASS CONDITION IS "REACHED THE CAPABILITY", NOT "DID
       * NOT THROW".
       *
       * It used to be the latter, which tests the wrong thing: a control that
       * COMPLETES and denies, calling `homelab_read` zero times, printed no
       * warning at all and appeared only as a number in the closing tally. The
       * entire reason this control exists is that five clean "did not fire"
       * results once meant nothing, because every read had failed EHOSTUNREACH
       * and nobody had checked. Every other precondition here refuses to
       * measure; this one merely reported.
       */
      if (step.arm.startsWith('CONTROL') && reachedHistory) controlProved = true;
      row = {
        i,
        arm: step.arm,
        q: step.q,
        secs,
        outcome,
        tools: called,
        reachedHistory,
        // 🔴 THE FULL REPLY, VERBATIM. Denial vs answer is a judgement about
        // prose and the detector that exists scores 25% recall on this very
        // question — so it is NOT used to produce the headline number. The text
        // is written out so the classification can be checked by anyone.
        reply: r.replyText,
      };
      console.error(`\n─── ${step.arm} ${i} (${secs}s) ─────────────────────────────`);
      console.error(`  Q     : ${step.q}`);
      console.error(`  tools : ${called.join(', ') || 'NONE'}`);
      console.error(`  history reached: ${reachedHistory ? 'YES' : 'no'}`);
      console.error(`  REPLY : ${r.replyText.replace(/\n/g, ' ')}`);
    }
    appendFileSync(OUT, `${JSON.stringify(row)}\n`);
  }

  console.error('\n═══ TALLY (tool-call record only — read the replies for the denial rate) ═══');
  for (const [arm, v] of Object.entries(tally)) {
    console.error(
      `  ${arm.padEnd(7)} reps=${v.reps}  errored=${v.errored}  reached homelab_read=${v.reachedHistory}`,
    );
  }
  if (!controlProved) {
    console.error(
      '\n🔴 NO CONTROL REP EVER REACHED `homelab_read`. The positive control did not do its job, so\n' +
        '   nothing here shows the capability was reachable ON THE CONTROL\'S EVIDENCE and no denial\n' +
        '   above can be called FALSE from it. Check whether any SUBJECT rep reached it — that is a\n' +
        '   valid substitute and a stronger one, but it is a DIFFERENT artifact and has to be\n' +
        '   reported as such. Do not write "positive control passed".',
    );
  }
  console.error(`\nRaw replies: ${OUT}`);
}

void main();
