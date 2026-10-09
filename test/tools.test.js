import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../src/bot.js';
import { runTool, toolName, wikiTool } from '../src/tools.js';
import { WIKIS } from '../src/wikis.js';
import { recordingLog } from './helpers.js';

const call = (args, name = 'lookup_nightreign_wiki') => ({ id: 'c1', type: 'function', function: { name, arguments: args } });
const ctx = (log = recordingLog()) => ({ log, now: () => 0, tag: ' #1' });
const nightreign = (wiki) => wikiTool({ id: 'nightreign', ...WIKIS.nightreign, wiki });

test('every registered wiki makes a valid tool named lookup_<id>_wiki', () => {
  for (const [id, w] of Object.entries(WIKIS)) {
    const t = wikiTool({ id, ...w, wiki: {} });
    assert.equal(toolName(t), `lookup_${id}_wiki`);
    assert.match(t.definition.function.description, new RegExp(w.game));
    assert.deepEqual(t.definition.function.parameters.required, ['query']);
    assert.match(t.rule, new RegExp(`ALWAYS call lookup_${id}_wiki`));
    assert.match(w.baseUrl, /^https:\/\/[^/]+[^/]$/, 'baseUrl is an https root without a trailing slash');
  }
});

test('a found page is returned as JSON content plus a citable source', async () => {
  const page = { title: 'Wylder', url: 'https://w/Wylder', text: 'A Nightfarer.', otherResults: [] };
  const log = recordingLog();
  const out = await runTool(call('{"query":"Wylder"}'), [nightreign({ lookup: async (q) => (q === 'Wylder' ? page : null) })], ctx(log));
  assert.deepEqual(out, { content: JSON.stringify(page), source: { title: 'Wylder', url: 'https://w/Wylder' } });
  assert.deepEqual(log.lines, ['info [wiki:nightreign] #1 "Wylder" -> Wylder (13 chars, 0ms) https://w/Wylder', 'debug [wiki:nightreign] #1 text: A Nightfarer.']);
});

test('calls are routed to the right wiki by tool name', async () => {
  const hit = (title) => ({ lookup: async () => ({ title, url: `https://${title}`, text: '', otherResults: [] }) });
  const tools = [nightreign(hit('nr')), wikiTool({ id: 'eldenring', game: 'Elden Ring', site: 'Fextralife', covers: 'x', askAbout: 'y', examples: ['Malenia'], wiki: hit('er') })];
  assert.equal((await runTool(call('{"query":"a"}', 'lookup_eldenring_wiki'), tools, ctx())).source.title, 'er');
  assert.equal((await runTool(call('{"query":"a"}', 'lookup_nightreign_wiki'), tools, ctx())).source.title, 'nr');
  const prompt = buildSystemPrompt({ botName: 'b', channel: 'c', personality: '', docText: 'd', tools });
  assert.match(prompt, /ALWAYS call lookup_nightreign_wiki/);
  assert.match(prompt, /about Elden Ring gameplay \(y\), ALWAYS call lookup_eldenring_wiki/);
  assert.match(prompt, /the reference document and the wikis both failed/);
});

test('no page, a failing wiki, bad arguments, a throwing tool and unknown tools give a message, never a throw', async () => {
  assert.deepEqual(await runTool(call('{"query":"x"}'), [nightreign({ lookup: async () => null })], ctx()), { content: 'No wiki page found for "x".' });
  const down = [nightreign({ lookup: async () => { throw new Error('wiki HTTP 503'); } })];
  assert.match((await runTool(call('{"query":"x"}'), down, ctx())).content, /^Wiki lookup failed \(wiki HTTP 503\)/);
  for (const bad of ['{not json', 'null', '5', '[]']) {
    assert.equal((await runTool(call(bad), down, ctx())).content, 'Invalid arguments for lookup_nightreign_wiki: expected a JSON object.', bad);
  }
  const broken = { definition: { function: { name: 'broken' } }, run: async () => { throw new Error('kaboom'); } };
  assert.equal((await runTool(call('{}', 'broken'), [broken], ctx())).content, 'broken failed (kaboom). Answer without it.');
  const log = recordingLog();
  assert.deepEqual(await runTool(call('{}', 'rm_rf'), down, ctx(log)), { content: 'Unknown tool: rm_rf' });
  assert.deepEqual(log.lines, ['warn [bot] #1 LLM called unknown tool rm_rf']);
});
