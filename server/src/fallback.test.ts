/** The Claude fallback, with fetch replaced: no network, no spend. Run with: pnpm test */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { config as frozen } from './config.js';
import { chat, lastModelProvider, modelSpend, resetModelSpend, type ChatMessage } from './model.js';
import { claudeSchema, toMessages } from './anthropic.js';

const config = frozen as unknown as { model: { apiKey?: string }; fallback: { apiKey?: string } };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  config.model.apiKey = undefined;
  config.fallback.apiKey = undefined;
  resetModelSpend();
});

test('a spent OpenAI credit falls through to Claude, tool calls come back in the OpenAI shape', async () => {
  config.model.apiKey = 'sk-test';
  config.fallback.apiKey = 'sk-ant-test';
  const sent: { host: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const host = new URL(String(url)).host;
    sent.push({ host, body: JSON.parse(String(init?.body)) });
    if (host === 'api.openai.com') return new Response('{"error":{"code":"insufficient_quota"}}', { status: 429 });
    return new Response(JSON.stringify({
      content: [{ type: 'text', text: 'Looking it up.' }, { type: 'tool_use', id: 'toolu_1', name: 'get_order', input: { id: 'O-1' } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1000, output_tokens: 100 },
    }), { status: 200 });
  }) as typeof fetch;

  const out = await chat({
    model: 'gpt-4.1',
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'get_order', description: 'd', parameters: { type: 'object', properties: {} } } }],
  });
  assert.deepEqual(sent.map((s) => s.host), ['api.openai.com', 'api.anthropic.com']);
  assert.equal(sent[1]!.body.system, 'sys');
  assert.equal(out.finish, 'tool_calls');
  assert.equal(out.message.content, 'Looking it up.');
  assert.deepEqual(out.message.tool_calls, [{ id: 'toolu_1', type: 'function', function: { name: 'get_order', arguments: '{"id":"O-1"}' } }]);
  assert.equal(lastModelProvider(), 'anthropic');
  assert.equal(modelSpend().usd, (1000 * 0.1 + 100 * 0.5) / 1e6);

  // Inside the cooldown OpenAI is not asked again.
  sent.length = 0;
  await chat({ model: 'gpt-4.1', messages: [{ role: 'user', content: 'again' }] });
  assert.deepEqual(sent.map((s) => s.host), ['api.anthropic.com']);
});

test('without a Claude key an OpenAI failure surfaces as before', async () => {
  config.model.apiKey = 'sk-test';
  globalThis.fetch = (async () => new Response('down', { status: 503 })) as typeof fetch;
  await assert.rejects(chat({ model: 'gpt-4.1', messages: [{ role: 'user', content: 'x' }] }), /OpenAI 503/);
});

test('a run of tool results becomes one user turn after the assistant turn that asked', () => {
  const msgs: ChatMessage[] = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'u' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'call_a', type: 'function', function: { name: 'x', arguments: '{}' } },
      { id: 'call_b', type: 'function', function: { name: 'y', arguments: '{"k":1}' } },
    ] },
    { role: 'tool', tool_call_id: 'call_a', content: 'A' },
    { role: 'tool', tool_call_id: 'call_b', content: 'B' },
  ];
  const { system, turns } = toMessages(msgs);
  assert.equal(system, 's');
  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant', 'user']);
  assert.equal(turns[2]!.content.length, 2);
});

test('numeric bounds and item counts are dropped from the schema Claude receives', () => {
  const s = claudeSchema({ type: 'object', additionalProperties: false, required: ['n', 'xs'], properties: {
    n: { type: 'number', minimum: 0, maximum: 100 }, xs: { type: 'array', maxItems: 6, items: { type: 'string' } } } });
  assert.deepEqual(s.properties, { n: { type: 'number' }, xs: { type: 'array', items: { type: 'string' } } });
});
