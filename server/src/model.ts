import * as z from 'zod/v4';
import { config } from './config.js';

/**
 * The two model calls Interlock makes, over OpenAI's Chat Completions HTTP API with no SDK:
 * a tool-calling loop for the agent, and one strict-schema call per proposal for risk.
 */

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

/** A failed call, with the HTTP status so a caller can say which kind of failure it was. */
export class ModelError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * JSON schema for a zod type in the form OpenAI's strict mode accepts: every object closed,
 * every key required. Optional values are expressed as nullable in the zod type instead.
 */
export function strictSchema(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema) as Record<string, unknown>;
  delete out.$schema;
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    // String length limits are not part of what strict mode accepts; callers trim instead
    delete n.minLength;
    delete n.maxLength;
    if (n.type === 'object' && n.properties && typeof n.properties === 'object') {
      n.additionalProperties = false;
      n.required = Object.keys(n.properties);
    }
    for (const v of Object.values(n)) Array.isArray(v) ? v.forEach(walk) : walk(v);
  };
  walk(out);
  return out;
}

/**
 * What a million tokens cost, in US dollars, per model. Only the models this demo can
 * actually be pointed at are listed; anything else is billed at the most expensive
 * entry here, because guessing low on a meter that guards a credit card is the one
 * direction that cannot be corrected afterwards.
 */
const PRICES: Record<string, { input: number; output: number }> = {
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
};
const DEAREST = Object.values(PRICES).reduce((a, b) => (b.output > a.output ? b : a));

function priceOf(model: string): { input: number; output: number } {
  if (PRICES[model]) return PRICES[model]!;
  // Dated snapshots ("gpt-4.1-2025-04-14") cost what the family costs.
  const family = Object.keys(PRICES)
    .filter((name) => model.startsWith(name))
    .sort((a, b) => b.length - a.length)[0];
  return family ? PRICES[family]! : DEAREST;
}

let meter = { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 };

/**
 * What this process has spent on the model so far. Read by the budget check in front of
 * an agent run, and by /api/health so the number is visible rather than guessed.
 *
 * It counts what OpenAI reported, not an estimate of the prompt: a run whose tool
 * results came back large costs what it costs, and a run-counter cannot see that.
 */
export function modelSpend(): Readonly<typeof meter> {
  return { ...meter, usd: Math.round(meter.usd * 1e6) / 1e6 };
}

/** Test seam: forget what has been spent. Not reachable over HTTP. */
export function resetModelSpend(): void {
  meter = { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 };
}

export async function chat(body: {
  model: string;
  messages: ChatMessage[];
  tools?: { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }[];
  response_format?: { type: 'json_schema'; json_schema: { name: string; schema: Record<string, unknown>; strict: true } };
  max_completion_tokens?: number;
}): Promise<{ message: Extract<ChatMessage, { role: 'assistant' }>; finish: string }> {
  if (!config.model.apiKey) throw new ModelError(0, 'OPENAI_API_KEY is not set');
  const res = await fetch(`${config.model.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.model.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new ModelError(res.status, `OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as {
    choices: { message: Extract<ChatMessage, { role: 'assistant' }>; finish_reason: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  // Metering happens here because this is the only place that sees what a call cost.
  // A call whose usage is missing still counted against the card, so it is counted at
  // the ceiling the request itself set rather than at zero.
  const input = json.usage?.prompt_tokens ?? 0;
  const output = json.usage?.completion_tokens ?? body.max_completion_tokens ?? 0;
  const price = priceOf(body.model);
  meter.calls += 1;
  meter.inputTokens += input;
  meter.outputTokens += output;
  meter.usd += (input * price.input + output * price.output) / 1_000_000;
  return { message: json.choices[0]!.message, finish: json.choices[0]!.finish_reason };
}
