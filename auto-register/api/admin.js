import { randomUUID } from 'node:crypto';
import { emailAddress, hashPassword, passwordValue } from './auth.js';
import { Failure } from './errors.js';

export function adminConfiguration(env) {
  const email = env.ADMIN_EMAIL || '';
  const password = env.ADMIN_PASSWORD || '';
  if (!email || !password) throw new Error('ADMIN_EMAIL 和 ADMIN_PASSWORD 必须同时设置');
  try { return { email: emailAddress(email), password: passwordValue(password) }; }
  catch { throw new Error('管理员初始化配置无效：需要有效邮箱和 12–128 字符密码'); }
}

export async function bootstrapAdmin(store, env) {
  const config = adminConfiguration(env);
  return store.initializeAdmin({ id: randomUUID(), email: config.email, password_hash: await hashPassword(config.password) });
}

export function publicUser(user) {
  if (!user) throw new Failure(404, '用户不存在');
  return { id: user.id, email: user.email, role: user.role, disabled: Boolean(Number(user.disabled)), created_at: user.created_at };
}

export async function userPatch(body) {
  const keys = Object.keys(body);
  if (!keys.length || keys.some(key => !['email', 'password', 'disabled'].includes(key))) throw new Failure(400, '仅支持修改 email、password、disabled');
  const patch = {};
  if (Object.hasOwn(body, 'email')) patch.email = emailAddress(body.email);
  if (Object.hasOwn(body, 'password')) patch.password_hash = await hashPassword(body.password);
  if (Object.hasOwn(body, 'disabled')) {
    if (typeof body.disabled !== 'boolean') throw new Failure(400, 'disabled 必须为布尔值');
    patch.disabled = body.disabled;
  }
  return patch;
}

const uuid = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export function adminOperation(method, path) {
  const target = path.match(/^\/admin\/users\/([^/]+)(?:\/disabled)?$/)?.[1];
  const target_id = target && uuid(target) ? target : null;
  let action = 'admin.unknown';
  if (path === '/admin/login' && method === 'POST') action = 'admin.login';
  if (path === '/admin/users' && method === 'GET') action = 'users.list';
  if (path === '/admin/audit-logs' && method === 'GET') action = 'audit.list';
  if (path === '/admin/credentials/rewrap' && method === 'POST') action = 'credentials.rewrap';
  if (target_id && method === 'GET' && !path.endsWith('/disabled')) action = 'users.get';
  if (target_id && method === 'PATCH' && !path.endsWith('/disabled')) action = 'users.update';
  if (target_id && method === 'PUT' && path.endsWith('/disabled')) action = 'users.disabled';
  return { action, target_id };
}

export async function adminRoute({ store, method, path, url, body, context }) {
  const limitValue = url.searchParams.get('limit') ?? '50';
  const limit = Number(limitValue);
  if (!/^\d+$/.test(limitValue) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Failure(400, 'limit 必须为 1–100');
  if (context.action === 'users.list') {
    const after = url.searchParams.get('after') || '';
    if (after && !uuid(after)) throw new Failure(400, 'after 无效');
    const users = (await store.adminUsers(after, limit)).map(publicUser);
    return { users, next_cursor: users.length === limit ? users.at(-1).id : null };
  }
  if (context.action === 'users.get') {
    const user = publicUser(await store.userById(context.target_id));
    return { ...user, accounts: await store.accountsForUser(user.id) };
  }
  if (['users.update', 'users.disabled'].includes(context.action)) {
    if (context.action === 'users.disabled' && (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'disabled'))) throw new Failure(400, '需要 disabled 布尔值');
    const patch = await userPatch(body);
    const user = await store.adminUpdateUser(context.target_id, patch, context);
    context.recorded = true;
    return { ok: true, user };
  }
  if (context.action === 'credentials.rewrap') {
    const result = await store.rewrap(body.table, body.cursor ?? '', body.limit ?? 50, context);
    context.recorded = true;
    return result;
  }
  if (context.action === 'audit.list') {
    const before = url.searchParams.get('before') || '';
    const target = url.searchParams.get('user_id') || '';
    if ((before && (!/^[1-9]\d{0,18}$/.test(before) || BigInt(before)>9223372036854775807n)) || (target && !uuid(target))) throw new Failure(400, '审计查询游标或 user_id 无效');
    const logs = await store.auditLogs(before, target, limit);
    return { logs, next_cursor: logs.length === limit ? String(logs.at(-1).id) : null };
  }
  throw new Failure(404, '接口不存在');
}
