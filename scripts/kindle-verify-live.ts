/**
 * Point the Kindle delivery instrument at the REAL mailbox and show what it does.
 *
 * ── 🔴 WHAT THIS IS FOR ──────────────────────────────────────────────────────
 *
 * A detector that has never fired is a claim, not a detector. This runs the
 * shipped code — real IMAP, real folders, real Amazon notices — and prints:
 *
 *   1. the two controls, one of which MUST report a failure;
 *   2. a deliberately broken reader, which MUST come back `blind` and not
 *      "nothing went wrong";
 *   3. the verdict for a real send, if you name one.
 *
 * It sends NOTHING. It reads only mail from `do-not-reply@amazon.com` and prints
 * codes and dates, never message bodies.
 *
 * Usage:
 *   npx tsx scripts/kindle-verify-live.ts
 *   npx tsx scripts/kindle-verify-live.ts --since 2026-08-26T20:00:00Z --file "Tress.epub"
 *   npx tsx scripts/kindle-verify-live.ts --since <iso> --until <iso>
 *
 * The window defaults to 30 minutes after --since. Widening it does not find
 * more about that send; it finds OTHER sends' bounces. See the note below.
 */
import { loadConfig } from '../src/config.js';
import { imapMailboxReader, imapSettingsFrom, type MailboxReader } from '../src/kindle-mailbox.js';
import { CONTROL_BOUNCE, runControls, verifyKindleDelivery } from '../src/kindle-verify.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const config = loadConfig();
const settings = imapSettingsFrom(config);
if ('missing' in settings) {
  console.error(`Cannot run: ${settings.missing} is not set.`);
  process.exit(2);
}
console.log(`mailbox: ${settings.user} @ ${settings.host}:${settings.port}\n`);

const read = imapMailboxReader(settings);

// ── 1. the controls, against the live server ────────────────────────────────
console.log('── CONTROLS (live IMAP) ──────────────────────────────────────────');
const controls = await runControls(read);
console.log(
  `  known-refusal window ${CONTROL_BOUNCE.since.toISOString()} .. ${CONTROL_BOUNCE.until.toISOString()}\n` +
    `    expected failed/${CONTROL_BOUNCE.expectCode}   got ${controls.bounce.got}   ` +
    `${controls.bounce.passed ? 'PASS — the instrument CAN report failure' : '🔴 FAIL'}`,
);
console.log(
  `  known-quiet window\n    expected no-failure-seen   got ${controls.quiet.got}   ` +
    `${controls.quiet.passed ? 'PASS — and does not over-attribute' : '🔴 FAIL'}`,
);
console.log(
  `  the two controls ${controls.bounce.got === controls.quiet.got ? '🔴 AGREE — no discrimination' : 'DIFFER, so this run can tell the two apart'}\n`,
);

// ── 1b. FOLDER COVERAGE, against the real server ────────────────────────────
//
// 🔴 NO UNIT TEST CAN REACH THIS, so it is asserted here. Gmail's All Mail
// EXCLUDES Spam and Trash, and Amazon's notices demonstrably land in Spam — so a
// sweep that quietly covers two folders instead of four returns a clean result
// for a refusal that is sitting right there. The four are named explicitly
// rather than counted, because "four folders" is satisfied by the wrong four.
console.log('── FOLDER COVERAGE (live IMAP) ──────────────────────────────────');
const probe = await read([{ since: CONTROL_BOUNCE.since, until: CONTROL_BOUNCE.until }]);
let foldersOk = false;
if (!probe.ok) {
  console.log(`  🔴 could not read the mailbox: ${probe.reason}`);
} else {
  const covered = probe.folders.map((f) => f.toLowerCase());
  const missing = [
    covered.includes('inbox') ? null : 'INBOX',
    covered.some((f) => f.includes('all mail')) ? null : 'All Mail (\\All)',
    covered.some((f) => f.includes('spam') || f.includes('junk')) ? null : 'Spam (\\Junk)',
    covered.some((f) => f.includes('trash') || f.includes('bin')) ? null : 'Trash (\\Trash)',
  ].filter((x): x is string => x !== null);
  console.log(`  searched: ${probe.folders.join(', ')}`);
  if (probe.skipped.length > 0) console.log(`  🔴 SKIPPED: ${probe.skipped.join('; ')}`);
  foldersOk = missing.length === 0 && probe.skipped.length === 0;
  console.log(
    foldersOk
      ? '  PASS — all four folders were really opened'
      : `  🔴 FAIL — not searched: ${missing.join(', ')}`,
  );
}
console.log('');

// ── 2. the blindness path, forced ───────────────────────────────────────────
//
// 🔴 THE FAILING CONTROL FOR THE GATE ITSELF. A reader that cannot read must
// produce `blind`, never `no-failure-seen`. If this line ever prints
// "no-failure-seen", a broken mailbox is being reported as a clean one and the
// instrument is back to where V1 was.
console.log('── FORCED BLINDNESS (reader that cannot read) ────────────────────');
const brokenReader: MailboxReader = async () => ({ ok: false, reason: 'forced failure for this probe' });
const blind = await verifyKindleDelivery(brokenReader, { sentAt: new Date(Date.now() - 3600_000) });
console.log(`  state = ${blind.state}   ${blind.state === 'blind' ? 'PASS' : '🔴 FAIL'}`);
console.log(`  ${blind.detail}\n`);

// ── 3. a real send, if one was named ────────────────────────────────────────
const since = arg('since');
if (!since) {
  console.log('No --since given, so no real send was checked. Pass --since <iso> [--file <name>].');
  process.exit(
    controls.bounce.passed && controls.quiet.passed && foldersOk && blind.state === 'blind' ? 0 : 1,
  );
}

/**
 * 🔴 THE WINDOW IS BOUNDED, AND THIS HARNESS GOT IT WRONG FIRST TIME.
 *
 * Run against the Mistborn sends of 2026-08-23 22:50Z with no upper bound, this
 * reported `failed / E009`. **That E009 arrived 2026-08-24 19:00Z — twenty hours
 * later, from a different agent's probe.** The shipped verifier could not make
 * that mistake: in production `now` is the follow-up's fire time, twelve minutes
 * after the send. The HARNESS made it, by defaulting to `new Date()` and quietly
 * widening a twelve-minute question into a three-day one.
 *
 * Recorded rather than just fixed, because it is the failure this whole
 * instrument is about, committed by the tool built to demonstrate it: **an
 * unbounded window turns "did THIS send fail" into "has ANYTHING failed since",
 * and the second question always eventually answers yes.**
 */
const DEFAULT_WINDOW_MS = 30 * 60 * 1000;
const until = arg('until')
  ? new Date(arg('until')!)
  : new Date(Date.parse(since) + DEFAULT_WINDOW_MS);
console.log(`── REAL SEND (${since} .. ${until.toISOString()}) ─────────────────`);
const result = await verifyKindleDelivery(
  read,
  {
    sentAt: new Date(since),
    ...(arg('file') ? { filename: arg('file')! } : {}),
  },
  until,
);
console.log(`  state = ${result.state}`);
if (result.state === 'failed' || result.state === 'failed-unattributed') {
  console.log(`  code  = ${result.code} — ${result.reason}`);
}
console.log(`  ${result.detail}`);
if (result.state === 'no-failure-seen') {
  console.log(
    '\n  🔴 READ THIS AS WRITTEN: no refusal was found. That is NOT confirmation the book\n' +
      '     arrived. Amazon sends no acceptance notice, and discards mail to an address that\n' +
      '     does not exist without telling anyone.',
  );
}
process.exit(0);
