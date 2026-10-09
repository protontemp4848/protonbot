# protonbot

A Twitch chat bot powered by Grok (xAI) that answers viewers in a channel
It uses a public Google Doc as its source of facts. No npm dependencies; needs Node ≥ 22.9.

## Setup

1. `cp .env.example .env` and fill it in:
   - `XAI_API_KEY`: your Grok key from console.x.ai
   - `GOOGLE_DOC_URL`: a Google Doc shared as **"Anyone with the link can view"**
   - `TWITCH_BOT_USERNAME` / `TWITCH_CLIENT_ID`: the bot's own Twitch account and your Twitch app's Client ID (see [Twitch login](#twitch-login)). Or, instead of a Client ID, put a token you made yourself in `TWITCH_OAUTH_TOKEN`.
2. `npm run auth` to log the bot in once (optional: `npm start` does it too).
3. `npm run dry-run` connects and logs what it _would_ say without sending anything.
4. `npm start` goes live.

## Connection

protonbot will just join your chat as a regular viewer via IRC (so you need to make it a twitch account)

## Twitch login

Twitch tokens expire after about 4 hours, so the bot gets and refreshes its own:

1. At https://dev.twitch.tv/console/apps register an app: any name, OAuth Redirect URL `http://localhost`, category Chat Bot, **Client Type: Public**. Put its Client ID in `TWITCH_CLIENT_ID`.
2. `npm run auth` prints a link and a code. Open it **while logged in to Twitch as the bot account** and enter the code.

From then on `npm start` reuses the saved token, refreshes it when it's close to expiring, re-checks it hourly and before every reconnect, and only asks you to log in again if the refresh token has died (after 30 days unused). `npm run auth -- --login` forces a fresh login, e.g. to switch accounts. Tokens are kept in `.cache/twitch-token.json` (git-ignored, readable only by you), never written to `.env`.

## Adding Information to the Bot

To make it easy to collab with your chat on adding information to your bot, you can create a Google Doc.
This doc will be read in as context when the bot starts.
The doc will be cached for 30 minutes. To pick up edits sooner, the streamer can type `!reload` in chat (or restart the bot).

## Chat commands

They don't need a mention and never call the LLM. All replies go to public chat.

| Command                   | Who    | Reply                                                                                                 |
| ------------------------- | ------ | ----------------------------------------------------------------------------------------------------- |
| `!help [command]`         | anyone | Lists all the commands, or the usage of one                                                           |
| `!github` (`!gh`, `!code`, `!source`) | anyone | Link to the source code: https://github.com/protontemp4848/protonbot                                  |
| `!docs` (`!doc`, `!document`) | anyone | Link to the Google Doc: https://docs.google.com/document/d/1012QUmc-RePLNedKXR5ddZeDm6XcE3GiXcWupuMVa-M/edit?usp=sharing |
| `!stats <tokens\|uptime>` | mods   | Grok calls and tokens used (in, out, reasoning), or how long the bot has been running, since it started |
| `!reload`                 | streamer | Re-reads the Google Doc now, skipping the cache, and says whether it changed. If Google is down it keeps the copy it had |

Commands share the 5s global cooldown, but not the 30s per-user one.

### Adding a command

Add it to `COMMANDS` in `src/commands.js`; `!help` picks it up automatically. A command is `{ name, aliases?, description, permission?, usage?, subcommands?, reply(ctx) }`:

- `aliases`: other names it answers to, e.g. `['doc', 'document']`. They run the command exactly like its name (same permission check), and `!help <command>` lists them. A test fails if two commands share a name or alias.
- `permission`: `all` (default), `mods` (mods and the streamer) or `streamer`. It's checked against the badges Twitch puts on the message, so it can't be faked. Anyone else gets "Sorry, !x is for mods only."
- `usage`: the arguments it needs, e.g. `'<user>'`. Run without arguments, the command replies with its help instead.
- `subcommands`: `{ name: { description, reply } }`, used in place of `reply` (see `!stats`). Run bare or with an unknown subcommand, the command replies with its help.
- `reply({ args, msg, bot })` returns the message, or a promise of it (see `!reload`). If it throws, the error is logged and nothing is sent. `args` is the words after the command (or subcommand).

## Behaviour

- Replies (as a threaded reply) only when someone mentions it by name or `@name`. Set `REPLY_MODE=all` to reply to everything.
- Cooldowns: 30s per user and 5s globally by default, which keeps it well under Twitch's 20 msgs/30s limit.
- When it ignores a mention because of a cooldown, it replies with how long is left ("You're on cooldown, try again in 24s." or "Busy answering someone else, try again in 4s."). Each viewer is told once per cooldown, and at most one notice goes out every 5s across the whole chat, so spamming the bot can't make it spam chat.
- Ignores itself and common bots (Nightbot, StreamElements, …).
- Sends the last 20 chat lines to the LLM as context.
- Output is limited to one line of ≤450 chars and is never allowed to start with `/` or `.`, so viewers can't trick it into running `/ban` and similar commands.

### Game Specific Integrations.

Protonbot has tools to help ask about specific games.
For example this repo has a Elden Ring Nightreign wiki tool, so you can ask questions like Boss weaknesses, etc

The wiki tool is supposed to be an example for how you'd add your own, and i've attempted making it modular.

#### Elden Ring Nightreign

- For Elden Ring Nightreign questions (bosses, Nightfarers, relics, items…) Grok can call a `lookup_nightreign_wiki` tool that searches the [Fextralife Nightreign wiki](https://eldenringnightreign.wiki.fextralife.com) through its MediaWiki API. It makes at most 2 lookup rounds per reply, and results are cached in memory for an hour. If the wiki is down, the bot answers without it. Set `WIKIS=none` to turn this off.
- Answers end with a link to where the information came from, e.g. `Source: https://eldenringnightreign.wiki.fextralife.com/Libra_Creature_of_Night`. Links don't count toward the 450-char answer limit: they go at the end of the last message if it stays under Twitch's 500, otherwise in their own message, but a reply never goes over 2 messages (if there's no room the link is dropped and logged). Only wiki pages looked up for that answer, or links in the Google Doc, are ever posted, so a made-up URL or one planted in a wiki page can't reach chat.

#### Adding a wiki

Any MediaWiki site (Fextralife, Fandom, wiki.gg…) can be added without touching the bot: add an entry to `src/wikis.js` (game name, base URL, what it covers, a few example page names) and list its id in `WIKIS`, e.g. `WIKIS=nightreign,eldenring`. Each wiki becomes its own `lookup_<id>_wiki` tool, gets its own line in the system prompt, and logs as `[wiki:<id>]`.

Other kinds of tools go in `src/tools.js`: a tool is `{ definition, rule, run(args, ctx) }`, and `run` returns `{ content, source? }` (see the comment there). Pass it to `Bot` in `tools`.

- The doc is fetched fresh every time the bot starts, so **restarting picks up doc edits**, and so does `!reload` from the streamer. After that it's cached in memory for `DOC_CACHE_TTL_MINUTES` (default 30). A copy is kept in `.cache/doc.txt` and is only used if Google can't be reached.

## Logs

Every line has a timestamp and a level. Each reply gets a request ID (`#12`) so you can follow it through Grok calls (`r1`, `r2`) and wiki lookups:

```
16:25:10.546 INFO  [bot] #1 <- alice: @protonbot what is fulghor weak to?
16:25:14.206 INFO  [llm] #1 r1 grok-4.3 3.66s tokens in=802 out=17 (reasoning 386) -> tool calls: lookup_nightreign_wiki({"query":"Fulghor"})
16:25:14.921 INFO  [wiki:nightreign] #1 "Fulghor" -> Fulghor Champion of Nightglow (6012 chars, 715ms) https://eldenringnightreign.wiki.fextralife.com/Fulghor_Champion_of_Nightglow
16:25:15.772 INFO  [llm] #1 r2 grok-4.3 0.85s tokens in=2344 out=24 -> answer (106 chars)
16:25:15.773 INFO  [reply] #1 -> alice after 5.2s: fulghor is weak to lightning
```

Mentions it ignores are logged with the reason, e.g. `ignoring bob (user cooldown, 24s left)`. Ordinary chat isn't logged unless `LOG_CHAT=1`.
`LOG_LEVEL=debug` adds prompt sizes, wiki text previews and search candidates, cache hits, and socket events. The startup line summarises config but never prints the API key or OAuth token.

## Tests

`npm test`
