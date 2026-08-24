import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildTools } from '../src/tools/index.js';
import { makeRunbookTool } from '../src/tools/runbook.js';
import type { ToolContext } from '../src/tools/types.js';
import { testConfig } from './helpers.js';

const dir = mkdtempSync(join(tmpdir(), 'jedd-runbook-'));
const runbookPath = join(dir, 'inventory.md');
writeFileSync(
  runbookPath,
  [
    '# Inventory',
    '',
    '## 1. Host access',
    'ssh hp works.',
    '',
    '## 3. Service endpoints',
    'Jellyfin needs the /jellyfin prefix.',
    '',
    '## 8. Safety rules — BINDING',
    'Never restart gluetun.',
    '',
  ].join('\n'),
  'utf8',
);

const ctx = { role: 'owner', senderHandle: '+1', config: testConfig() } as ToolContext;
const tool = makeRunbookTool(runbookPath);

test('a runbook topic returns just that section', async () => {
  const result = await tool.run({ topic: 'endpoints' }, ctx);
  assert.equal(result.ok, true);
  assert.match(result.content, /Jellyfin needs the \/jellyfin prefix/);
  // It must stop at the next heading rather than returning the rest of the file.
  assert.equal(result.content.includes('Never restart gluetun'), false);
  assert.equal(result.content.includes('ssh hp works'), false);
});

test('🔴 the SAFETY section is not fetchable, by design', async () => {
  // Lazy-loading the HOW is fine; lazy-loading the SAFETY is not. A rule the
  // model must choose to load is a rule that is sometimes simply absent, and its
  // absence is silent. Section 8 lives in code as preconditions instead.
  for (const topic of ['safety', 'decisions', 'rules']) {
    const result = await tool.run({ topic }, ctx);
    assert.equal(result.ok, false, `"${topic}" must not be served`);
    assert.match(result.content, /enforced in code/);
    assert.equal(result.content.includes('Never restart gluetun'), false);
  }
});

test('no topic maps to section 8 under any name', async () => {
  // The failing control for the test above: it checks the three names I thought
  // of. This checks the actual OUTPUT of every advertised topic, so a mapping
  // that accidentally pointed at section 8 would be caught regardless of name.
  const topics = (tool.parameters as { properties: { topic: { enum: string[] } } }).properties.topic
    .enum;
  for (const topic of topics) {
    const result = await tool.run({ topic }, ctx);
    if (result.ok) {
      assert.equal(
        result.content.includes('Never restart gluetun'),
        false,
        `topic "${topic}" leaked the safety section`,
      );
    }
  }
});

test('an unknown topic is refused with the list of real ones', async () => {
  const result = await tool.run({ topic: 'nonsense' }, ctx);
  assert.equal(result.ok, false);
  assert.match(result.content, /endpoints/);
});

test('a missing runbook file fails as a value, not a throw', async () => {
  const broken = makeRunbookTool(join(dir, 'does-not-exist.md'));
  const result = await broken.run({ topic: 'endpoints' }, ctx);
  assert.equal(result.ok, false);
  assert.match(result.content, /Could not read the runbook/);
});

test('read_runbook is not registered when no runbook path is configured', () => {
  assert.equal(
    buildTools(testConfig()).some((t) => t.name === 'read_runbook'),
    false,
  );
  assert.equal(
    buildTools(testConfig({ runbookPath })).some((t) => t.name === 'read_runbook'),
    true,
  );
});

test('read_runbook is owner-only', () => {
  assert.equal(tool.minRole, 'owner');
});
