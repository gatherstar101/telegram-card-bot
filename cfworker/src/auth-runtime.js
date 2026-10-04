import { createAuth } from '../../auto-register/api/auth.js';
import { createAuthCache } from './auth-state.js';

export function createAuthRuntime(store,env) {
  const auth=createAuth({
    lockTTL:600,store,cache:createAuthCache(env),secret:env.AUTH_HMAC_SECRET,
    prefix:env.AUTH_STATE_PREFIX || 'telegram-bot:',
    challengeTTL:Number(env.AUTH_CHALLENGE_TTL_SECONDS || 600),
    sessionTTL:Number(env.AUTH_SESSION_TTL_SECONDS || 7200),
    async sendCode(email,code,purpose) {
      if (!env.MAIL_API_KEY || !env.MAIL_FROM) throw new Error('Mail API is not configured');
      const endpoint = new URL(env.MAIL_API_URL || 'https://api.resend.com/emails');
      if (endpoint.protocol !== 'https:') throw new Error('Mail API requires HTTPS');
      const response = await fetch(endpoint, {
        method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${env.MAIL_API_KEY}`},
        body:JSON.stringify({from:env.MAIL_FROM,to:[email],subject:purpose==='register'?'注册验证码':'登录验证码',text:`你的验证码是 ${code}，${Number(env.AUTH_CHALLENGE_TTL_SECONDS || 600)/60} 分钟内有效。`}),
        signal:AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error('Mail delivery failed');
      await response.body?.cancel();
    },
  });
  return auth;
}
