import { defineConfig } from 'vitest/config';
import { cloudflareTest,readD1Migrations } from '@cloudflare/vitest-plugin';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve:{alias:{
    'teleproto':fileURLToPath(new URL('./node_modules/teleproto',import.meta.url)),
    'big-integer':fileURLToPath(new URL('./node_modules/big-integer',import.meta.url)),
  }},
  plugins:[cloudflareTest(async () => ({
    wrangler:{configPath:'./wrangler.jsonc'},
    miniflare:{bindings:{
      TEST_MIGRATIONS:await readD1Migrations('./migrations'),
      AUTH_STATE_PREFIX:'telegram-bot:',
      TELEGRAM_PROBE:process.env.TELEGRAM_PROBE || '',PROBE_API_ID:process.env.TG_API_ID || '',PROBE_API_HASH:process.env.TG_API_HASH || '',
      AUTH_HMAC_SECRET:'local-test-only-secret-with-at-least-32-characters',
      MAIL_API_URL:'https://mailer.example.test/emails',MAIL_API_KEY:'local-test-key',MAIL_FROM:'test@example.test',
      PUBLIC_BASE_URL:'https://bot.example.test',
    }},
  }))],
  test:{include:['test/*.test.js'],testTimeout:20000},
});
