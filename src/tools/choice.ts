import { fail, ok, type Tool } from './types.js';

/**
 * Turn a person's pick back into the thing that was offered.
 *
 * ── 🔴 WHY THE STORE IS NOT A PARSER ─────────────────────────────────────────
 *
 * The user writes *"the first one"*, *"Number 1 is great"*, *"let's do the 2022
 * one"*. **The model reads that and calls this with an integer.** Nothing here
 * parses prose — an ordinal extracted from English by code is the same mistake
 * as a media type guessed from English by code, and we measured that one: the
 * hand-rolled version inverted negation.
 *
 * ── AND WHY THERE IS NO `present_options` TOOL ───────────────────────────────
 *
 * The tool that PRODUCES a list stores it. Asking the model to call a second
 * tool to record what it just received would be bookkeeping we rely on it to
 * remember, and forgetting would be **silent** — the list simply would not be
 * there next turn, which is exactly V1's failure. A side effect of the search
 * cannot be forgotten.
 */
export const resolveChoice: Tool = {
  name: 'resolve_choice',
  description:
    'Map a person\'s pick from a numbered list back to what was offered. Call this whenever they ' +
    'answer a list with a number or an ordinal — "1", "the first one", "the 2022 one". You work out ' +
    'which number they meant; this returns what that option actually was. If it says the list is ' +
    'gone or the number is out of range, ASK — never guess which one they meant.',
  minRole: 'guest',
  writes: false,
  // The generic resolver: it maps an ordinal back to whatever was offered and
  // genuinely does not care what kind that was. The only legitimate '*'.
  consumesChoiceKind: '*',
  parameters: {
    type: 'object',
    properties: {
      choice: { type: 'number', description: 'The 1-based option they picked.' },
    },
    required: ['choice'],
  },
  async run(args, ctx) {
    const n = Number(args['choice']);
    if (!Number.isFinite(n)) return fail('A choice number is required.');
    if (!ctx.choices) return fail('No option store is available, so nothing can be resolved.');

    const r = ctx.choices.resolve(ctx.senderHandle, n);
    if (!r.ok) {
      // Every failure path re-asks. B37: a lost pick cache must never fabricate.
      return fail(`${r.reason.toUpperCase()} — ${r.detail}`);
    }
    return ok(
      `OPTION ${r.option.n} of the list about "${r.choice.subject}" is: ${r.option.label}. ` +
        `Use these values: ${JSON.stringify(r.option.value)}`,
    );
  },
};
