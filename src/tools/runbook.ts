import { readFile } from 'node:fs/promises';
import { fail, ok, type Tool } from './types.js';

/**
 * Just-in-time instruction loading.
 *
 * The core prompt stays small and invariant; domain detail arrives only when the
 * task enters that domain. That is what keeps the input lean, which is what keeps
 * an ~18 GB model fully resident in VRAM, which is what leaves room to think.
 *
 * 🔴 THE RULE THAT MAKES THIS SAFE, AND IT IS NOT NEGOTIABLE:
 *
 *   **Lazy-load the HOW. Never lazy-load the SAFETY.**
 *
 * If the model must CHOOSE to load an instruction, it can fail to choose — and
 * then it acts without knowing the rule, silently. A safety constraint living in
 * a fetchable document is a safety constraint that is sometimes simply absent,
 * which is strictly worse than a prompt line that is always present.
 *
 * So this tool serves runbook sections — endpoints, failure signatures,
 * diagnostic commands. The cost of never loading one is a slower or vaguer
 * answer, which is recoverable.
 *
 * It does NOT serve, and must never serve, the binding safety rules: the viewer
 * gate, the never-restart list, the probe-safety constraints. Those live in
 * `src/safety.ts` and `src/command-gate.ts` as preconditions that hold whether or
 * not the model ever heard of them. **Test to apply before adding anything here:
 * if the model never loads this, what breaks? Wrong answer → belongs here.
 * Something in the world breaks → belongs in code.**
 */

/** Headings the tool will serve, mapped to the section prefix in the source doc. */
const TOPICS: Record<string, string> = {
  'host-access': '## 1.',
  containers: '## 2.',
  endpoints: '## 3.',
  credentials: '## 4.',
  'read-apis': '## 5.',
  'live-tv': '## 6.',
  logs: '## 7.',
};

/**
 * Sections deliberately NOT reachable. Section 8 is Jeff's binding decisions and
 * the probe-safety rules; it is enforced in code and must not be presented as
 * something the model can choose to consult.
 */
const WITHHELD = new Set(['safety', 'decisions', 'rules']);

function extractSection(doc: string, marker: string): string | null {
  const lines = doc.split('\n');
  const start = lines.findIndex((l) => l.startsWith(marker));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}

export function makeRunbookTool(runbookPath: string): Tool {
  return {
    name: 'read_runbook',
    description:
      'Load reference detail for the task at hand: exact service endpoints, container topology, ' +
      'credential locations, the read APIs, live-TV failure signatures, and log locations. ' +
      `Topics: ${Object.keys(TOPICS).join(', ')}. Call this BEFORE guessing at a URL, port, ` +
      'container name or diagnostic command — it is cheaper than a wrong answer.',
    minRole: 'owner',
    writes: false,
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', enum: Object.keys(TOPICS), description: 'Which section to load.' },
      },
      required: ['topic'],
    },
    async run(args) {
      const topic = typeof args['topic'] === 'string' ? args['topic'].trim().toLowerCase() : '';
      if (!topic) return fail(`No topic supplied. Available: ${Object.keys(TOPICS).join(', ')}.`);
      if (WITHHELD.has(topic)) {
        return fail(
          'The safety rules are not a document you consult — they are enforced in code as ' +
            'preconditions on the tools themselves. If an action is unsafe, the tool refuses and ' +
            'tells you why. Proceed and let the tool decide.',
        );
      }
      const marker = TOPICS[topic];
      if (!marker) {
        return fail(`Unknown topic "${topic}". Available: ${Object.keys(TOPICS).join(', ')}.`);
      }
      let doc: string;
      try {
        doc = await readFile(runbookPath, 'utf8');
      } catch (e) {
        return fail(`Could not read the runbook at ${runbookPath}: ${(e as Error).message}`);
      }
      const section = extractSection(doc, marker);
      if (!section) return fail(`Section "${topic}" (${marker}) is not present in the runbook.`);
      // Bounded: one section must never be able to blow the context budget.
      const MAX = 6000;
      return ok(
        section.length > MAX
          ? `${section.slice(0, MAX)}\n\n… [section truncated at ${MAX} characters]`
          : section,
      );
    },
  };
}

export { TOPICS as RUNBOOK_TOPICS };
