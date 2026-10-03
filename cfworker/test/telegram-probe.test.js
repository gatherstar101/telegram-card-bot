import { it,expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { Api } from 'teleproto';
import { createTelegramClient } from '../src/telegram-account.js';

// Opt-in read-only probe: no user login, sendCode or BotFather messages.
it.skipIf(env.TELEGRAM_PROBE!=='1')('performs a real Telegram handshake inside workerd',async () => {
  const client=createTelegramClient({api_id:Number(env.PROBE_API_ID),api_hash:env.PROBE_API_HASH});
  try {
    await client.connect();
    const config=await client.invoke(new Api.help.GetConfig());
    expect(config.dcOptions.length).toBeGreaterThan(0);
    expect(await client.checkAuthorization()).toBe(false);
  } finally { await client.destroy(); }
},60000);
