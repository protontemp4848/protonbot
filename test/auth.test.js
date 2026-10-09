import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TwitchAuth } from '../src/auth.js';
import { recordingLog } from './helpers.js';

const SCOPES = ['chat:edit', 'chat:read'];

/** Fake id.twitch.tv: `tokens` maps access token -> { login, expires_in, scopes }; refresh tokens are single-use. */
function fakeTwitch({ tokens = {}, refresh = {}, pendingPolls = 0, deviceResult = null } = {}) {
  const calls = [];
  let n = 0;
  const issue = (login = 'protonbot') => {
    const t = { access_token: `at${++n}`, refresh_token: `rt${n}` };
    tokens[t.access_token] = { login, expires_in: 14_400, scopes: SCOPES };
    refresh[t.refresh_token] = login;
    return t;
  };
  const fetchImpl = async (url, opts = {}) => {
    const path = new URL(url).pathname;
    const p = Object.fromEntries(opts.body ?? []);
    calls.push({ path, ...p });
    if (path === '/oauth2/validate') {
      const v = tokens[opts.headers.Authorization.replace(/^OAuth /, '')];
      return v ? Response.json({ client_id: 'cid', user_id: '1', ...v }) : Response.json({ status: 401, message: 'invalid access token' }, { status: 401 });
    }
    if (path === '/oauth2/device') return Response.json({ device_code: 'dc', user_code: 'ABCD-EFGH', verification_uri: 'https://www.twitch.tv/activate?device-code=ABCD-EFGH', expires_in: 1800, interval: 5 });
    if (path === '/oauth2/token' && p.grant_type === 'refresh_token') {
      const login = refresh[p.refresh_token];
      if (!login) return Response.json({ error: 'Bad Request', status: 400, message: 'Invalid refresh token' }, { status: 400 });
      delete refresh[p.refresh_token];
      return Response.json(issue(login));
    }
    if (path === '/oauth2/token') {
      if (pendingPolls-- > 0) return Response.json({ status: 400, message: 'authorization_pending' }, { status: 400 });
      if (deviceResult) return Response.json({ status: 400, message: deviceResult }, { status: 400 });
      return Response.json(issue());
    }
    return new Response('?', { status: 404 });
  };
  return { fetchImpl, calls, tokens, refresh, issue };
}

async function setup(api, { stored, ...opts } = {}) {
  const storePath = join(await mkdtemp(join(tmpdir(), 'auth-')), 'sub', 'token.json');
  if (stored) {
    await (await import('node:fs/promises')).mkdir(join(storePath, '..'), { recursive: true });
    await writeFile(storePath, JSON.stringify({ clientId: 'cid', ...stored }));
  }
  const prompts = [];
  const sleeps = [];
  const log = recordingLog();
  let t = 0;
  const auth = new TwitchAuth({ clientId: 'cid', username: 'protonbot', storePath, fetchImpl: api.fetchImpl, sleep: async (ms) => (sleeps.push(ms), (t += ms)), now: () => t, log, prompt: (s) => prompts.push(s), ...opts });
  return { auth, storePath, prompts, sleeps, log, saved: async () => JSON.parse(await readFile(storePath, 'utf8')) };
}

test('first run: device login prints a link and code, polls until authorized, saves tokens with mode 600', async () => {
  const api = fakeTwitch({ pendingPolls: 2 });
  const { auth, prompts, sleeps, saved, storePath, log } = await setup(api);
  assert.equal(await auth.token(), 'at1');
  assert.match(prompts[0], /open https:\/\/www\.twitch\.tv\/activate\?device-code=ABCD-EFGH .* as protonbot and enter code ABCD-EFGH \(expires in 30m\)/);
  assert.deepEqual(sleeps, [5000, 5000, 5000]);
  assert.equal(api.calls.find((c) => c.path === '/oauth2/device').scopes, 'chat:read chat:edit');
  assert.deepEqual(await saved(), { accessToken: 'at1', refreshToken: 'rt1', login: 'protonbot', clientId: 'cid' });
  assert.equal((await stat(storePath)).mode & 0o777, 0o600);
  assert.deepEqual(log.lines, ['info [auth] logged in as protonbot']);
});

test('a stored token that is still good is reused without any login or refresh', async () => {
  const api = fakeTwitch();
  const t = api.issue();
  const { auth, prompts, log } = await setup(api, { stored: { accessToken: t.access_token, refreshToken: t.refresh_token } });
  assert.equal(await auth.token(), 'at1');
  assert.deepEqual(api.calls.map((c) => c.path), ['/oauth2/validate']);
  assert.equal(prompts.length, 0);
  assert.deepEqual(log.lines, ['info [auth] stored token ok (4.0h left) as protonbot']);
});

test('an expired or nearly expired token is refreshed, and the new single-use refresh token is saved', async () => {
  for (const tokens of [{}, { old: { login: 'protonbot', expires_in: 60, scopes: SCOPES } }]) {
    const api = fakeTwitch({ tokens, refresh: { rtOld: 'protonbot' } });
    const { auth, prompts, saved } = await setup(api, { stored: { accessToken: 'old', refreshToken: 'rtOld' } });
    assert.equal(await auth.token(), 'at1');
    assert.equal(prompts.length, 0);
    assert.deepEqual(await saved(), { accessToken: 'at1', refreshToken: 'rt1', login: 'protonbot', clientId: 'cid' });
    assert.equal(api.calls.find((c) => c.grant_type === 'refresh_token').client_secret, undefined, 'public apps send no secret');
  }
});

test('a dead refresh token falls back to device login; without interactive it throws instead', async () => {
  const api = fakeTwitch();
  const quiet = await setup(api, { stored: { accessToken: 'old', refreshToken: 'used' } });
  await assert.rejects(quiet.auth.token({ interactive: false }), /could not be refreshed; run `npm run auth`/);
  assert.equal(quiet.prompts.length, 0);
  assert.ok(quiet.log.lines.some((l) => /refresh failed \(Twitch \/token HTTP 400: Invalid refresh token\)/.test(l)));
  const loud = await setup(api, { stored: { accessToken: 'old', refreshToken: 'used' } });
  assert.equal(await loud.auth.token(), 'at1');
  assert.equal(loud.prompts.length, 1);
});

test('a token for the wrong account, missing scopes, or from another app is not used', async () => {
  const api = fakeTwitch({ tokens: { streamer: { login: 'dudley', expires_in: 9999, scopes: SCOPES }, noscope: { login: 'protonbot', expires_in: 9999, scopes: [] } } });
  await assert.rejects((await setup(api, { stored: { accessToken: 'streamer' } })).auth.token(), /token is for "dudley" but TWITCH_BOT_USERNAME is "protonbot".*--login/);
  const noscope = await setup(api, { stored: { accessToken: 'noscope', refreshToken: 'x' } });
  assert.equal(await noscope.auth.token(), 'at1');
  assert.equal(noscope.prompts.length, 1, 'missing scopes means a new login, not a refresh');
  const other = await setup(api, { stored: { accessToken: 'streamer', clientId: 'other-app' } });
  await other.auth.token();
  assert.equal(other.prompts.length, 1);
});

test('forceLogin skips the stored token; a denied login, a timeout, and concurrent calls are handled', async () => {
  const api = fakeTwitch();
  const t = api.issue();
  const forced = await setup(api, { stored: { accessToken: t.access_token } });
  await forced.auth.token({ forceLogin: true });
  assert.equal(forced.prompts.length, 1);
  await assert.rejects((await setup(fakeTwitch({ deviceResult: 'access_denied' }))).auth.token(), /device login failed: access_denied/);
  await assert.rejects((await setup(fakeTwitch({ pendingPolls: Infinity }))).auth.token(), /timed out/);
  const once = fakeTwitch();
  const { auth } = await setup(once);
  assert.deepEqual(await Promise.all([auth.token(), auth.token()]), ['at1', 'at1']);
  assert.equal(once.calls.filter((c) => c.path === '/oauth2/device').length, 1);
});
