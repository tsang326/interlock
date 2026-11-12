import { config } from './config.js';
import { meterCall, ModelError, type ChatBody, type ChatMessage, type ChatResult, type ToolCall } from './model.js';

/**
 * The fallback provider: one Chat Completions request, sent to Claude's Messages HTTP API
 * (no SDK, like the OpenAI call), and the answer handed back in the Chat Completions
 * shape, so the agent loop and the risk scorer do not know which one answered.
 *
 * Thinking is off. The agent's history is kept in the OpenAI shape, which has nowhere to
 * keep thinking blocks, and Claude expects earlier thinking to come back unchanged; with
 * thinking off there is nothing to lose between turns. Both jobs are short turns anyway.
 */

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };
type Turn = { role: 'user' | 'assistant'; content: Block[] };

/** Chat Completions messages to Messages API `system` + `messages`. */
export function toMessages(messages: readonly ChatMessage[]): { system: string; turns: Turn[] } {
  const system: string[] = [];
  const turns: Turn[] = [];
  // Consecutive messages of one role become one turn: a run of tool results is one user
  // turn, which is what the Messages API expects after a turn with several tool calls.
  const push = (role: Turn['role'], blocks: Block[]) => {
    if (blocks.length === 0) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else turns.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'system') system.push(m.content);
    else if (m.role === 'user') push('user', [{ type: 'text', text: m.content }]);
    else if (m.role === 'tool') push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }]);
    else {
      const a = m as Extract<ChatMessage, { role: 'assistant' }>;
      const blocks: Block[] = [];
      if (a.content?.trim()) blocks.push({ type: 'text', text: a.content });
      for (const call of a.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(call.function.arguments || '{}');
        } catch {
          // The OpenAI turn sent arguments that were not JSON; the tool already
          // answered with an error, so Claude sees an empty call and that error.
        }
        blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
      }
      push('assistant', blocks);
    }
  }
  return { system: system.join('\n\n'), turns };
}

/**
 * Claude's structured outputs accept the same closed objects as OpenAI's strict mode but
 * not numeric bounds or item counts. The callers already clamp and slice what comes
 * back, so dropping those keywords loses no check.
 */
export function claudeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const out = structuredClone(schema);
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    for (const k of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'maxItems', 'minItems', 'minLength', 'maxLength']) {
      delete n[k];
    }
    for (const v of Object.values(n)) Array.isArray(v) ? v.forEach(walk) : walk(v);
  };
  walk(out);
  return out;
}

const FINISH: Record<string, string> = { end_turn: 'stop', tool_use: 'tool_calls', max_tokens: 'length', stop_sequence: 'stop' };

export async function anthropicChat(body: ChatBody): Promise<ChatResult> {
  const model = config.fallback.model;
  const { system, turns } = toMessages(body.messages);
  const request: Record<string, unknown> = {
    model,
    max_tokens: body.max_completion_tokens ?? 2000,
    thinking: { type: 'disabled' },
    ...(system ? { system } : {}),
    messages: turns,
  };
  if (body.tools?.length) {
    request.tools = body.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
  }
  if (body.response_format) {
    request.output_config = {
      format: { type: 'json_schema', schema: claudeSchema(body.response_format.json_schema.schema) },
    };
  }

  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': config.fallback.apiKey!,
        'anthropic-version': '2026-10-21',
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    throw new ModelError(0, `Anthropic unreachable: ${String((error as Error).message).slice(0, 200)}`);
  }
  if (!res.ok) throw new ModelError(res.status, `Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as {
    content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  // Metered before anything can throw, at the ceiling the request set if usage is missing.
  meterCall(model, json.usage?.input_tokens ?? 0, json.usage?.output_tokens ?? body.max_completion_tokens ?? 0);

  const blocks = json.content ?? [];
  const text = blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
  const toolCalls: ToolCall[] = blocks
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({
      id: b.id!,
      type: 'function' as const,
      function: { name: b.name!, arguments: JSON.stringify(b.input ?? {}) },
    }));
  const stop = json.stop_reason ?? 'end_turn';
  return {
    message: {
      role: 'assistant',
      // A refusal carries no usable answer; an empty reply ends the agent's run and makes
      // the risk scorer fall back to its rule floor, which is what either does on failure.
      content: stop === 'refusal' ? null : text || null,
      ...(toolCalls.length && stop !== 'refusal' ? { tool_calls: toolCalls } : {}),
    },
    finish: FINISH[stop] ?? stop,
  };
}
