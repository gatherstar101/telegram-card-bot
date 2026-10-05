import { createClient } from 'redis';
import nodemailer from 'nodemailer';
import { createAuth } from './auth.js';
import { createCache } from './cache.js';

export async function createAuthRuntime(store, env = process.env) {
  if (!env.REDIS_URL && !env.REDIS_HOST) throw new Error('需要 REDIS_URL 或 REDIS_HOST');
  if (!env.AUTH_HMAC_SECRET || env.AUTH_HMAC_SECRET.length < 32) throw new Error('AUTH_HMAC_SECRET 至少需要 32 字符');
  if (env.SMTP_USER && !env.SMTP_PASSWORD) throw new Error('SMTP_USER 配置后需要 SMTP_PASSWORD');
  const redis = createClient({
    disableOfflineQueue: true, commandsQueueMaxLength: 1000,
    ...(env.REDIS_URL ? { url: env.REDIS_URL } : { username: env.REDIS_USER || undefined, password: env.REDIS_PASSWORD || undefined, database: Number(env.REDIS_DB || 0) }),
    socket: { ...(env.REDIS_URL ? {} : { host: env.REDIS_HOST, port: Number(env.REDIS_PORT || 6379) }), connectTimeout: 5000, reconnectStrategy: retries => retries < 3 ? 500 : false },
  });
  redis.on('error', () => console.error('Redis connection error'));
  await redis.connect();
  const transport = env.SMTP_HOST && env.SMTP_FROM ? nodemailer.createTransport({
    host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 587), secure: env.SMTP_SECURE === 'true',
    requireTLS: env.SMTP_REQUIRE_TLS !== 'false',
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
  }) : null;
  const cache = createCache(redis);
  const auth = createAuth({ redis, store, lockTTL:600, secret: env.AUTH_HMAC_SECRET, prefix: env.REDIS_KEY_PREFIX || 'telegram-bot:',
    challengeTTL: Number(env.AUTH_CHALLENGE_TTL_SECONDS || 600), sessionTTL: Number(env.AUTH_SESSION_TTL_SECONDS || 7200),
    sendCode: async (email, code, purpose) => {
      if (!transport) throw new Error('SMTP is not configured');
      await transport.sendMail({ from: env.SMTP_FROM, to: email,
        subject: purpose === 'register' ? 'Telegram Bot 平台注册验证码' : purpose==='reset'?'Telegram Bot 平台密码重置验证码':'Telegram Bot 平台登录验证码',
        text: `您的验证码为 ${code}，有效期 ${Math.ceil(Number(env.AUTH_CHALLENGE_TTL_SECONDS || 600) / 60)} 分钟，仅可使用一次。如非本人操作，请忽略此邮件。`,
      });
    },
  });
  return { ...auth, cache, ready:async()=>redis.ping(), close: async () => { transport?.close(); await redis.quit(); } };
}
