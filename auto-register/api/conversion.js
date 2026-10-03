import { randomBytes, timingSafeEqual } from 'node:crypto';
import bigInt from 'big-integer';
import { Api } from 'teleproto';
import { Failure } from './errors.js';

function text(value, field, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Failure(400, `${field} 必须为 1–${maximum} 字符`);
  return value.trim();
}
function url(value, field) {
  try {
    const result = new URL(value);
    if (!['https:', 'http:'].includes(result.protocol) || result.username || result.password) throw new Error();
    return result.href;
  } catch { throw new Failure(400, `${field} 必须为完整 HTTP(S) 地址`); }
}
function requestKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new Failure(400, 'request_key 必须为 1–64 位字母、数字、下划线或短横线');
  return value;
}
export function landingConfig(body) {
  const image = body.card_image === undefined ? '' : body.card_image;
  if (typeof image !== 'string' || image.length > 2048) throw new Failure(400, 'card_image 格式错误');
  return {
    customer_id: text(body.customer_id, 'customer_id', 64),
    landing_url: url(body.landing_url, 'landing_url'),
    card_image: image.trim(),
    card_text: text(body.card_text ?? '欢迎访问平台', 'card_text', image.trim() ? 1024 : 4096),
    button_text: text(body.button_text ?? '立即了解', 'button_text', 64),
    webhook_secret: randomBytes(32).toString('hex'),
  };
}
export async function botApi(token, method, payload, fetcher = fetch) {
  let response;
  try {
    response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Failure(502, `Telegram ${method} 失败（${result.error_code || response.status}）`);
    return result.result;
  } catch (error) {
    if (error instanceof Failure) throw error;
    throw new Failure(502, `Telegram ${method} 请求失败`);
  }
}
function publicLanding(config) {
  const { webhook_secret, token, ...result } = config;
  return result;
}
function publicChannel(channel) {
  const { access_hash, posts, ...result } = channel;
  return { ...result, bot_url: `https://t.me/${channel.bot_username}?start=channel` };
}
export function createConversion({ store, connected, save, env = process.env, fetcher = fetch }) {
  return {
    async handleWebhook(botId, secret, update) {
      const config = await store.webhookBot(botId);
      if (!config) throw new Failure(404, 'Bot 未配置');
      const provided = Buffer.from(secret || ''); const expected = Buffer.from(config.webhook_secret);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new Failure(403, 'Webhook 密钥错误');
      const message = update?.message;
      if (message?.chat?.type !== 'private' || !/^\/start(?:@\w+)?(?:\s|$)/i.test(message.text || '')) return { ok: true };
      await botApi(config.token, config.card_image ? 'sendPhoto' : 'sendMessage', {
        chat_id: message.chat.id,
        ...(config.card_image ? { photo: config.card_image, caption: config.card_text } : { text: config.card_text }),
        reply_markup: { inline_keyboard: [[{ text: config.button_text, url: config.landing_url }]] },
      }, fetcher);
      return { ok: true };
    },
    async route(method, suffix, id, state, body) {
      const botRoute = suffix.match(/^bots\/([A-Za-z0-9_]+)\/(landing|webhook)$/);
      if (botRoute) {
        const [, username, action] = botRoute;
        const bot = await store.get(id, username);
        if (!bot) throw new Failure(404, 'Bot 不属于该账号或尚未创建');
        if (action === 'landing' && method === 'PUT') {
          const config = landingConfig(body);
          await store.configureLanding(id, bot.username, config);
          return publicLanding(await store.getLanding(id, username));
        }
        if (action === 'landing' && method === 'GET') {
          const config = await store.getLanding(id, username);
          if (!config) throw new Failure(404, '尚未配置客户落地页');
          return publicLanding(config);
        }
        if (action === 'webhook' && method === 'POST') {
          const config = await store.getLanding(id, username);
          if (!config) throw new Failure(400, '请先配置客户落地页');
          let base;
          try {
            base = new URL(env.PUBLIC_BASE_URL);
            if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username || base.password) throw new Error();
          } catch { throw new Failure(400, 'PUBLIC_BASE_URL 必须为公网 HTTPS 源地址，不含路径'); }
          const webhookUrl = `${base.origin}/webhooks/${bot.token.split(':')[0]}`;
          await botApi(bot.token, 'setWebhook', { url: webhookUrl, secret_token: config.webhook_secret, allowed_updates: ['message'] }, fetcher);
          await store.webhookRegistered(id, username, webhookUrl);
          return { username: bot.username, webhook_url: webhookUrl, status: 'registered' };
        }
        throw new Failure(404, '接口不存在');
      }
      const channelRoute = suffix.match(/^channels(?:\/([A-Za-z0-9_-]+)(?:\/(posts))?)?$/);
      if (!channelRoute) return undefined;
      const [, key, posts] = channelRoute;
      if (method === 'GET' && key && !posts) {
        const channel = await store.getChannel(id, requestKey(key));
        if (!channel) throw new Failure(404, 'Channel 不存在');
        return publicChannel(channel);
      }
      if (state.status !== 'authorized') throw new Failure(401, '请先完成 Telegram 登录');
      if (method === 'POST' && !key) {
        const request_key = requestKey(body.request_key);
        const title = text(body.title, 'title', 128);
        const about = body.about ?? '';
        if (typeof about !== 'string' || about.length > 255) throw new Failure(400, 'about 最多 255 字符');
        const botUsername = text(body.bot_username, 'bot_username', 32);
        const config = await store.getLanding(id, botUsername);
        if (!config) throw new Failure(400, '请先为该账号的 Bot 配置客户落地页');
        const existing = await store.getChannel(id, request_key);
        if (existing && (existing.title !== title || existing.about !== about || existing.bot_username.toLowerCase() !== botUsername.toLowerCase() || existing.customer_id !== config.customer_id)) throw new Failure(409, 'request_key 已用于其他 Channel 配置');
        if (existing?.status === 'ready') return publicChannel(existing);
        if (existing?.status === 'creating') throw new Failure(409, '上次创建结果不确定，请检查 Telegram，使用新 key 可能产生重复 Channel');
        if (!existing) await store.reserveChannel(id, { request_key, title, about, bot_username: config.bot_username, customer_id: config.customer_id });
        await connected(state, async client => {
          if (!await client.checkAuthorization()) throw new Failure(401, 'Telegram 会话已失效');
          let channel = existing;
          if (!channel) {
            const created = await client.createChannel({ title, about, megagroup: false });
            channel = { channel_id: created.id.toString(), access_hash: created.accessHash.toString() };
            state.pending_channel = { request_key, ...channel };
            await save(id, state);
            await store.saveChannel(id, request_key, channel);
            delete state.pending_channel;
            await save(id, state);
          }
          const peer = new Api.InputPeerChannel({ channelId: bigInt(channel.channel_id), accessHash: bigInt(channel.access_hash) });
          const invite = await client.invoke(new Api.messages.ExportChatInvite({ peer, title: 'Landing flow' }));
          if (!invite.link) throw new Failure(502, 'Telegram 未返回邀请链接');
          await store.channelReady(id, request_key, invite.link);
        });
        return publicChannel(await store.getChannel(id, request_key));
      }
      if (method === 'POST' && key && posts) {
        const channel = await store.getChannel(id, requestKey(key));
        if (!channel || channel.status !== 'ready') throw new Failure(400, '请先完成 Channel 创建');
        const config = await store.getLanding(id, channel.bot_username);
        if (!config || config.customer_id !== channel.customer_id) throw new Failure(409, 'Channel 与 Bot 客户配置不一致');
        const request_key = requestKey(body.request_key);
        const message_text = text(body.text, 'text', 3000);
        const bot_url = `https://t.me/${channel.bot_username}?start=channel`;
        if (`${message_text}\n\n打开助手：${bot_url}\n查看活动：${config.landing_url}`.length > 4096) throw new Failure(400, '帖子与链接合计不能超过 4096 字符');
        let post = await store.getPost(id, key, request_key);
        if (post && (post.message_text !== message_text || post.landing_url !== config.landing_url)) throw new Failure(409, 'request_key 已用于其他帖子内容');
        if (post?.status === 'sent') return post;
        if (!post) {
          post = { request_key, message_text, bot_url, landing_url: config.landing_url, random_id: (BigInt('0x' + randomBytes(8).toString('hex')) & 0x7fffffffffffffffn).toString() };
          await store.reservePost(id, key, post);
        }
        await connected(state, async client => {
          if (!await client.checkAuthorization()) throw new Failure(401, 'Telegram 会话已失效');
          const peer = new Api.InputPeerChannel({ channelId: bigInt(channel.channel_id), accessHash: bigInt(channel.access_hash) });
          const result = await client.invoke(new Api.messages.SendMessage({
            peer, message: `${post.message_text}\n\n打开助手：${post.bot_url}\n查看活动：${post.landing_url}`, randomId: bigInt(post.random_id), noWebpage: true,
          }));
          const messageId = result.id ?? result.updates?.find(item => item.message?.id)?.message?.id ?? null;
          await store.postReady(id, key, request_key, messageId);
        });
        return store.getPost(id, key, request_key);
      }
      throw new Failure(404, '接口不存在');
    },
  };
}
