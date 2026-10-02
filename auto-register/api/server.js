import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { TelegramClient, Api } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { computeCheck } from 'teleproto/Password.js';
import { createStore } from './store.js';
import { Failure } from './errors.js';
import { createConversion } from './conversion.js';

process.umask(0o077);
const key = process.env.API_KEY;
if (!key || key.length < 32) throw new Error('API_KEY 必须至少 32 字符');
const directory = process.env.DATA_DIR || './data';
await mkdir(directory, { recursive: true, mode: 0o700 });
const store = await createStore();
const busy = new Set();
function requireValue(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Failure(400, `缺少 ${name}`);
  return value.trim();
}
function statePath(id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Failure(400, '无效 account_id');
  return join(directory, `${id}.json`);
}
async function load(id) {
  try { return JSON.parse(await readFile(statePath(id), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') throw new Failure(404, '账号不存在'); throw e; }
}
async function save(id, state) {
  const path = statePath(id);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, path);
}
async function connected(state, operation) {
  const client = new TelegramClient(new StringSession(state.session || ''), state.api_id, state.api_hash, { connectionRetries: 3 });
  try { await client.connect(); return await operation(client); }
  finally { state.session = client.session.save(); await client.disconnect(); }
}
async function exchange(client, peer, text) {
  const sent = await client.sendMessage(peer, { message: text });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const messages = await client.getMessages(peer, { minId: sent.id, limit: 10 });
    const reply = [...messages].filter(m => !m.out && m.id > sent.id).sort((a,b) => a.id-b.id)[0];
    if (reply) return reply.message || '';
    await sleep(1000);
  }
  throw new Failure(504, 'BotFather 回复超时；请先检查对话，再重试创建');
}
const conversion = createConversion({ store, connected, save });
async function route(method, path, body) {
  if (method === 'POST' && path === '/v1/login/start') {
    const phone = requireValue(body.phone ?? process.env.TG_PHONE, 'phone');
    const api_id = Number(body.api_id ?? process.env.TG_API_ID);
    const api_hash = requireValue(body.api_hash ?? process.env.TG_API_HASH, 'api_hash');
    if (!Number.isSafeInteger(api_id) || api_id <= 0 || !/^[a-f0-9]{32}$/i.test(api_hash) || !/^\+\d{7,15}$/.test(phone)) throw new Failure(400, 'App 凭据或手机号格式错误');
    // Serialize by phone even when callers start separate login attempts.
    if (busy.has(phone)) throw new Failure(409, '该手机号正在操作');
    busy.add(phone);
    try {
      const id = randomUUID();
      const state = { api_id, api_hash, phone, status: 'code_required' };
      const delivery = await connected(state, async client => {
        const result = await client.sendCode({ apiId: api_id, apiHash: api_hash }, phone);
        if (result.emailRequired || result.emailCodeSent) throw new Failure(422, '此账号需要额外邮箱验证，当前接口不支持');
        state.phone_code_hash = result.phoneCodeHash;
        return result.isCodeViaApp ? 'telegram_app' : 'other';
      });
      state.expires_at = Date.now() + 10 * 60 * 1000;
      await save(id, state);
      return { account_id: id, status: state.status, delivery };
    } finally { busy.delete(phone); }
  }
  const match = path.match(/^\/v1\/accounts\/([a-f0-9-]+)(?:\/(.*))?$/);
  if (!match) throw new Failure(404, '接口不存在');
  const [, id, suffix = ''] = match;
  const [action, username] = suffix.split('/');
  const initial = await load(id);
  if (busy.has(initial.phone)) throw new Failure(409, '该账号正在操作，请稍后重试');
  busy.add(initial.phone);
  try {
    const state = await load(id);
    if (state.pending_bot) {
      const recovered = await store.get(id, state.pending_bot.username);
      if (!recovered) await store.save(id, state.pending_bot);
      delete state.pending_bot;
      await save(id, state);
    }
    if (state.pending_channel) {
      const pending = state.pending_channel;
      await store.saveChannel(id, pending.request_key, pending);
      delete state.pending_channel;
      await save(id, state);
    }
    const converted = await conversion.route(method, suffix, id, state, body);
    if (converted !== undefined) return converted;
    if (method === 'GET' && !action) return { account_id: id, status: state.status };
    if (method === 'POST' && suffix === 'verify') {
      if (state.status === 'authorized') return { account_id: id, status: state.status };
      if (Date.now() > state.expires_at) throw new Failure(410, '登录流程过期，请重新发送验证码');
      await connected(state, async client => {
        if (state.status === 'code_required') {
          try {
            const result = await client.invoke(new Api.auth.SignIn({ phoneNumber: state.phone, phoneCodeHash: state.phone_code_hash, phoneCode: requireValue(body.code, 'code') }));
            if (result instanceof Api.auth.AuthorizationSignUpRequired) throw new Failure(422, '需要已注册的 Telegram 用户账号');
            state.status = 'authorized';
          } catch (e) {
            if (e.errorMessage !== 'SESSION_PASSWORD_NEEDED') throw e;
            state.status = 'password_required';
          }
        }
        if (state.status === 'password_required' && body.password) {
          const settings = await client.invoke(new Api.account.GetPassword());
          await client.invoke(new Api.auth.CheckPassword({ password: await computeCheck(settings, requireValue(body.password, 'password')) }));
          state.status = 'authorized';
        }
        if (state.status === 'authorized') {
          if ((await client.getMe()).bot) throw new Failure(422, '必须使用个人账号');
          delete state.phone_code_hash;
          delete state.expires_at;
        }
      });
      await save(id, state);
      return { account_id: id, status: state.status };
    }
    if (action === 'bots' && method === 'GET' && username && suffix.split('/').length === 2) {
      const bot = await store.get(id, username);
      if (!bot) throw new Failure(404, '未找到本服务保存的 Bot');
      return bot;
    }
    if (method === 'POST' && suffix === 'bots') {
      if (state.status !== 'authorized') throw new Failure(401, '请先完成 Telegram 登录');
      const name = requireValue(body.name ?? process.env.TG_BOT_NAME, 'name');
      const user = requireValue(body.username ?? process.env.TG_BOT_USERNAME, 'username');
      if (name.length > 64 || !/^[a-z][a-z0-9_]{4,31}$/i.test(user) || !/bot$/i.test(user)) throw new Failure(400, '机器人名称或用户名格式错误');
      const existing = await store.get(id, user);
      if (existing) return existing;
      let bot;
      await connected(state, async client => {
        if (!await client.checkAuthorization()) throw new Failure(401, 'Telegram 会话已失效，请重新登录');
        const peer = await client.getEntity('BotFather');
        await exchange(client, peer, '/cancel');
        if (!/name/i.test(await exchange(client, peer, '/newbot'))) throw new Failure(422, 'BotFather 未接受创建，请检查对话或账号限制');
        if (!/username/i.test(await exchange(client, peer, name))) throw new Failure(422, 'BotFather 未接受名称，请检查对话');
        const reply = await exchange(client, peer, user);
        const token = reply.match(/\b\d+:[A-Za-z0-9_-]{30,}\b/)?.[0];
        if (!token) throw new Failure(422, 'BotFather 未返回 Token，请检查用户名占用或创建限制');
        bot = { username: user, name, token, url: `https://t.me/${user}` };
        // Recovery journal covers a database outage after remote bot creation.
        state.pending_bot = bot;
        await save(id, state);
        await store.save(id, bot);
        delete state.pending_bot;
        await save(id, state);
      });
      return bot;
    }
    throw new Failure(404, '接口不存在');
  } finally { busy.delete(initial.phone); }
}
function authorized(header) {
  const a = Buffer.from(header || ''); const b = Buffer.from(`Bearer ${key}`);
  return a.length === b.length && timingSafeEqual(a,b);
}
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const respond = (status, value) => { res.writeHead(status); res.end(JSON.stringify(value)); };
  try {
    if (req.method === 'GET' && req.url === '/health') return respond(200, { ok: true });
    const webhook = new URL(req.url, 'http://localhost').pathname.match(/^\/webhooks\/(\d+)$/);
    if (!webhook && !authorized(req.headers.authorization)) throw new Failure(401, '需要有效 Bearer API_KEY');
    if (webhook && req.method !== 'POST') throw new Failure(405, 'Webhook 仅支持 POST');
    let content = '';
    for await (const chunk of req) {
      content += chunk.toString();
      if (Buffer.byteLength(content) > 16384) throw new Failure(413, '请求体过大');
    }
    let body = {};
    try { if (content) body = JSON.parse(content); } catch { throw new Failure(400, 'JSON 格式错误'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Failure(400, '请求体必须为 JSON 对象');
    if (webhook) return respond(200, await conversion.handleWebhook(webhook[1], req.headers['x-telegram-bot-api-secret-token'], body));
    respond(200, await route(req.method, new URL(req.url, 'http://localhost').pathname, body));
  } catch (e) {
    const status = e.status || (e.errorMessage?.startsWith('FLOOD_WAIT') ? 429 : e.errorMessage ? 422 : 500);
    respond(status, { error: e.status ? e.message : e.errorMessage || '服务内部错误' });
  }
});
server.requestTimeout = 300000;
server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('Telegram API service started'));
