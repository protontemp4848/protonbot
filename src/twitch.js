import { EventEmitter } from 'node:events';

const TAG_UNESCAPE = { ':': ';', s: ' ', '\\': '\\', r: '\r', n: '\n' };
const unescapeTag = (v) => v.replace(/\\(.)?/g, (_, c) => (c === undefined ? '' : TAG_UNESCAPE[c] ?? c));

/** Parse one IRCv3 line (with Twitch tags) into { tags, prefix, command, params }. */
export function parseIrc(line) {
  const msg = { tags: {}, prefix: null, command: null, params: [] };
  let rest = line;
  if (rest.startsWith('@')) {
    const i = rest.indexOf(' ');
    for (const kv of rest.slice(1, i).split(';')) {
      const eq = kv.indexOf('=');
      msg.tags[eq < 0 ? kv : kv.slice(0, eq)] = eq < 0 ? '' : unescapeTag(kv.slice(eq + 1));
    }
    rest = rest.slice(i + 1);
  }
  if (rest.startsWith(':')) {
    const i = rest.indexOf(' ');
    msg.prefix = rest.slice(1, i);
    rest = rest.slice(i + 1);
  }
  let trailing = null;
  const t = rest.indexOf(' :');
  if (t >= 0) {
    trailing = rest.slice(t + 2);
    rest = rest.slice(0, t);
  }
  const parts = rest.split(' ').filter(Boolean);
  msg.command = parts.shift() ?? null;
  msg.params = trailing === null ? parts : [...parts, trailing];
  return msg;
}

/**
 * Minimal Twitch chat client over IRC-WebSocket.
 * Events: 'message' ({ id, channel, user, displayName, text, tags }), 'joined', 'error', 'close'.
 */
export class TwitchClient extends EventEmitter {
  /** `token` is a string, or an async function returning one, called on every (re)connect so it can refresh. */
  constructor({ username, token, channel, url = 'wss://irc-ws.chat.twitch.tv:443', WebSocketImpl = globalThis.WebSocket, log = console }) {
    super();
    Object.assign(this, { username, token, channel, url, WebSocketImpl, log });
    this.ws = null;
    this.stopped = false;
    this.backoffMs = 1000;
  }

  connect() {
    this.stopped = false;
    this.log.debug?.(`[twitch] connecting to ${this.url}`);
    const ws = new this.WebSocketImpl(this.url);
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.backoffMs = 1000;
      const login = (token) => {
        this.raw('CAP REQ :twitch.tv/tags twitch.tv/commands');
        this.raw(`PASS ${token ? 'oauth:' + token : 'SCHMOOPIIE'}`);
        this.raw(`NICK ${this.username}`);
        this.raw(`JOIN #${this.channel}`);
      };
      if (typeof this.token !== 'function') return login(this.token);
      this.token().then(login, (e) => {
        this.stopped = true;
        this.emit('error', new Error(`Twitch login failed: ${e.message}`));
        ws.close();
      });
    });
    ws.addEventListener('message', (e) => {
      for (const line of String(e.data).split('\r\n')) if (line) this.#handle(parseIrc(line));
    });
    ws.addEventListener('error', (e) => this.emit('error', e.error ?? new Error('WebSocket error')));
    ws.addEventListener('close', (e) => {
      this.log.debug?.(`[twitch] socket closed${e?.code ? ` (code ${e.code}${e.reason ? `: ${e.reason}` : ''})` : ''}`);
      this.emit('close');
      if (this.ws === ws && !this.stopped) this.#reconnect();
    });
  }

  #reconnect() {
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    this.log.warn(`[twitch] disconnected, reconnecting in ${delay}ms`);
    setTimeout(() => !this.stopped && this.connect(), delay).unref?.();
  }

  #handle(msg) {
    switch (msg.command) {
      case 'PING':
        this.raw(`PONG :${msg.params[0] ?? 'tmi.twitch.tv'}`);
        break;
      case 'RECONNECT':
        this.log.info('[twitch] server asked us to reconnect');
        this.ws?.close();
        break;
      case 'ROOMSTATE':
        this.emit('joined', msg.params[0]?.slice(1));
        break;
      case 'NOTICE':
        if (/authentication failed|improperly formatted auth/i.test(msg.params.at(-1))) {
          this.stopped = true;
          this.emit('error', new Error(`Twitch login failed: ${msg.params.at(-1)}`));
        } else {
          this.log.info(`[twitch] NOTICE: ${msg.params.at(-1)}`);
        }
        break;
      case 'PRIVMSG': {
        const user = msg.prefix?.split('!')[0] ?? '';
        this.emit('message', {
          id: msg.tags.id,
          channel: msg.params[0]?.slice(1),
          user,
          displayName: msg.tags['display-name'] || user,
          text: msg.params[1] ?? '',
          tags: msg.tags,
        });
        break;
      }
    }
  }

  raw(line) {
    if (this.ws?.readyState === 1) this.ws.send(line.replace(/[\r\n]+/g, ' ') + '\r\n');
  }

  say(text, replyToId) {
    const tag = replyToId ? `@reply-parent-msg-id=${replyToId} ` : '';
    this.raw(`${tag}PRIVMSG #${this.channel} :${text}`);
  }

  close() {
    this.stopped = true;
    this.ws?.close();
  }
}
