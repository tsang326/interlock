import * as z from 'zod/v4';
import { config } from './config.js';
import { anthropicChat } from './anthropic.js';

/**
 * The two model calls Interlock makes, over OpenAI's Chat Completions HTTP API with no SDK:
 * a tool-calling loop for the agent, and one strict-schema call per proposal for risk.
 *
 * When OpenAI cannot answer (credit spent, rate limited, down) and ANTHROPIC_API_KEY is
 * set, the same call goes to Claude over the Messages HTTP API instead (see anthropic.ts).
 * Callers keep speaking the Chat Completions shape either way.
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
  // The fallback models (anthropic.ts), Anthropic list price.
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
};
const DEAREST = Object.values(PRICES).reduce((a, b) => (b.output > a.output ? b : a));

export function priceOf(model: string): { input: number; output: number } {
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
  openaiSkipUntil = 0;
  lastProvider = 'none';
}

/** Adds one call's reported usage to the meter, at the price of the model that answered. */
export function meterCall(model: string, input: number, output: number): void {
  const price = priceOf(model);
  meter.calls += 1;
  meter.inputTokens += input;
  meter.outputTokens += output;
  meter.usd += (input * price.input + output * price.output) / 1_000_000;
}

export type ChatBody = {
  model: string;
  messages: ChatMessage[];
  tools?: { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }[];
  response_format?: { type: 'json_schema'; json_schema: { name: string; schema: Record<string, unknown>; strict: true } };
  max_completion_tokens?: number;
};
export type ChatResult = { message: Extract<ChatMessage, { role: 'assistant' }>; finish: string };

/**
 * After OpenAI fails in a way that will not fix itself on the next call (no credit, a
 * bad key, a rate limit, an outage), it is skipped for this long so the calls in between
 * go straight to Claude instead of paying a failed round trip first.
 */
const OPENAI_COOLDOWN_MS = 10 * 60_000;
let openaiSkipUntil = 0;

/** Which provider answered the most recent call; shown on /api/health. */
let lastProvider: 'openai' | 'anthropic' | 'none' = 'none';
export const lastModelProvider = () => lastProvider;

/**
 * OpenAI first; Claude when OpenAI is not configured, failed, or failed recently. Both
 * are metered on the same meter at their own prices, so the spend ceiling in front of
 * the agent holds whichever one answered.
 */
export async function chat(body: ChatBody): Promise<ChatResult> {
  const fallback = Boolean(config.fallback.apiKey);
  if (config.model.apiKey && Date.now() >= openaiSkipUntil) {
    try {
      const out = await openaiChat(body);
      lastProvider = 'openai';
      return out;
    } catch (error) {
      if (!fallback) throw error;
      const status = error instanceof ModelError ? error.status : 0;
      if (status === 0 || status === 401 || status === 403 || status === 429 || status >= 500) {
        openaiSkipUntil = Date.now() + OPENAI_COOLDOWN_MS;
      }
      console.warn(`[model] OpenAI failed, falling back to Claude: ${String((error as Error).message).slice(0, 200)}`);
    }
  }
  if (!fallback) throw new ModelError(0, 'OPENAI_API_KEY is not set');
  const out = await anthropicChat(body);
  lastProvider = 'anthropic';
  return out;
}

async function openaiChat(body: ChatBody): Promise<ChatResult> {
  let res: Response;
  try {
    res = await fetch(`${config.model.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.model.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  } catch (error) {
    // A timeout or a dropped connection: status 0, which the fallback treats as an outage.
    throw new ModelError(0, `OpenAI unreachable: ${String((error as Error).message).slice(0, 200)}`);
  }
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
  meterCall(body.model, input, output);
  return { message: json.choices[0]!.message, finish: json.choices[0]!.finish_reason };
}
