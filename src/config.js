const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

export function loadConfig(env = process.env) {
  const botUsername = env.TWITCH_BOT_USERNAME?.trim().toLowerCase() || null;
  const oauthToken = env.TWITCH_OAUTH_TOKEN?.trim().replace(/^oauth:/, '') || null;
  const anonymous = !botUsername || !oauthToken;

  const config = {
    channel: (env.TWITCH_CHANNEL || 'dudley').trim().toLowerCase().replace(/^#/, ''),
    botUsername: anonymous ? 'justinfan' + Math.floor(10000 + Math.random() * 89999) : botUsername,
    oauthToken,
    anonymous,
    xaiApiKey: env.XAI_API_KEY?.trim() || null,
    xaiModel: env.XAI_MODEL || 'grok-4',
    xaiBaseUrl: (env.XAI_BASE_URL || 'https://api.x.ai/v1').replace(/\/$/, ''),
    googleDocUrl: env.GOOGLE_DOC_URL?.trim() || null,
    docCacheTtlMs: num(env.DOC_CACHE_TTL_MINUTES, 30) * 60_000,
    docCachePath: env.DOC_CACHE_PATH || '.cache/doc.txt',
    // Let the LLM look up game facts on the Fextralife Nightreign wiki. On by default; NIGHTREIGN_WIKI=0 disables.
    nightreignWiki: !['0', 'false'].includes(env.NIGHTREIGN_WIKI),
    logLevel: ['debug', 'info', 'warn', 'error'].includes(env.LOG_LEVEL) ? env.LOG_LEVEL : 'info',
    replyMode: env.REPLY_MODE === 'all' ? 'all' : 'mention',
    userCooldownMs: num(env.USER_COOLDOWN_SECONDS, 30) * 1000,
    globalCooldownMs: num(env.GLOBAL_COOLDOWN_SECONDS, 5) * 1000,
    personality: env.BOT_PERSONALITY || 'You are friendly, witty and helpful.',
    // Anonymous connections can't send, so they are always dry-run.
    dryRun: anonymous || env.DRY_RUN === '1' || env.DRY_RUN === 'true',
  };

  if (!config.xaiApiKey) throw new Error('XAI_API_KEY is required');
  return config;
}
