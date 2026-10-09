import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIrc, TwitchClient } from '../src/twitch.js';
import { FakeWebSocket, silentLog, tick } from './helpers.js';

test('parseIrc handles a tagged PRIVMSG with escaped tag values', () => {
  const m = parseIrc('@badge-info=;display-name=Some\\sUser;id=abc-123;mod=0 :someuser!someuser@someuser.tmi.twitch.tv PRIVMSG #dudley :hey @protonbot what game is this? :)');
  assert.equal(m.command, 'PRIVMSG');
  assert.equal(m.prefix, 'someuser!someuser@someuser.tmi.twitch.tv');
  assert.deepEqual(m.params, ['#dudley', 'hey @protonbot what game is this? :)']);
  assert.equal(m.tags['display-name'], 'Some User');
  assert.equal(m.tags.id, 'abc-123');
  assert.equal(m.tags['badge-info'], '');
});

test('parseIrc handles PING without prefix or tags', () => {
  assert.deepEqual(parseIrc('PING :tmi.twitch.tv'), { tags: {}, prefix: null, command: 'PING', params: ['tmi.twitch.tv'] });
});

test('TwitchClient logs in, joins, answers PING, emits messages, sends threaded replies', async () => {
  FakeWebSocket.instances = [];
  const c = new TwitchClient({ username: 'protonbot', token: 'tok123', channel: 'dudley', WebSocketImpl: FakeWebSocket, log: silentLog });
  const got = [];
  let joined = null;
  c.on('message', (m) => got.push(m));
  c.on('joined', (ch) => (joined = ch));
  c.connect();
  await tick();
  const ws = FakeWebSocket.instances[0];
  assert.equal(ws.url, 'wss://irc-ws.chat.twitch.tv:443');
  assert.deepEqual(ws.sent, [
    'CAP REQ :twitch.tv/tags twitch.tv/commands\r\n',
    'PASS oauth:tok123\r\n',
    'NICK protonbot\r\n',
    'JOIN #dudley\r\n',
  ]);

  ws.serverSends('@room-id=1 :tmi.twitch.tv ROOMSTATE #dudley');
  assert.equal(joined, 'dudley');

  ws.serverSends('PING :tmi.twitch.tv');
  assert.equal(ws.sent.at(-1), 'PONG :tmi.twitch.tv\r\n');

  ws.serverSends('@display-name=Viewer;id=msg-1 :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #dudley :hello chat');
  assert.equal(got.length, 1);
  assert.deepEqual({ ...got[0], tags: undefined }, { id: 'msg-1', channel: 'dudley', user: 'viewer', displayName: 'Viewer', text: 'hello chat', tags: undefined });

  c.say('hi there', 'msg-1');
  assert.equal(ws.sent.at(-1), '@reply-parent-msg-id=msg-1 PRIVMSG #dudley :hi there\r\n');

  c.say('no\r\ninjection');
  assert.equal(ws.sent.at(-1), 'PRIVMSG #dudley :no injection\r\n', 'newlines must not create extra IRC commands');
  c.close();
});

test('TwitchClient stops and errors on auth failure instead of reconnect-looping', async () => {
  FakeWebSocket.instances = [];
  const c = new TwitchClient({ username: 'protonbot', token: 'bad', channel: 'dudley', WebSocketImpl: FakeWebSocket, log: silentLog });
  let err = null;
  c.on('error', (e) => (err = e));
  c.connect();
  await tick();
  FakeWebSocket.instances[0].serverSends(':tmi.twitch.tv NOTICE * :Login authentication failed');
  assert.match(err.message, /login failed/i);
  FakeWebSocket.instances[0].close();
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(FakeWebSocket.instances.length, 1, 'should not reconnect');
});

test('TwitchClient reconnects when the socket drops', async () => {
  FakeWebSocket.instances = [];
  const c = new TwitchClient({ username: 'protonbot', token: 't', channel: 'dudley', WebSocketImpl: FakeWebSocket, log: silentLog });
  c.connect();
  await tick();
  FakeWebSocket.instances[0].close();
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(FakeWebSocket.instances.length, 2);
  c.close();
});
