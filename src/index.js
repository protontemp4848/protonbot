import { loadConfig } from './config.js';
import { TwitchClient } from './twitch.js';
import { GrokClient } from './llm.js';
import { DocCache } from './docCache.js';
import { Bot } from './bot.js';
import { MediaWiki } from './wiki.js';
import { WIKIS } from './wikis.js';
import { wikiTool } from './tools.js';
import { createLogger } from './log.js';

const config = loadConfig();
const log = createLogger({ level: config.logLevel });

// Never log the OAuth token or API key, only whether they're set.
log.info(
  `[start] channel=#${config.channel} bot=${config.botUsername}${config.anonymous ? ' (anonymous)' : ''} model=${config.xaiModel} ` +
    `reply=${config.replyMode} cooldowns=${config.userCooldownMs / 1000}s/user ${config.globalCooldownMs / 1000}s/global ` +
    `doc=${config.googleDocUrl ? 'set' : 'none'} wikis=${config.wikis.join(',') || 'none'} dry-run=${config.dryRun} log=${config.logLevel}`,
);

const doc = new DocCache({ url: config.googleDocUrl, ttlMs: config.docCacheTtlMs, cachePath: config.docCachePath, log });
const llm = new GrokClient({ apiKey: config.xaiApiKey, model: config.xaiModel, baseUrl: config.xaiBaseUrl, log });
const twitch = new TwitchClient({ username: config.botUsername, token: config.oauthToken, channel: config.channel, log });
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
