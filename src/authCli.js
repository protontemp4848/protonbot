import { authFromEnv } from './auth.js';
import { createLogger } from './log.js';

// `npm run auth`: get or refresh the bot's Twitch token. `npm run auth -- --login` forces a fresh login.
const auth = authFromEnv(process.env, createLogger({ level: process.env.LOG_LEVEL }));
if (!auth) {
  console.error('Set TWITCH_CLIENT_ID in .env first (see "Twitch login" in the README).');
  process.exit(1);
}
try {
  await auth.token({ forceLogin: process.argv.includes('--login') });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
