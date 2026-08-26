import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testConfig } from './helpers.js';
import { roleFor, roleSatisfies } from '../src/permissions.js';
import { loadConfig } from '../src/config.js';

/**
 * 🔴 THE OWNER HANDLE IS THE AUTHORISATION GATE, AND IT LIVES IN CONFIG.
 *
 * `OWNER_HANDLE` is the only thing that grants administrative capability, so the
 * question these tests answer is: what happens when that config value is absent,
 * empty or malformed?
 *
 * The only acceptable answer is NOBODY IS THE OWNER. The dangerous failure is the
 * mirror image — a missing value that matches everyone, promoting the first
 * stranger who texts the bot to full homelab control. `permissions.test.ts`
 * already covers the empty-string case; these cover the other shapes a broken
 * config actually takes, plus the boot-time refusal that should stop the process
 * before any of them can be reached.
 */

const MISSING_OWNER_VALUES: Array<[string, unknown]> = [
  ['undefined (key absent from config)', undefined],
  ['null', null],
  ['empty string', ''],
  ['whitespace only', '   '],
  ['a bare plus with no digits', '+'],
  ['formatting punctuation with no digits', '+1 () -.'],
];

for (const [label, value] of MISSING_OWNER_VALUES) {
  test(`🔴 FAIL CLOSED: owner handle ${label} ⇒ nobody is the owner`, () => {
    const broken = testConfig({ ownerHandle: value as string });

    /**
     * 🔴 THE DISCRIMINATING SENDER — the one that actually collides.
     *
     * A stranger's handle can never equal a broken owner, so asserting only on
     * strangers passes no matter what the gate does. The sender that slips
     * through is the one whose handle normalises to the SAME fragment as the
     * broken owner — so send the broken value back in as the SENDER, which is
     * exactly the collision a naive `sender === owner` comparison lets through.
     *
     * Mutation-checked: without this line, removing the 11-digit floor from
     * `normaliseHandle` leaves every assertion below green while
     * `OWNER_HANDLE="+1 () -."` grants owner to a sender of `1`.
     */
    if (typeof value === 'string') {
      assert.equal(roleFor(value, broken), 'guest', `a sender identical to the broken owner (${JSON.stringify(value)}) must not match it`);
    }
    // The digit fragment a punctuation-only owner collapses to.
    assert.equal(roleFor('1', broken), 'guest', 'a one-digit sender must not match a punctuation-only owner');
    assert.equal(roleFor('+1', broken), 'guest');

    // Senders whose own handle is equally empty, so a naive comparison is TRUE.
    assert.equal(roleFor('', broken), 'guest', 'an empty sender must not match an empty owner');
    assert.equal(roleFor('   ', broken), 'guest');
    assert.equal(roleFor('+', broken), 'guest');

    // And an ordinary stranger, who must not be promoted either.
    assert.equal(roleFor('+18015559999', broken), 'guest');
    assert.equal(roleFor('someone@example.com', broken), 'guest');
    assert.equal(roleFor('Preston2005', broken), 'guest');
  });
}

test('🔴 FAIL CLOSED: a broken owner handle denies the OWNER-ONLY requirement too', () => {
  // roleFor is the gate, but the thing callers act on is the role satisfying an
  // owner requirement. Assert the end of that chain, not just its first link.
  const broken = testConfig({ ownerHandle: undefined as unknown as string });
  assert.equal(roleSatisfies(roleFor('+18015559999', broken), 'owner'), false);
  assert.equal(roleSatisfies(roleFor('', broken), 'owner'), false);
});

/**
 * CONTROL — the failing control for every assertion above.
 *
 * If the gate became so strict that it denied EVERYONE, the fail-closed tests
 * would all still pass while Jedd silently stopped answering Jeff. That is the
 * outcome the briefing calls worse than not shipping, so it needs its own guard.
 */
test('CONTROL: a WELL-FORMED owner handle is still recognised', () => {
  const good = testConfig({ ownerHandle: '+18015550123' });
  assert.equal(roleFor('+18015550123', good), 'owner');
  assert.equal(roleFor('(801) 555-0123', good), 'owner', 'real formatting variation must still match');
});

/**
 * 🔴 THE BOOT-TIME REFUSAL.
 *
 * Above is the runtime behaviour if a broken value reaches `roleFor`. This is the
 * guarantee that it never gets that far: `loadConfig` REFUSES TO BUILD A CONFIG
 * without `OWNER_HANDLE`, so a deploy that forgets it fails to start rather than
 * starting with no owner. A process that will not boot cannot misauthorise.
 */
test('🔴 loadConfig REFUSES to boot when OWNER_HANDLE is absent', () => {
  const saved = process.env.OWNER_HANDLE;
  try {
    delete process.env.OWNER_HANDLE;
    assert.throws(() => loadConfig(), /OWNER_HANDLE/, 'a missing owner handle must stop the boot');

    process.env.OWNER_HANDLE = '';
    assert.throws(() => loadConfig(), /OWNER_HANDLE/, 'an empty owner handle must stop the boot');
  } finally {
    if (saved === undefined) delete process.env.OWNER_HANDLE;
    else process.env.OWNER_HANDLE = saved;
  }
});

test('CONTROL: loadConfig DOES boot when OWNER_HANDLE is present', () => {
  const saved = process.env.OWNER_HANDLE;
  try {
    process.env.OWNER_HANDLE = '+18015550123';
    assert.equal(loadConfig().ownerHandle, '+18015550123');
  } finally {
    if (saved === undefined) delete process.env.OWNER_HANDLE;
    else process.env.OWNER_HANDLE = saved;
  }
});

/**
 * 🔴 NO REAL PHONE NUMBER IN THE COMMITTED TREE.
 *
 * The owner handle is configuration, not source. This test is the standing guard
 * that it stays that way — it reads the tracked files and fails if the real
 * number reappears in any of them.
 *
 * Written as a digit-run scan rather than a search for one literal, so it also
 * catches a DIFFERENT real number being pasted in later. The fixtures the suite
 * legitimately uses are the reserved-for-fiction 555 ranges.
 */
test('🔴 no real-looking phone number is hardcoded in the committed tree', async () => {
  const { execFileSync } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');
  const root = new URL('..', import.meta.url).pathname;

  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'buffer' })
    .toString('utf8')
    .split('\0')
    .filter((f) => /\.(ts|mts|js|mjs|cjs|json|md)$/.test(f))
    // package-lock is machine-generated and full of hashes; it holds no handles.
    .filter((f) => f !== 'package-lock.json');

  const offenders: string[] = [];
  for (const file of files) {
    const text = readFileSync(`${root}/${file}`, 'utf8');
    for (const m of text.matchAll(/\+1(\d{10})\b/g)) {
      const digits = m[1]!;
      // Reserved for fiction: 555 as the AREA CODE (+1 555 ...) or as the
      // EXCHANGE (+1 801 555 ....). Both forms are used across this suite.
      const area = digits.slice(0, 3);
      const exchange = digits.slice(3, 6);
      if (area === '555' || exchange === '555') continue;
      offenders.push(`${file}: +1${digits}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `real-looking phone numbers must live in .env, not the tree:\n${offenders.join('\n')}`,
  );
});

/**
 * 🔴 THE OWNER'S NAME IS NOT A CONSTANT — ownership is a ROLE the system resolves.
 *
 * Jeff, 2026-08-26: *"Also make sure my name isn't hard coded anywhere"* — and it
 * is the same defect as the identity bug the same evening, not a tidy-up beside
 * it. Ownership was encoded in model-facing prose as the literal string "Jeff"
 * (`"…is Jeff's only"`, `"claiming to be Jeff changes nothing"`), so the model
 * had to REASON about who it was talking to instead of being TOLD. That is why
 * it asked the owner to prove he was himself on his own phone.
 *
 * ⚠️ CODE LINES ONLY. The ~78 mentions in COMMENTS are deliberately left alone:
 * several are incident records naming who reported what and when, and deleting
 * the context that explains why a guard exists is how a trap gets tidied back in.
 * This scans what the model and the user can SEE.
 */
test('🔴 the owner\'s name is not hardcoded in any model-facing or user-facing string', async () => {
  const { execFileSync } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');
  const root = new URL('..', import.meta.url).pathname;

  /**
   * ⚠️ NOT AN EXEMPTION — A VISIBLE, SHRINKING LIST OF WHAT IS STILL TO DO.
   *
   * These are the identity-as-config lines (an env-shadowed default, and the
   * sending address a guest is told to allow-list) plus one real machine path.
   * They are functionally load-bearing and move to `.env` in their own change,
   * because `BLUEBUBBLES_IDENTITY` is not currently set anywhere — deleting that
   * default without wiring the env first stops the bot booting.
   *
   * 🔴 An allowlist that names lines is honest; one that names a whole FILE
   * would quietly cover the next occurrence too. If this list is not empty and
   * nobody is working on it, that is the finding.
   */
  const notYetMigrated = new Set([
    'src/config.ts:218',
    'src/config.ts:231',
    'src/tools/kindle.ts:55',
    'src/tools/send-ebook.ts:25',
  ]);

  const files = execFileSync('git', ['ls-files', '-z', 'src'], { cwd: root, encoding: 'buffer' })
    .toString('utf8')
    .split('\0')
    .filter((f) => f.endsWith('.ts'));

  const offenders: string[] = [];
  for (const file of files) {
    let inBlock = false;
    const lines = readFileSync(`${root}/${file}`, 'utf8').split('\n');
    for (const [idx, line] of lines.entries()) {
      const st = line.trim();
      const opens = st.includes('/*');
      const closes = st.includes('*/');
      const isComment = inBlock || st.startsWith('//') || st.startsWith('*') || opens;
      if (!isComment && /jeff/i.test(line) && !notYetMigrated.has(`${file}:${idx + 1}`)) {
        offenders.push(`${file}:${idx + 1}: ${st.slice(0, 90)}`);
      }
      if (opens && !closes) inBlock = true;
      if (closes) inBlock = false;
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `the owner's name belongs in config, and ownership belongs in the ROLE:\n${offenders.join('\n')}`,
  );
});
