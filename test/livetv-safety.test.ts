import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const HOMELAB_TOOLS = new URL('../src/tools/homelab.ts', import.meta.url);

/**
 * A source-level guard, chosen deliberately over a behavioural one.
 *
 * The rule is "this code must never make a particular call", and the failure it
 * prevents is an outage that only reproduces against a DEAD tuner — a state no
 * test can safely create. A behavioural test would have to either hit the real
 * tuner (the exact thing that caused hours of downtime on 2026-07-26) or mock it,
 * and a mock proves nothing about which URL the real code reaches for.
 *
 * So this reads the file that would have to change. It is narrow, it names the
 * file it inspects, and it fails if the string comes back.
 */
test('livetv_status never enumerates Jellyfin channels or tuners', async () => {
  const source = await readFile(HOMELAB_TOOLS, 'utf8');

  // Strip comments — the prohibition is documented in prose right above the tool,
  // and matching our own explanation would make this test pass for the wrong
  // reason (and fail when the comment is reworded).
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  for (const forbidden of ['/LiveTv/Channels', '/LiveTv/Info', '/LiveTv/Tuners', '/LiveTv/Recordings']) {
    assert.equal(
      code.includes(forbidden),
      false,
      `${forbidden} iterates the tuner and wedged Jellyfin site-wide on 2026-07-26. ` +
        'Answer live-TV questions from the Dispatcharr side instead.',
    );
  }
});

test('CONTROL: the stripper leaves real code visible', async () => {
  // Without this, a bug in the comment-stripping above would silently blank the
  // haystack and the test would pass by searching an empty string.
  const source = await readFile(HOMELAB_TOOLS, 'utf8');
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  assert.ok(code.includes('/System/Info'), 'the safe Jellyfin call must still be visible in code');
  assert.ok(code.includes("name: 'livetv_status'"), 'the tool itself must still be visible in code');
  assert.ok(code.length > 2000, `stripped code is implausibly short (${code.length} chars)`);
});
