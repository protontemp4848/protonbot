/**
 * Chat commands: a message starting with "!<name>" gets a fixed reply, with no LLM call and no need to mention the bot.
 * A command is { name, description, reply() }. Add new ones to COMMANDS; !help lists them automatically.
 */
export const COMMANDS = [
  {
    name: 'help',
    description: 'lists these commands',
    reply: () => `Commands: ${COMMANDS.map((c) => `!${c.name} (${c.description})`).join(', ')}. Or mention me to ask a question.`,
  },
  {
    name: 'github',
    description: 'my source code',
    reply: () => 'My source code: https://github.com/protontemp4848/protonbot',
  },
  {
    name: 'docs',
    description: 'the doc I read my facts from',
    reply: () => 'My Google Doc: https://docs.google.com/document/d/1012QUmc-RePLNedKXR5ddZeDm6XcE3GiXcWupuMVa-M/edit?usp=sharing',
  },
];

/** The command a chat message invokes ("!help", "!GitHub please"), or null. */
export function findCommand(text, commands = COMMANDS) {
  const name = String(text ?? '').trim().match(/^!(\w+)(\s|$)/)?.[1].toLowerCase();
  return commands.find((c) => c.name === name) ?? null;
}
