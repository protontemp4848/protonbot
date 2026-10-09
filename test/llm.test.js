import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GrokClient } from '../src/llm.js';
import { recordingLog, silentLog } from './helpers.js';

test('GrokClient sends an OpenAI-style request to xAI and returns the content', async () => {
  let req;
  const fetchImpl = async (url, init) => {
    req = { url, ...init, body: JSON.parse(init.body) };
    return Response.json({ choices: [{ message: { role: 'assistant', content: '  hello!  ' } }] });
  };
  const c = new GrokClient({ apiKey: 'xai-test', model: 'grok-4', fetchImpl });
  assert.equal(await c.chat([{ role: 'user', content: 'hi' }]), 'hello!');
  assert.equal(req.url, 'https://api.x.ai/v1/chat/completions');
  assert.equal(req.headers.Authorization, 'Bearer xai-test');
  assert.equal(req.body.model, 'grok-4');
  assert.deepEqual(req.body.messages, [{ role: 'user', content: 'hi' }]);
});

test('GrokClient surfaces API errors', async () => {
  const c = new GrokClient({ apiKey: 'k', model: 'm', fetchImpl: async () => new Response('bad key', { status: 401 }) });
  await assert.rejects(c.chat([]), /xAI API 401 after [\d.]+s: bad key/);
});

test('GrokClient.complete sends tools and returns tool calls', async () => {
  let body;
  const toolCalls = [{ id: 'c1', type: 'function', function: { name: 'lookup_nightreign_wiki', arguments: '{"query":"Wylder"}' } }];
  const fetchImpl = async (_url, init) => ((body = JSON.parse(init.body)), Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: toolCalls } }] }));
  const c = new GrokClient({ apiKey: 'k', model: 'grok-4', fetchImpl });
  const tools = [{ type: 'function', function: { name: 'lookup_nightreign_wiki', parameters: { type: 'object' } } }];
  const out = await c.complete([{ role: 'user', content: 'hi' }], { tools });
  assert.deepEqual(body.tools, tools);
  assert.deepEqual(out.tool_calls, toolCalls);
  await c.complete([]);
  assert.equal('tools' in body, false, 'no tools key when none are offered');
});

test('GrokClient logs model, time, tokens and what came back, tagged with the request id', async () => {
  const log = recordingLog();
  let t = 0;
  const replies = [
    { model: 'grok-4-0709', usage: { prompt_tokens: 812, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 30 } }, choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'lookup_nightreign_wiki', arguments: '{"query":"Wylder"}' } }] } }] },
    { choices: [{ message: { role: 'assistant', content: 'hello there' } }] },
  ];
  const fetchImpl = async () => ((t += 2_340), Response.json(replies.shift()));
  const c = new GrokClient({ apiKey: 'k', model: 'grok-4', fetchImpl, now: () => t, log });
  await c.complete([{ role: 'system', content: 'abc' }, { role: 'user', content: 'hi' }], { tools: [{}], tag: ' #7 r1' });
  await c.complete([], { tag: ' #7 r2' });
  assert.deepEqual(log.lines, [
    'debug [llm] #7 r1 request: 2 messages, 5 chars, tools=yes',
    'info [llm] #7 r1 grok-4-0709 2.34s tokens in=812 out=40 (reasoning 30) -> tool calls: lookup_nightreign_wiki({"query":"Wylder"})',
    'debug [llm] #7 r2 request: 0 messages, 0 chars, tools=no',
    'info [llm] #7 r2 grok-4 2.34s tokens n/a -> answer (11 chars)',
  ]);
});

test('GrokClient totals token usage across calls for !stats, counting calls that report none', async () => {
  const replies = [
    { usage: { prompt_tokens: 800, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 30 } }, choices: [{ message: { content: 'a' } }] },
    { usage: { prompt_tokens: 1200, completion_tokens: 10 }, choices: [{ message: { content: 'b' } }] },
    { choices: [{ message: { content: 'c' } }] },
  ];
  const c = new GrokClient({ apiKey: 'k', model: 'm', fetchImpl: async () => Response.json(replies.shift()), log: silentLog });
  assert.deepEqual(c.usage, { calls: 0, tokensIn: 0, tokensOut: 0, reasoning: 0, unreported: 0 });
  for (let i = 0; i < 3; i++) await c.complete([]);
  assert.deepEqual(c.usage, { calls: 3, tokensIn: 2000, tokensOut: 50, reasoning: 30, unreported: 1 });
});
