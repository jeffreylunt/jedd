import { appendFileSync, mkdirSync } from 'node:fs';
import { Agent, type TurnRecord } from './agent.js';
import { loadConfig } from './config.js';
import { StdoutConnector } from './connector.js';
import { createLlmClient } from './llm.js';

const DATA_DIR = new URL('../data/', import.meta.url).pathname;

function recordTurn(record: TurnRecord): void {
  mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(`${DATA_DIR}audit.jsonl`, `${JSON.stringify(record)}\n`, 'utf8');
  const summary = record.toolCalls.length
    ? record.toolCalls.map((c) => `${c.name}${c.refused ? '(REFUSED)' : c.ok ? '' : '(failed)'}`).join(', ')
    : 'no tools';
  console.error(`  [audit] ${record.role} · ${summary} · ${record.steps} step(s)`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const llm = createLlmClient(config);
  const agent = new Agent(config, llm, recordTurn);
  const connector = new StdoutConnector(process.argv[2] ?? config.ownerHandle);

  console.error(
    `model=${llm.label} owner=${config.ownerHandle} hp=${config.hpSshHost} ` +
      `writes=${config.readOnly ? 'DISABLED' : 'ENABLED'}`,
  );

  await connector.listen(async (message) => {
    const record = await agent.handle(message.senderHandle, message.text);
    await connector.send(message.senderHandle, record.replyText || '(no reply)');
  });
}

main().catch((e) => {
  console.error(`fatal: ${(e as Error).message}`);
  process.exit(1);
});
