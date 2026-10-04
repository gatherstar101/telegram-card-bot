import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Api } from 'teleproto';
import { computeCheck } from 'teleproto/Password.js';
import { Failure } from './errors.js';
import { createConversion } from './conversion.js';

export function createService({ store, auth, connected, env = process.env }) {
const busy = new Set();
function requireValue(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Failure(400, `缺少 ${name}`);
  return value.trim();
}
async function load(id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Failure(400, '无效 account_id');
  const state = await store.getAccount(id);
  if (!state) throw new Failure(404, '账号不存在');
  return state;
}
async function save(id, state) { await store.saveAccount(id, state); }
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
const conversion = createConversion({ store, connected, save, env });
async function route(method, path, body, user) {
  if (method === 'GET' && path === '/v1/accounts') return { accounts: await store.accountsForUser(user.id) };
  if (method === 'POST' && path === '/v1/login/start') {
    const phone = requireValue(body.phone ?? env.TG_PHONE, 'phone');
    const api_id = Number(body.api_id ?? env.TG_API_ID);
    const api_hash = requireValue(body.api_hash ?? env.TG_API_HASH, 'api_hash');
    if (!Number.isSafeInteger(api_id) || api_id <= 0 || !/^[a-f0-9]{32}$/i.test(api_hash) || !/^\+\d{7,15}$/.test(phone)) throw new Failure(400, 'App 凭据或手机号格式错误');
    // Serialize by phone even when callers start separate login attempts.
    if (busy.has(phone)) throw new Failure(409, '该手机号正在操作');
    busy.add(phone);
    let release;
    try {
      release = await auth.lockPhone(phone);
      const id = randomUUID();
      const state = { user_id: user.id, api_id, api_hash, phone, status: 'code_required' };
      const delivery = await connected(state, async client => {
        const result = await client.sendCode({ apiId: api_id, apiHash: api_hash }, phone);
        if (result.emailRequired || result.emailCodeSent) throw new Failure(422, '此账号需要额外邮箱验证，当前接口不支持');
        state.phone_code_hash = result.phoneCodeHash;
        return result.isCodeViaApp ? 'telegram_app' : 'other';
      });
      state.expires_at = Date.now() + 10 * 60 * 1000;
      await save(id, state);
      return { account_id: id, status: state.status, delivery };
    } finally { busy.delete(phone); await release?.(); }
  }
  const match = path.match(/^\/v1\/accounts\/([a-f0-9-]+)(?:\/(.*))?$/);
  if (!match) throw new Failure(404, '接口不存在');
  const [, id, suffix = ''] = match;
  const [action, username] = suffix.split('/');
  await auth.requireAccount(user.id, id);
  const initial = await load(id);
  if (initial.user_id !== user.id) throw new Failure(404, '账号不存在');
  if (busy.has(initial.phone)) throw new Failure(409, '该账号正在操作，请稍后重试');
  busy.add(initial.phone);
  let release;
  try {
    release = await auth.lockPhone(initial.phone);
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
      const name = requireValue(body.name ?? env.TG_BOT_NAME, 'name');
      const user = requireValue(body.username ?? env.TG_BOT_USERNAME, 'username');
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
        // Persist the remote result before inserting the bot record.
        state.pending_bot = bot;
        await save(id, state);
        await store.save(id, bot);
        delete state.pending_bot;
        await save(id, state);
      });
      return bot;
    }
    throw new Failure(404, '接口不存在');
  } finally { busy.delete(initial.phone); await release?.(); }
}
return { route, handleWebhook: conversion.handleWebhook };
}
