import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocCache, toExportUrl } from '../src/docCache.js';
import { silentLog } from './helpers.js';

const URL_ = 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit?usp=sharing';
const textRes = (body) => new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });

const setup = async (fetchImpl, opts = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'protonbot-'));
  let t = 1_000_000;
  const cache = new DocCache({ url: URL_, ttlMs: 60_000, cachePath: join(dir, 'doc.txt'), fetchImpl, now: () => t, log: silentLog, ...opts });
  return { cache, dir, advance: (ms) => (t += ms) };
};

test('toExportUrl converts share links and rejects junk', () => {
  assert.equal(toExportUrl(URL_), 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/export?format=txt');
  assert.throws(() => toExportUrl('https://example.com/foo'), /Not a Google Doc/);
});

test('fetches once, serves from memory within TTL, refetches after TTL', async () => {
  let calls = 0;
  const { cache, advance } = await setup(async () => textRes(`﻿version ${++calls}`));
  assert.equal(await cache.get(), 'version 1');
  advance(59_000);
  assert.equal(await cache.get(), 'version 1');
  assert.equal(calls, 1);
  advance(2_000);
  assert.equal(await cache.get(), 'version 2');
  assert.equal(calls, 2);
});

test('concurrent gets share one fetch', async () => {
  let calls = 0;
  const { cache } = await setup(async () => (calls++, textRes('x')));
  await Promise.all([cache.get(), cache.get(), cache.get()]);
  assert.equal(calls, 1);
});

test('writes to disk, and a fresh process fetches the latest doc instead of trusting a recent disk copy', async () => {
  const { cache, dir } = await setup(async () => textRes('from google'));
  await cache.get();
  assert.equal(await readFile(join(dir, 'doc.txt'), 'utf8'), 'from google');

  let calls = 0;
  const second = new DocCache({ url: URL_, ttlMs: 60_000, cachePath: join(dir, 'doc.txt'), fetchImpl: async () => (calls++, textRes('edited doc')), log: silentLog });
  assert.equal(await second.get(), 'edited doc', 'restart picks up doc edits even though the disk copy is seconds old');
  assert.equal(calls, 1);
  assert.equal(await second.get(), 'edited doc');
  assert.equal(calls, 1, 'then cached in memory for the TTL as before');
  assert.equal(await readFile(join(dir, 'doc.txt'), 'utf8'), 'edited doc', 'disk copy updated');
});

test('on restart with Google down, a recent disk copy is used and Google is not retried until the TTL passes', async () => {
  const { cache, dir } = await setup(async () => textRes('from google'));
  await cache.get();

  let calls = 0;
  let t = 5_000_000;
  const log = { ...silentLog, warns: [], warn(m) { this.warns.push(m); } };
  const second = new DocCache({ url: URL_, ttlMs: 60_000, cachePath: join(dir, 'doc.txt'), fetchImpl: async () => (calls++, new Response('', { status: 500 })), now: () => t, log });
  assert.equal(await second.get(), 'from google');
  assert.match(log.warns[0], /refresh failed \(HTTP 500\), using stale cache/);
  await second.get();
  assert.equal(calls, 1, 'no retry within the TTL');
  t += 61_000;
  await second.get();
  assert.equal(calls, 2, 'retried after the TTL');
});

test('expired disk cache is refetched; on fetch failure the stale copy is served', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'protonbot-'));
  const p = join(dir, 'doc.txt');
  await writeFile(p, 'stale copy');
  const old = new Date(Date.now() - 3_600_000);
  await utimes(p, old, old);
  const cache = new DocCache({ url: URL_, ttlMs: 60_000, cachePath: p, fetchImpl: async () => { throw new Error('network down'); }, log: silentLog });
  assert.equal(await cache.get(), 'stale copy');
});

test('a private doc (Google returns sign-in HTML) gives a clear error', async () => {
  const { cache } = await setup(async () => new Response('<html>Sign in</html>', { headers: { 'content-type': 'text/html' } }));
  await assert.rejects(cache.get(), /not shared as "Anyone with the link can view"/);
});

test('huge docs are truncated to maxChars', async () => {
  const { cache } = await setup(async () => textRes('a'.repeat(100)), { maxChars: 10 });
  assert.equal((await cache.get()).length, 10);
});

test('no URL configured returns empty context', async () => {
  const cache = new DocCache({ url: null, ttlMs: 1, cachePath: '/nonexistent', log: silentLog });
  assert.equal(await cache.get(), '');
});

test('reload fetches now, inside the TTL, says whether the doc changed, and resets the TTL', async () => {
  const versions = ['v1', 'v2', 'v2'];
  let calls = 0;
  const { cache, advance } = await setup(async () => (calls++, textRes(versions.shift())));
  assert.equal(await cache.get(), 'v1');
  advance(10_000); // well inside the 60s TTL
  assert.deepEqual(await cache.reload(), { text: 'v2', changed: true });
  assert.equal(await cache.get(), 'v2', 'get serves the reloaded text');
  assert.equal(calls, 2);
  advance(59_000); // 69s since the first fetch but 59s since the reload: still cached
  assert.equal(await cache.get(), 'v2');
  assert.equal(calls, 2);
  assert.deepEqual(await cache.reload(), { text: 'v2', changed: false });
});

test('a failed reload throws and keeps serving the copy it had', async () => {
  let up = true;
  const { cache } = await setup(async () => (up ? textRes('good copy') : new Response('', { status: 503 })));
  assert.equal(await cache.get(), 'good copy');
  up = false;
  await assert.rejects(cache.reload(), /HTTP 503/);
  assert.equal(await cache.get(), 'good copy');
  const none = new DocCache({ url: null, log: silentLog });
  await assert.rejects(none.reload(), /no GOOGLE_DOC_URL/);
});
