import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, findCommand } from '../src/commands.js';
import { Bot } from '../src/bot.js';
import { silentLog } from './helpers.js';

const baseConfig = { botUsername: 'protonbot', channel: 'dudley', personality: 'Be nice.', replyMode: 'mention', userCooldownMs: 30_000, globalCooldownMs: 5_000, dryRun: false };

function makeBot(overrides = {}) {
  let t = 100_000;
  const sent = [];
  const llmCalls = [];
  const bot = new Bot({
    config: { ...baseConfig, ...overrides },
    twitch: { say: (text, id) => sent.push({ text, id }), on() {} },
    llm: { complete: async (msgs) => (llmCalls.push(msgs), { role: 'assistant', content: 'llm answer' }) },
    doc: { get: async () => '' },
    now: () => t,
    sleep: async () => {},
    log: silentLog,
  });
  return { bot, sent, llmCalls, advance: (ms) => (t += ms) };
}
const msg = (user, text, id = 'id-' + Math.random()) => ({ id, user, displayName: user, text });

test('findCommand: "!name" at the start, case-insensitive, with or without trailing text', () => {
  assert.equal(findCommand('!help').name, 'help');
  assert.equal(findCommand('  !GitHub please').name, 'github');
  assert.equal(findCommand('!docs').name, 'docs');
  for (const t of ['help', 'what is !help', '!helpme', '!', '!nope', '', null]) assert.equal(findCommand(t), null, `matched ${t}`);
});

test('!help lists every command', () => {
  const text = findCommand('!help').reply();
  for (const c of COMMANDS) assert.ok(text.includes(`!${c.name}`), `missing !${c.name}: ${text}`);
});

test('!github and !docs link to the repo and the Google Doc', () => {
  assert.match(findCommand('!github').reply(), /https:\/\/github\.com\/protontemp4848\/protonbot\b/);
  assert.match(findCommand('!docs').reply(), /https:\/\/docs\.google\.com\/document\/d\/1012QUmc-RePLNedKXR5ddZeDm6XcE3GiXcWupuMVa-M\//);
});

test('every command reply is one valid, safe Twitch message', () => {
  for (const c of COMMANDS) {
    const text = c.reply();
    assert.ok(text.length > 0 && text.length <= 500, `!${c.name} is ${text.length} chars`);
    assert.ok(!/^[/.]/.test(text) && !/[\r\n]/.test(text), `!${c.name}: ${text}`);
  }
});

test('bot: a command is answered without a mention, as a threaded reply, without calling the LLM', async () => {
  const { bot, sent, llmCalls } = makeBot();
  await bot.handle(msg('viewer', '!github', 'm1'));
  assert.deepEqual(sent, [{ text: findCommand('!github').reply(), id: 'm1' }]);
  assert.equal(llmCalls.length, 0);
});

test('bot: unknown "!" commands and plain chat are still ignored', async () => {
  const { bot, sent } = makeBot();
  await bot.handle(msg('viewer', '!nope'));
  await bot.handle(msg('viewer', 'hello everyone'));
  assert.equal(sent.length, 0);
});

test('bot: commands share the global cooldown but not the per-user one', async () => {
  const { bot, sent, llmCalls, advance } = makeBot();
  await bot.handle(msg('a', '!help'));
  await bot.handle(msg('b', '!docs')); // within 5s global cooldown
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /^Busy answering someone else/);
  advance(5_000);
  await bot.handle(msg('a', '@protonbot hi')); // a used a command, but can still ask a question right away
  assert.equal(llmCalls.length, 1);
  advance(5_000);
  await bot.handle(msg('a', '!docs')); // and a command right after their question
  assert.equal(sent.at(-1).text, findCommand('!docs').reply());
});

test('bot: dry run logs commands but never sends', async () => {
  const { bot, sent } = makeBot({ dryRun: true });
  assert.equal(await bot.handle(msg('viewer', '!help')), findCommand('!help').reply());
  assert.equal(sent.length, 0);
});

test('bot: command replies go into the chat history the LLM sees', async () => {
  const { bot, llmCalls, advance } = makeBot();
  await bot.handle(msg('viewer', '!github'));
  advance(60_000);
  await bot.handle(msg('other', '@protonbot where is that link?'));
  assert.ok(llmCalls[0][1].content.includes('protonbot: My source code'));
});
