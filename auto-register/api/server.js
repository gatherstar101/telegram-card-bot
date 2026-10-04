import http from 'node:http';
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { createStore } from './store.js';
import { Failure } from './errors.js';
import { createAuthRuntime } from './auth-runtime.js';
import { createService } from './service.js';

process.umask(0o077);
const store = await createStore();
const auth = await createAuthRuntime(store);
async function connected(state, operation) {
  const client = new TelegramClient(new StringSession(state.session || ''), state.api_id, state.api_hash, { connectionRetries: 3 });
  try { await client.connect(); return await operation(client); }
  finally { state.session = client.session.save(); await client.disconnect(); }
}
const service = createService({ store, auth, connected });
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const respond = (status, value) => { res.writeHead(status); res.end(JSON.stringify(value)); };
  try {
    if (req.method === 'GET' && req.url === '/health') return respond(200, { ok: true });
    const webhook = new URL(req.url, 'http://localhost').pathname.match(/^\/webhooks\/(\d+)$/);
    const path = new URL(req.url, 'http://localhost').pathname;
    const authRoute = path.startsWith('/auth/');
    const identity = !webhook && !authRoute ? await auth.authenticate(req.headers.authorization) : null;
    if (webhook && req.method !== 'POST') throw new Failure(405, 'Webhook 仅支持 POST');
    let content = '';
    for await (const chunk of req) {
      content += chunk.toString();
      if (Buffer.byteLength(content) > 16384) throw new Failure(413, '请求体过大');
    }
    let body = {};
    try { if (content) body = JSON.parse(content); } catch { throw new Failure(400, 'JSON 格式错误'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Failure(400, '请求体必须为 JSON 对象');
    if (webhook) return respond(200, await service.handleWebhook(webhook[1], req.headers['x-telegram-bot-api-secret-token'], body));
    if (authRoute) return respond(200, await auth.route(req.method, path, body, req.headers.authorization, req.socket.remoteAddress || 'unknown'));
    respond(200, await service.route(req.method, path, body, identity.user));
  } catch (e) {
    const status = e.status || (e.errorMessage?.startsWith('FLOOD_WAIT') ? 429 : e.errorMessage ? 422 : 500);
    if(status===429&&e.retry_after)res.setHeader('Retry-After',String(e.retry_after));
    respond(status, { ...(e.retry_after?{retry_after:e.retry_after}:{}),error: e.status ? e.message : e.errorMessage || '服务内部错误' });
  }
});
server.requestTimeout = 300000;
server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('Telegram API service started'));
