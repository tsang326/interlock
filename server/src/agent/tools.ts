import * as z from 'zod/v4';
import { ACTION_KINDS } from '../core/types.js';
import { callableReads, type PayPalExecutor } from '../paypal/executor.js';
import type { InterlockClient } from './client.js';

/**
 * What the agent can do, which is exactly two things: look, and ask.
 *
 * There is no third tool. The agent cannot execute, approve, edit a rule or touch the
 * audit log, and that is not enforced by a prompt — the token it carries is refused by
 * those routes.
 */

const json = (value: unknown) => JSON.stringify(value, null, 2).slice(0, 6000);

/** A tool the agent can call: its schema is what the model sees, `run` is what happens. */
export type AgentTool = {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  run: (input: never) => Promise<string>;
};
const tool = <S extends z.ZodType>(t: { name: string; description: string; inputSchema: S; run: (input: z.infer<S>) => Promise<string> }): AgentTool =>
  t as unknown as AgentTool;

/**
 * One read tool rather than fifteen. The toolkit already ships a description for each
 * of its tools, written for a model to read, so the catalogue is built from those at
 * startup instead of being restated here and drifting.
 *
 * Only the reads this deployment can answer are listed. Offering the agent a tool that
 * always fails buys nothing but a wasted turn and a confused transcript.
 */
function readCatalogue(paypal: PayPalExecutor): string {
  const lines = callableReads().map((name) => {
    const description = paypal.describe(name)?.split('\n')[0] ?? 'A read-only PayPal call.';
    return `- ${name}: ${description}`;
  });
  return lines.join('\n');
}

export function agentTools(interlock: InterlockClient, paypal: PayPalExecutor) {
  const readPayPal = tool({
    name: 'paypal_read',
    description: [
      'Read something from the merchant\'s PayPal account. These calls return information and move nothing.',
      '',
      'Available tools and what each one needs:',
      readCatalogue(paypal),
      '',
      'Pass the tool name and its parameters. Interlock makes the call with the merchant\'s credentials; you never hold them.',
    ].join('\n'),
    inputSchema: z.object({
      tool: z.string().describe('One of the tool names listed above.'),
      params: z.record(z.string(), z.unknown()).describe('Parameters for that tool, as a JSON object.'),
    }),
    run: async ({ tool, params }) => json(await interlock.readPayPal(tool, params ?? {})),
  });

  const propose = tool({
    name: 'propose_action',
    description: [
      'Ask Interlock to perform an action that moves money. You are not performing it: Interlock decides whether it runs on its own, waits for a human reviewer, or is refused.',
      '',
      `Actions you may propose: ${ACTION_KINDS.join(', ')}.`,
      '',
      'The reply tells you what was decided and why. A proposal that comes back `pending` is waiting on a person and is not a failure — report it as waiting.',
      '',
      'State the amount and counterparty you believe this action affects. Those are recorded and shown to the reviewer beside the figures Interlock reads from the request itself, so state them accurately; a gap between them is treated as a warning sign.',
    ].join('\n'),
    inputSchema: z.object({
      kind: z.enum(ACTION_KINDS),
      params: z
        .record(z.string(), z.unknown())
        .describe('Parameters for the PayPal call, exactly as the PayPal API expects them.'),
      rationale: z.string().max(2000).describe('Why this action is warranted, for the human reviewer.'),
      declaredAmount: z
        .object({ value: z.number(), currency: z.string().length(3) })
        .nullable()
        .describe('What you believe this action is worth, or null if you do not know.'),
      declaredCounterparty: z
        .string()
        .nullable()
        .describe('Who you believe this affects, or null if you do not know.'),
    }),
    run: async (input) =>
      json(
        await interlock.propose({
          kind: input.kind,
          params: input.params,
          rationale: input.rationale,
          sessionId: currentSession,
          declaredAmount: input.declaredAmount ?? undefined,
          declaredCounterparty: input.declaredCounterparty ?? undefined,
        }),
      ),
  });

  return [readPayPal, propose];
}

/**
 * The run this agent belongs to. Every proposal carries it, so one bad run can be
 * traced whole rather than one proposal at a time.
 */
export let currentSession = 'agent-unset';
export function setSession(id: string): void {
  currentSession = id;
}
