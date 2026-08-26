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
  process.exit(controls.bounce.passed && controls.quiet.passed && blind.state === 'blind' ? 0 : 1);
}

console.log(`── REAL SEND (since ${since}) ────────────────────────────────────`);
const result = await verifyKindleDelivery(read, {
  sentAt: new Date(since),
  ...(arg('file') ? { filename: arg('file')! } : {}),
});
console.log(`  state = ${result.state}`);
if (result.state === 'failed') console.log(`  code  = ${result.code} — ${result.reason}`);
console.log(`  ${result.detail}`);
if (result.state === 'no-failure-seen') {
  console.log(
    '\n  🔴 READ THIS AS WRITTEN: no refusal was found. That is NOT confirmation the book\n' +
      '     arrived. Amazon sends no acceptance notice, and discards mail to an address that\n' +
      '     does not exist without telling anyone.',
  );
}
process.exit(0);
