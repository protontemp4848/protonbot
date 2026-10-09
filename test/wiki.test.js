import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, NightreignWiki } from '../src/wiki.js';
import { silentLog } from './helpers.js';

/** Fake MediaWiki API: `opensearch`/`title`/`text` are arrays of titles, `pages` maps title -> HTML. */
function fakeApi({ opensearch = [], title = [], text = [], pages = {}, redirects = {} }) {
  const requests = [];
  const fetchImpl = async (url) => {
    const p = new URL(url).searchParams;
    requests.push(Object.fromEntries(p));
    const hits = (ts) => Response.json({ query: { search: ts.map((t) => ({ title: t })) } });
    if (p.get('action') === 'opensearch') return Response.json([p.get('search'), opensearch, [], []]);
    if (p.get('list') === 'search') return hits(p.get('srwhat') === 'title' ? title : text);
    if (p.get('action') === 'parse') {
      const t = redirects[p.get('page')] ?? p.get('page');
      return t in pages ? Response.json({ parse: { title: t, text: pages[t] } }) : Response.json({ error: { code: 'missingtitle', info: "The page you specified doesn't exist." } });
    }
    return new Response('?', { status: 400 });
  };
  return { fetchImpl, requests };
}

const wiki = (api, opts = {}) => new NightreignWiki({ fetchImpl: api.fetchImpl, log: silentLog, ...opts });

test('htmlToText strips markup, scripts and entities but keeps structure', () => {
  const html = '<style>.x{}</style><h2>Gladius</h2><p>Weak to <a href="/Holy">Holy</a> &amp; <b>Sleep</b>&nbsp;!</p><table><tr><td>HP</td><td>17,558</td></tr></table><script>alert(1)</script><!-- c --><ul><li>A</li><li>B&#39;s &#x2014; ok</li></ul>';
  assert.equal(htmlToText(html), "Gladius\nWeak to Holy & Sleep !\nHP | 17,558\nA\nB's — ok");
});

test('an exact title match beats earlier prefix results, and page text + URL are returned', async () => {
  const api = fakeApi({
    opensearch: ['Night Aspect Relic'],
    title: ['Night Aspect', 'Night Aspect Relic'],
    pages: { 'Night Aspect': '<p>The final Nightlord.</p>' },
  });
  const r = await wiki(api).lookup('night aspect');
  assert.deepEqual(r, {
    title: 'Night Aspect',
    url: 'https://eldenringnightreign.wiki.fextralife.com/Night_Aspect',
    text: 'The final Nightlord.',
    otherResults: ['Night Aspect Relic'],
  });
  assert.equal(api.requests.filter((q) => q.srwhat === 'text').length, 0, 'full-text search only as a fallback');
});

test('falls back to full-text search when no titles match, and dedupes case-variant pages', async () => {
  const api = fakeApi({ text: ['Gladius (Enemy)', 'Gladius (enemy)', 'Tricephalos'], pages: { 'Gladius (Enemy)': '<p>x</p>' } });
  const r = await wiki(api).lookup('three headed wolf');
  assert.equal(r.title, 'Gladius (Enemy)');
  assert.equal(r.url, 'https://eldenringnightreign.wiki.fextralife.com/Gladius_(Enemy)');
  assert.deepEqual(r.otherResults, ['Tricephalos']);
});

test('redirected pages report the resolved title and do not list it as another result', async () => {
  const api = fakeApi({ title: ['Fulghor', 'Fulghor Champion of Nightglow'], redirects: { Fulghor: 'Fulghor Champion of Nightglow' }, pages: { 'Fulghor Champion of Nightglow': '<p>Nightlord</p>' } });
  const r = await wiki(api).lookup('Fulghor');
  assert.equal(r.title, 'Fulghor Champion of Nightglow');
  assert.deepEqual(r.otherResults, []);
});

test('no results returns null; empty query does not hit the network', async () => {
  const api = fakeApi({});
  assert.equal(await wiki(api).lookup('zzqqxx'), null);
  const before = api.requests.length;
  assert.equal(await wiki(api).lookup('   '), null);
  assert.equal(api.requests.length, before);
});

test('long pages are truncated to maxChars', async () => {
  const api = fakeApi({ title: ['Wylder'], pages: { Wylder: `<p>${'a'.repeat(500)}</p>` } });
  const r = await wiki(api, { maxChars: 100 }).lookup('Wylder');
  assert.equal(r.text, 'a'.repeat(100) + '\n[truncated]');
});

test('results (including misses) are cached per query until the TTL expires', async () => {
  const api = fakeApi({ title: ['Wylder'], pages: { Wylder: '<p>hi</p>' } });
  let t = 0;
  const w = wiki(api, { ttlMs: 1000, now: () => t });
  await w.lookup('Wylder');
  const n = api.requests.length;
  await w.lookup('  wylder ');
  await w.lookup('nothing');
  const n2 = api.requests.length;
  await w.lookup('nothing');
  assert.equal(api.requests.length, n2, 'misses are cached too');
  assert.equal(n2 - n, 3, 'only the new query hit the network');
  t = 1001;
  await w.lookup('Wylder');
  assert.ok(api.requests.length > n2, 'refetched after TTL');
});

test('cache is bounded', async () => {
  const api = fakeApi({});
  const w = wiki(api, { maxEntries: 2 });
  for (const q of ['a', 'b', 'c']) await w.lookup(q);
  assert.deepEqual([...w.cache.keys()], ['b', 'c']);
});

test('HTTP and API errors are thrown, not swallowed (the bot reports them to the LLM)', async () => {
  await assert.rejects(new NightreignWiki({ fetchImpl: async () => new Response('', { status: 503 }), log: silentLog }).lookup('x'), /wiki HTTP 503/);
  const api = fakeApi({ title: ['Gone'] });
  await assert.rejects(wiki(api).lookup('Gone'), /wiki API: The page you specified/);
});
