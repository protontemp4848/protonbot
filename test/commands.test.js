import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, canRun, commandArgs, duration, findCommand, helpFor, roleOf, runCommand } from '../src/commands.js';
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
const msg = (user, text, id = 'id-' + Math.random(), tags = {}) => ({ id, user, displayName: user, text, tags });
const MOD = { badges: 'moderator/1', mod: '1' };
const STREAMER = { badges: 'broadcaster/1,subscriber/0' };
// What a viewer with no special role gets back from "!<text>", without going through the bot.
const run = (text, role = 'all', bot = {}) => runCommand(findCommand(text), { args: commandArgs(text), msg: {}, bot, role });

test('findCommand: "!name" at the start, case-insensitive, with or without trailing text', () => {
  assert.equal(findCommand('!help').name, 'help');
  assert.equal(findCommand('  !GitHub please').name, 'github');
  assert.equal(findCommand('!docs').name, 'docs');
  for (const t of ['help', 'what is !help', '!helpme', '!', '!nope', '', null]) assert.equal(findCommand(t), null, `matched ${t}`);
});

test('!help lists every command', () => {
  const text = run('!help');
  for (const c of COMMANDS) assert.ok(text.includes(`!${c.name}`), `missing !${c.name}: ${text}`);
});

test('!github and !docs link to the repo and the Google Doc', () => {
  assert.match(run('!github'), /https:\/\/github\.com\/protontemp4848\/protonbot\b/);
  assert.match(run('!docs'), /https:\/\/docs\.google\.com\/document\/d\/1012QUmc-RePLNedKXR5ddZeDm6XcE3GiXcWupuMVa-M\//);
});

test('every command reply is one valid, safe Twitch message', () => {
  const bot = { llm: { usage: { calls: 1e6, tokensIn: 1e9, tokensOut: 1e8, reasoning: 1e8, unreported: 1e6 } }, now: () => 9e10, startedAt: 0 };
  const texts = COMMANDS.flatMap((c) => [`!${c.name}`, `!help ${c.name}`, ...Object.keys(c.subcommands ?? {}).map((s) => `!${c.name} ${s}`)]).map((t) => run(t, 'streamer', bot));
  for (const text of [...texts, run('!stats', 'all')]) {
    assert.ok(text.length > 0 && text.length <= 500, `${text.length} chars: ${text}`);
    assert.ok(!/^[/.!]/.test(text) && !/[\r\n]/.test(text), text); // "!" could trigger another bot's command
  }
});

test('bot: a command is answered without a mention, as a threaded reply, without calling the LLM', async () => {
  const { bot, sent, llmCalls } = makeBot();
  await bot.handle(msg('viewer', '!github', 'm1'));
  assert.deepEqual(sent, [{ text: run('!github'), id: 'm1' }]);
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
  assert.equal(sent.at(-1).text, run('!docs'));
});

test('bot: dry run logs commands but never sends', async () => {
  const { bot, sent } = makeBot({ dryRun: true });
  assert.equal(await bot.handle(msg('viewer', '!help')), run('!help'));
  assert.equal(sent.length, 0);
});

test('bot: command replies go into the chat history the LLM sees', async () => {
  const { bot, llmCalls, advance } = makeBot();
  await bot.handle(msg('viewer', '!github'));
  advance(60_000);
  await bot.handle(msg('other', '@protonbot where is that link?'));
  assert.ok(llmCalls[0][1].content.includes('protonbot: My source code'));
});

test('roleOf: streamer by broadcaster badge or channel name, mods by mod tag or badge, everyone else is a viewer', () => {
  assert.equal(roleOf(msg('dudley', 'x', 'i', STREAMER), 'dudley'), 'streamer');
  assert.equal(roleOf(msg('Dudley', 'x', 'i'), 'dudley'), 'streamer');
  assert.equal(roleOf(msg('m', 'x', 'i', MOD), 'dudley'), 'mods');
  assert.equal(roleOf(msg('m', 'x', 'i', { mod: '1' }), 'dudley'), 'mods');
  assert.equal(roleOf(msg('m', 'x', 'i', { badges: 'subscriber/12,moderator/1' }), 'dudley'), 'mods');
  for (const tags of [{}, { badges: 'subscriber/12,vip/1', mod: '0' }, { badges: 'notbroadcaster/1' }]) assert.equal(roleOf(msg('v', 'x', 'i', tags), 'dudley'), 'all', JSON.stringify(tags));
  assert.equal(roleOf({ user: 'v', displayName: 'v', text: 'x' }, 'dudley'), 'all', 'no tags at all');
});

test('canRun: the streamer can run everything, mods can run mod commands, viewers only "all" ones', () => {
  const cmd = (permission) => ({ name: 'x', permission });
  assert.deepEqual(['all', 'mods', 'streamer'].map((role) => [undefined, 'all', 'mods', 'streamer'].map((p) => canRun(cmd(p), role))), [
    [true, true, false, false],
    [true, true, true, false],
    [true, true, true, true],
  ]);
});

test('runCommand: a command with a usage replies with its help when run without arguments', () => {
  const shout = { name: 'so', description: 'shout someone out', usage: '<user>', reply: ({ args }) => `Go follow ${args[0]}!` };
  assert.equal(runCommand(shout, { args: [], role: 'all' }), 'Usage: !so <user>: shout someone out.');
  assert.equal(runCommand(shout, { args: ['bob'], role: 'all' }), 'Go follow bob!');
  const modOnly = { ...shout, permission: 'streamer' };
  assert.equal(runCommand(modOnly, { args: ['bob'], role: 'mods' }), 'Sorry, !so is for the streamer only.');
});

test('!stats: mods only; bare or unknown subcommands show its help', () => {
  const help = 'Usage: !stats <tokens|uptime>: my stats since I started. tokens = Grok tokens used, uptime = how long I\'ve been running. Mods only.';
  assert.equal(run('!stats tokens', 'all'), 'Sorry, !stats is for mods only.');
  for (const t of ['!stats', '!stats nope', '!stats constructor', '!stats __proto__']) assert.equal(run(t, 'mods'), help, t);
  assert.equal(run('!help stats'), help, '!help <command> shows the same help');
  assert.equal(run('!help !stats'), help);
});

test('!stats tokens and !stats uptime report since startup', () => {
  const bot = { llm: { usage: { calls: 14, tokensIn: 15234, tokensOut: 1203, reasoning: 4100, unreported: 0 } }, now: () => 100_000 + 7_980_000, startedAt: 100_000 };
  assert.equal(run('!stats tokens', 'mods', bot), 'Since I started: 14 Grok calls, 15,234 tokens in, 1,203 out (4,100 of them reasoning).');
  assert.equal(run('!STATS Tokens', 'streamer', bot), run('!stats tokens', 'mods', bot), 'case-insensitive');
  bot.llm.usage.unreported = 2;
  assert.match(run('!stats tokens', 'mods', bot), /\(2 more didn't report tokens\)\.$/);
  assert.match(run('!stats tokens', 'mods', { llm: { usage: { calls: 1 } } }), /^Since I started: 1 Grok call, /);
  assert.equal(run('!stats tokens', 'mods', { llm: {} }), 'Since I started: 0 Grok calls, 0 tokens in, 0 out (0 of them reasoning).');
  assert.equal(run('!stats uptime', 'mods', bot), "I've been running for 2h 13m.");
});

test('duration shows the two largest units', () => {
  assert.deepEqual([0, 999, 45_000, 60_000, 723_000, 7_200_000, 7_980_000, 97_200_000].map(duration), ['0s', '0s', '45s', '1m', '12m 3s', '2h', '2h 13m', '1d 3h']);
});

test('!help: marks restricted commands, and falls back to the list for unknown commands', () => {
  assert.match(run('!help'), /!stats \(mods: my stats since I started\)/);
  assert.equal(run('!help nope'), run('!help'));
  assert.equal(run('!help github'), 'Usage: !github: my source code. Also !gh, !code, !source.');
});

test('bot: a viewer running !stats is refused in chat; a mod gets the answer; both are threaded replies', async () => {
  const { bot, sent, advance } = makeBot();
  await bot.handle(msg('viewer', '!stats uptime', 'v1'));
  advance(5_000);
  await bot.handle(msg('amod', '!stats uptime', 'm1', MOD));
  advance(5_000);
  await bot.handle(msg('dudley', '!stats', 's1', STREAMER));
  assert.deepEqual(sent, [
    { text: 'Sorry, !stats is for mods only.', id: 'v1' },
    { text: "I've been running for 5s.", id: 'm1' },
    { text: run('!help stats'), id: 's1' },
  ]);
});

test('bot: !stats tokens reads the real LLM client totals', async () => {
  const { bot, sent, advance } = makeBot();
  bot.llm.usage = { calls: 3, tokensIn: 2000, tokensOut: 50, reasoning: 30, unreported: 0 };
  await bot.handle(msg('dudley', '!stats tokens', 'x', STREAMER));
  assert.equal(sent[0].text, 'Since I started: 3 Grok calls, 2,000 tokens in, 50 out (30 of them reasoning).');
});

test('aliases: !doc/!document run !docs and !gh/!code/!source run !github, case-insensitive, with trailing text', () => {
  for (const t of ['!doc', '!document', '!DOC please']) assert.equal(findCommand(t).name, 'docs', t);
  for (const t of ['!gh', '!code', '!Source pls']) assert.equal(findCommand(t).name, 'github', t);
  assert.equal(run('!gh'), run('!github'));
  assert.equal(run('!help gh'), run('!help github'), '!help works with an alias too');
  for (const t of ['!documents', '!ghx', '!docs2']) assert.equal(findCommand(t), null, t);
});

test('aliases: lowercase words that never clash with another command name or alias', () => {
  const all = COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
  assert.deepEqual(all.filter((n, i) => all.indexOf(n) !== i), [], 'duplicates');
  for (const n of all) assert.match(n, /^[a-z0-9_]+$/, n);
});

test('aliases: an aliased mod command still checks permission and shows the real name', () => {
  const c = { name: 'reload', aliases: ['rl'], description: 'reload the doc', permission: 'mods', reply: () => 'Reloaded.' };
  assert.equal(findCommand('!rl', [c]), c);
  assert.equal(runCommand(c, { args: [], role: 'all' }), 'Sorry, !reload is for mods only.');
  assert.equal(helpFor(c), 'Usage: !reload: reload the doc. Also !rl. Mods only.');
});

test('bot: an alias is answered like the command itself', async () => {
  const { bot, sent } = makeBot();
  await bot.handle(msg('viewer', '!doc', 'd1'));
  assert.deepEqual(sent, [{ text: run('!docs'), id: 'd1' }]);
});
