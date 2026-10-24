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
  const json = (await res.json()) as { choices: { message: Extract<ChatMessage, { role: 'assistant' }>; finish_reason: string }[] };
  return { message: json.choices[0]!.message, finish: json.choices[0]!.finish_reason };
}
