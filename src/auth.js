import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const OAUTH = 'https://id.twitch.tv/oauth2';
const SCOPES = ['chat:read', 'chat:edit'];
const MIN_LEFT_S = 15 * 60; // refresh a token that expires sooner than this, so it doesn't die mid-session

/**
 * Gets the bot a Twitch user token with chat scopes and keeps it fresh, using the Device Code flow:
 * no redirect server, just "open this link and enter this code" once. After that, refresh tokens keep it going.
 * Tokens are stored in `storePath` (default .cache/twitch-token.json, mode 600), never in .env.
 */
export class TwitchAuth {
  constructor({
    clientId,
    clientSecret = null, // only for apps registered as "Confidential"; "Public" apps refresh without it
    username = null,
    storePath = '.cache/twitch-token.json',
    fetchImpl = globalThis.fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = Date.now,
    log = console,
    prompt = (text) => log.info(text),
  }) {
    Object.assign(this, { clientId, clientSecret, username, storePath, fetchImpl, sleep, now, log, prompt });
    this.inflight = null;
  }

  /**
   * Resolves to a valid access token: the stored one if it's still good, else a refreshed one, else (if
   * `interactive`) one from a new device login. `forceLogin` skips straight to the device login.
   */
  token({ interactive = true, forceLogin = false } = {}) {
    this.inflight ??= this.#ensure({ interactive, forceLogin }).finally(() => (this.inflight = null));
    return this.inflight;
  }

  async #ensure({ interactive, forceLogin }) {
    const stored = forceLogin ? null : await this.#load();
    if (stored?.accessToken) {
      const v = await this.#validate(stored.accessToken);
      const left = v && (v.expires_in === 0 ? Infinity : v.expires_in); // 0 = never expires
      if (v && hasScopes(v.scopes) && left > MIN_LEFT_S) return this.#accept(stored, v, `stored token ok (${fmt(left)} left)`);
      if (v && !hasScopes(v.scopes)) this.log.warn(`[auth] stored token lacks ${SCOPES.join('/')}, logging in again`);
      else if (stored.refreshToken) {
        try {
          const fresh = await this.#refresh(stored.refreshToken);
          const fv = await this.#validate(fresh.accessToken);
          if (fv) return this.#accept(fresh, fv, `token refreshed (${fmt(fv.expires_in)} left)`);
        } catch (e) {
          this.log.warn(`[auth] refresh failed (${e.message}), need a new login`);
        }
      }
    }
    if (!interactive) throw new Error('Twitch token expired and could not be refreshed; run `npm run auth`');
    const fresh = await this.#deviceLogin();
    const v = await this.#validate(fresh.accessToken);
    if (!v) throw new Error('Twitch rejected the token it just issued');
    return this.#accept(fresh, v, 'logged in');
  }

  async #accept(tokens, v, what) {
    if (this.username && v.login !== this.username) {
      throw new Error(`Twitch token is for "${v.login}" but TWITCH_BOT_USERNAME is "${this.username}". Run \`npm run auth -- --login\` and log in as ${this.username}.`);
    }
    await this.#save({ ...tokens, login: v.login, clientId: this.clientId });
    this.login = v.login;
    this.log.info(`[auth] ${what} as ${v.login}`);
    return tokens.accessToken;
  }

  async #deviceLogin() {
    const d = await this.#post('/device', { client_id: this.clientId, scopes: SCOPES.join(' ') });
    this.prompt(
      `[auth] To let the bot chat, open ${d.verification_uri} while logged in to Twitch as ${this.username ?? 'the bot account'} and enter code ${d.user_code} (expires in ${fmt(d.expires_in)})`,
    );
    const deadline = this.now() + d.expires_in * 1000;
    let interval = (d.interval || 5) * 1000;
    while (this.now() < deadline) {
      await this.sleep(interval);
      const res = await this.#request('/token', {
        client_id: this.clientId,
        scopes: SCOPES.join(' '),
        device_code: d.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) return tokensFrom(body);
      if (body.message === 'authorization_pending') continue;
      if (body.message === 'slow_down') interval += 5_000;
      else throw new Error(`Twitch device login failed: ${body.message ?? `HTTP ${res.status}`}`);
    }
    throw new Error('Twitch device login timed out; run `npm run auth` to try again');
  }

  async #refresh(refreshToken) {
    const params = { client_id: this.clientId, grant_type: 'refresh_token', refresh_token: refreshToken };
    if (this.clientSecret) params.client_secret = this.clientSecret;
    return tokensFrom(await this.#post('/token', params));
  }

  /** Returns Twitch's validate response, or null if the token is invalid. */
  async #validate(accessToken) {
    const res = await this.fetchImpl(`${OAUTH}/validate`, { headers: { Authorization: `OAuth ${accessToken}` }, signal: AbortSignal.timeout(10_000) });
    if (res.status === 401) return null;
    if (!res.ok) throw new Error(`Twitch validate HTTP ${res.status}`);
    return res.json();
  }

  #request(path, params) {
    return this.fetchImpl(`${OAUTH}${path}`, { method: 'POST', body: new URLSearchParams(params), signal: AbortSignal.timeout(10_000) });
  }

  async #post(path, params) {
    const res = await this.#request(path, params);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Twitch ${path} HTTP ${res.status}: ${body.message ?? 'no message'}`);
    return body;
  }

  async #load() {
    try {
      const s = JSON.parse(await readFile(this.storePath, 'utf8'));
      return s.clientId === this.clientId ? s : null; // tokens from another app can't be refreshed with this one
    } catch {
      return null;
    }
  }

  async #save(s) {
    await mkdir(dirname(this.storePath), { recursive: true });
    await writeFile(this.storePath, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  }
}

/** A TwitchAuth from TWITCH_CLIENT_ID (+ optional TWITCH_CLIENT_SECRET), or null if it isn't set (static token or anonymous). */
export function authFromEnv(env, log) {
  const clientId = env.TWITCH_CLIENT_ID?.trim();
  if (!clientId) return null;
  return new TwitchAuth({
    clientId,
    clientSecret: env.TWITCH_CLIENT_SECRET?.trim() || null,
    username: env.TWITCH_BOT_USERNAME?.trim().toLowerCase() || null,
    storePath: env.TWITCH_TOKEN_PATH || undefined,
    log,
  });
}

const hasScopes = (scopes = []) => SCOPES.every((s) => scopes.includes(s));
const tokensFrom = (b) => ({ accessToken: b.access_token, refreshToken: b.refresh_token ?? null });
const fmt = (s) => (s === Infinity ? 'no expiry' : s >= 3600 ? `${(s / 3600).toFixed(1)}h` : `${Math.round(s / 60)}m`);
