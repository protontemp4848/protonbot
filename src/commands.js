import { preview } from './log.js';

/**
 * Chat commands: a message starting with "!<name>" gets a reply, with no LLM call and no need to mention the bot.
 * A command is { name, aliases?, description, permission?, usage?, subcommands?, reply(ctx) }:
 * - aliases: other names it answers to, e.g. ['doc', 'document'] for !docs. Lowercase, and unique across all commands.
 * - permission: who may run it: 'all' (default), 'mods' (mods and the streamer) or 'streamer'.
 * - usage: the arguments it needs, e.g. '<user>'. Run without arguments, it replies with its help instead.
 * - subcommands: { name: { description, reply(ctx) } } in place of reply. Run bare or with an unknown subcommand,
 *   it replies with its help.
 * - reply(ctx) returns the message (or a promise of it). ctx is { args, msg, bot }: the words after the command (or subcommand), the chat
 *   message, and the Bot (for its stats).
 * All replies go to public chat. Add new commands to COMMANDS; !help lists them automatically.
 */
export const COMMANDS = [
  {
    name: 'help',
    description: 'lists these commands, or "!help <command>" for one',
    reply: ({ args }) => {
      const c = findCommand(`!${args[0]?.replace(/^!/, '')}`);
      if (c) return helpFor(c);
      return `Commands: ${COMMANDS.map((c) => `!${c.name} (${WHO[c.permission] ? `${WHO[c.permission]}: ` : ''}${c.description})`).join(', ')}. Or mention me to ask a question.`;
    },
  },
  {
    name: 'github',
    aliases: ['gh', 'code', 'source'],
    description: 'my source code',
    reply: () => 'My source code: https://github.com/protontemp4848/protonbot',
  },
  {
    name: 'docs',
    aliases: ['doc', 'document'],
    description: 'the doc I read my facts from',
    reply: () => 'My Google Doc: https://docs.google.com/document/d/1012QUmc-RePLNedKXR5ddZeDm6XcE3GiXcWupuMVa-M/edit?usp=sharing',
  },
  {
    name: 'reload',
    description: 're-reads the Google Doc now, skipping the 30 minute cache',
    permission: 'streamer',
    reply: async ({ bot }) => {
      try {
        const { text, changed } = await bot.doc.reload();
        return `Reloaded the doc (${text.length.toLocaleString('en-US')} chars, ${changed ? 'changed' : 'no changes'}).`;
      } catch (e) {
        return `Couldn't reload the doc (${preview(e.message, 150)}), still using the copy I had.`;
      }
    },
  },
  {
    name: 'stats',
    description: 'my stats since I started',
    permission: 'mods',
    subcommands: {
      tokens: {
        description: 'Grok tokens used',
        reply: ({ bot }) => {
          const u = bot.llm.usage ?? {};
          const n = (v) => (v ?? 0).toLocaleString('en-US');
          const unreported = u.unreported ? ` (${n(u.unreported)} more didn't report tokens)` : '';
          return `Since I started: ${n(u.calls)} Grok ${u.calls === 1 ? 'call' : 'calls'}, ${n(u.tokensIn)} tokens in, ${n(u.tokensOut)} out (${n(u.reasoning)} of them reasoning)${unreported}.`;
        },
      },
      uptime: {
        description: "how long I've been running",
        reply: ({ bot }) => `I've been running for ${duration(bot.now() - bot.startedAt)}.`,
      },
    },
  },
];

const WHO = { mods: 'mods', streamer: 'streamer' };
const RANK = { all: 0, mods: 1, streamer: 2 };

/** The command a chat message invokes ("!help", "!GitHub please", "!gh"), by name or alias, or null. */
export function findCommand(text, commands = COMMANDS) {
  const name = String(text ?? '').trim().match(/^!(\w+)(\s|$)/)?.[1].toLowerCase();
  return commands.find((c) => c.name === name || c.aliases?.includes(name)) ?? null;
}

/** The words after the command name: "!stats  tokens now" -> ['tokens', 'now']. */
export const commandArgs = (text) => String(text ?? '').trim().split(/\s+/).slice(1);

/**
 * Who sent a chat message: 'streamer', 'mods' or 'all'. Badges and the mod flag are IRC tags set by Twitch's server,
 * so viewers can't fake them.
 */
export function roleOf(msg, channel) {
  const badges = `,${msg.tags?.badges ?? ''}`;
  if (badges.includes(',broadcaster/') || msg.user?.toLowerCase() === channel) return 'streamer';
  if (msg.tags?.mod === '1' || badges.includes(',moderator/')) return 'mods';
  return 'all';
}

export const canRun = (command, role) => RANK[role] >= RANK[command.permission ?? 'all'];

/**
 * One-line help for a command: its usage, what it does, its subcommands, its aliases and who can run it. It starts with "Usage:"
 * rather than "!", so another bot in chat (Nightbot, ...) never takes the bot's own reply for a command.
 */
export function helpFor(c) {
  const who = (c.aliases?.length ? ` Also ${c.aliases.map((a) => `!${a}`).join(', ')}.` : '') + ({ mods: ' Mods only.', streamer: ' Streamer only.' }[c.permission] ?? '');
  if (c.subcommands) {
    const subs = Object.entries(c.subcommands).map(([name, s]) => `${name} = ${s.description}`);
    return `Usage: !${c.name} <${Object.keys(c.subcommands).join('|')}>: ${c.description}. ${subs.join(', ')}.${who}`;
  }
  return `Usage: !${c.name}${c.usage ? ` ${c.usage}` : ''}: ${c.description}.${who}`;
}

/** Runs a command for ctx { args, msg, bot, role } and returns its reply (or a promise of it): the answer, its help, or a refusal. */
export function runCommand(c, ctx) {
  if (!canRun(c, ctx.role)) return `Sorry, !${c.name} is for ${c.permission === 'streamer' ? 'the streamer' : 'mods'} only.`;
  if (c.subcommands) {
    const name = ctx.args[0]?.toLowerCase();
    const sub = Object.hasOwn(c.subcommands, name ?? '') ? c.subcommands[name] : null;
    return sub ? sub.reply({ ...ctx, args: ctx.args.slice(1) }) : helpFor(c);
  }
  if (c.usage && !ctx.args.length) return helpFor(c);
  return c.reply(ctx);
}

/** "45s", "12m 3s", "2h 5m", "1d 3h": the two largest units. */
export function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const units = [
    [Math.floor(s / 86400), 'd'],
    [Math.floor(s / 3600) % 24, 'h'],
    [Math.floor(s / 60) % 60, 'm'],
    [s % 60, 's'],
  ];
  const first = units.findIndex(([v]) => v > 0);
  if (first < 0) return '0s';
  return units.slice(first, first + 2).filter(([v]) => v > 0).map(([v, u]) => `${v}${u}`).join(' ');
}
