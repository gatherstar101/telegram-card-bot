export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== (env.WEBHOOK_PATH || '/webhook')) {
      return new Response('Not found', { status: 404 });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }
    if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET) {
      return new Response('Configuration error', { status: 500 });
    }
    if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
      return new Response('Forbidden', { status: 403 });
    }
    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }
    const message = update?.message;
    if (message?.chat?.type !== 'private' ||
        !/^\/start(?:@\w+)?(?:\s|$)/i.test(message.text || '')) {
      return new Response('OK');
    }
    try {
      const url = new URL(env.LANDING_URL);
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error();
    } catch {
      console.error('Invalid LANDING_URL');
      return new Response('Configuration error', { status: 500 });
    }
    const image = env.CARD_IMAGE?.trim();
    const text = env.CARD_TEXT || '欢迎访问平台';
    if (text.length > (image ? 1024 : 4096)) {
      console.error('CARD_TEXT too long');
      return new Response('Configuration error', { status: 500 });
    }
    const payload = {
      chat_id: message.chat.id,
      reply_markup: { inline_keyboard: [[{
        text: env.BUTTON_TEXT || '立即进入平台',
        url: env.LANDING_URL
      }]] },
      ...(image ? { photo: image, caption: text } : { text })
    };
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${env.BOT_TOKEN}/${image ? 'sendPhoto' : 'sendMessage'}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000)
        }
      );
      const result = await response.json();
      if (!response.ok || !result.ok) {
        console.error('Telegram send failed', { error_code: result.error_code });
        return new Response('Send failed', { status: 502 });
      }
      return new Response('OK');
    } catch {
      console.error('Telegram request failed');
      return new Response('Temporary failure', { status: 502 });
    }
  }
};
