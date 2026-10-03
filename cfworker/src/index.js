import { Failure } from '../../auto-register/api/errors.js';
import { digest } from '../../auto-register/api/auth.js';
import { createConversion } from '../../auto-register/api/conversion.js';
import { createStore } from './store.js';
import { createAuthRuntime } from './auth-runtime.js';
import { ensureSchema } from './schema.js';
import { json,failure,bodyOf } from './http.js';
export { AuthState } from './auth-state.js';
export { TelegramAccount } from './telegram-account.js';

export default {
  async fetch(request,env) {
    try {
      const path = new URL(request.url).pathname;
      const method = request.method;
      if (path === '/health' && method === 'GET') return json({ok:true});
      await ensureSchema(env.DB);
      const store = createStore(env.DB);
      const webhook = path.match(/^\/webhooks\/(\d+)$/);
      if (webhook) {
        if (method !== 'POST') throw new Failure(405,'Webhook 仅支持 POST');
        const conversion = createConversion({store,env});
        return json(await conversion.handleWebhook(webhook[1],request.headers.get('X-Telegram-Bot-Api-Secret-Token'),await bodyOf(request)));
      }
      const auth = createAuthRuntime(store,env);
      if (path.startsWith('/auth/')) {
        return json(await auth.route(method,path,await bodyOf(request),request.headers.get('Authorization'),request.headers.get('CF-Connecting-IP') || 'unknown'));
      }
      const {user} = await auth.authenticate(request.headers.get('Authorization'));
      if (path === '/v1/accounts' && method === 'GET') return json({accounts:await store.accountsForUser(user.id)});
      const body = await bodyOf(request);
      let phone;
      if (path === '/v1/login/start' && method === 'POST') {
        phone = typeof (body.phone ?? env.TG_PHONE) === 'string' ? (body.phone ?? env.TG_PHONE).trim() : '';
        if (!/^\+\d{7,15}$/.test(phone)) throw new Failure(400,'手机号必须包含国际区号，不含空格');
      } else {
        const match = path.match(/^\/v1\/accounts\/([a-f0-9-]{36})(?:\/.*)?$/);
        if (!match) throw new Failure(404,'接口不存在');
        await auth.requireAccount(user.id,match[1]);
        phone = (await store.getAccount(match[1])).phone;
      }
      // Every operation for a phone reaches the same actor, even across users
      // and separate login attempts. Public callers cannot access this binding.
      const actor = env.TELEGRAM_ACCOUNTS.get(env.TELEGRAM_ACCOUNTS.idFromName(`${env.AUTH_STATE_PREFIX || 'telegram-bot:'}${digest(phone)}`));
      return await actor.fetch('https://internal/operation',{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,path,body,user_id:user.id}),
      });
    } catch (error) { return failure(error); }
  },
};
