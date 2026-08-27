#!/usr/bin/env node
/**
 * Operator tool for the conversation log.
 *
 * The V1 trap this closes: **a bad reply keeps poisoning history after the bug
 * that produced it is fixed** — the model reads its own past wrong answer as
 * established context and repeats it, so every fix is undone by its own
 * transcript. Eviction has to be reachable by a human without a rebuild, and it
 * must not require wiping the conversation around it.
 *
 *   node scripts/history.mjs list <handle>
 *   node scripts/history.mjs evict <turnId> "<reason>"
 *   node scripts/history.mjs repair <turnId> "<new reply>" "<reason>"
 *
 * Eviction and repair are APPENDED. The original stays in the log, because the
 * log is the audit trail and an audit trail you can quietly correct is not one.
 */
import { HistoryStore } from '../src/store.ts';

const PATH = new URL('../data/history.jsonl', import.meta.url).pathname;
const [, , cmd, a, b, c] = process.argv;
const store = new HistoryStore(PATH);

if (cmd === 'list' && a) {
  const turns = store.all(a);
  if (!turns.length) console.log(`no turns for ${a}`);
  for (const t of turns) {
    const mark = t.evicted ? 'EVICTED' : t.repairedFrom ? 'REPAIRED' : 'ok';
    console.log(`${t.id}  ${t.at}  [${mark}]`);
    console.log(`   user: ${t.userText.slice(0, 100)}`);
    console.log(`   jedd: ${t.replyText.slice(0, 100)}`);
    if (t.evicted) console.log(`   evicted: ${t.evicted.reason}`);
  }
} else if (cmd === 'evict' && a && b) {
  console.log(store.evict(a, b) ? `evicted ${a}` : `no such turn ${a}`);
} else if (cmd === 'repair' && a && b && c) {
  console.log(store.repair(a, b, c) ? `repaired ${a}` : `no such turn ${a}`);
} else {
  console.error('usage: history.mjs list <handle> | evict <id> "<reason>" | repair <id> "<reply>" "<reason>"');
  process.exit(2);
}
