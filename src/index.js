import { loadConfig } from './config.js';
import { TwitchClient } from './twitch.js';
import { GrokClient } from './llm.js';
import { DocCache } from './docCache.js';
import { Bot } from './bot.js';
import { MediaWiki } from './wiki.js';
import { WIKIS } from './wikis.js';
import { wikiTool } from './tools.js';
import { createLogger } from './log.js';
import { authFromEnv } from './auth.js';

// With TWITCH_CLIENT_ID set, get or refresh the bot's token before anything else (may ask you to log in once).
const env = { ...process.env };
const auth = authFromEnv(env, createLogger({ level: env.LOG_LEVEL }));
if (auth) {
  try {
    env.TWITCH_OAUTH_TOKEN = await auth.token();
    env.TWITCH_BOT_USERNAME ||= auth.login;
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

const config = loadConfig(env);
const log = createLogger({ level: config.logLevel });

// Never log the OAuth token or API key, only whether they're set.
log.info(
  `[start] channel=#${config.channel} bot=${config.botUsername}${config.anonymous ? ' (anonymous)' : ''} model=${config.xaiModel} ` +
    `reply=${config.replyMode} cooldowns=${config.userCooldownMs / 1000}s/user ${config.globalCooldownMs / 1000}s/global ` +
    `doc=${config.googleDocUrl ? 'set' : 'none'} wikis=${config.wikis.join(',') || 'none'} dry-run=${config.dryRun} log=${config.logLevel}`,
);

const doc = new DocCache({ url: config.googleDocUrl, ttlMs: config.docCacheTtlMs, cachePath: config.docCachePath, log });
const llm = new GrokClient({ apiKey: config.xaiApiKey, model: config.xaiModel, baseUrl: config.xaiBaseUrl, log });
// A managed token is re-checked (and refreshed if needed) on every reconnect, and hourly as Twitch requires.
const token = auth ? () => auth.token({ interactive: false }) : config.oauthToken;
const twitch = new TwitchClient({ username: config.botUsername, token, channel: config.channel, log });
if (auth) setInterval(() => auth.token({ interactive: false }).catch((e) => log.error(`[auth] ${e.message}`)), 60 * 60_000).unref();
const tools = config.wikis.map((id) => wikiTool({ id, ...WIKIS[id], wiki: new MediaWiki({ baseUrl: WIKIS[id].baseUrl, label: `wiki:${id}`, log }) }));
const bot = new Bot({ config, twitch, llm, doc, tools, log });

if (config.googleDocUrl) {
  // Warm the cache at startup so the first reply isn't slow, and fail loudly if the doc is misconfigured.
  doc.get().catch((e) => log.error(e.message));
} else {
  log.warn('[doc] GOOGLE_DOC_URL not set, running without reference context');
}

twitch.on('joined', (ch) => log.info(`[twitch] joined #${ch} as ${config.botUsername}${config.dryRun ? ' (DRY RUN, will not send)' : ''}`));
twitch.on('error', (e) => {
  log.error('[twitch]', e.message);
  if (/login failed/i.test(e.message)) process.exit(1);
});
if (process.env.LOG_CHAT) twitch.on('message', (m) => log.info(`[chat] ${m.displayName}: ${m.text}`));

bot.start();
twitch.connect();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => (twitch.close(), process.exit(0)));
