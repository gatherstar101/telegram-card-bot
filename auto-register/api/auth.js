import { createHash, createHmac, randomBytes, randomInt, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Failure } from './errors.js';

const scrypt = promisify(scryptCallback);
export const CHALLENGE_TTL = 600;
export const SESSION_TTL = 7200;
export function emailAddress(value) {
  if (typeof value !== 'string') throw new Failure(400, '需要有效邮箱');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email)) throw new Failure(400, '邮箱格式错误');
  return email;
}
function passwordValue(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) throw new Failure(400, '密码必须为 12–128 字符');
  return value;
}
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(passwordValue(password), salt, 64);
  return `${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  const [salt, hex] = (stored || '').split(':');
  if (!salt || !/^[a-f0-9]{128}$/.test(hex || '')) return false;
  const actual = await scrypt(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(hex, 'hex'));
}
export const digest = value => createHash('sha256').update(value).digest('hex');
// OTP matching, five-attempt limit and consumption happen in one Redis operation.
export const consumeChallengeScript = `
local value = redis.call('GET', KEYS[1])
if not value then return {0, ''} end
local challenge = cjson.decode(value)
if challenge.purpose ~= ARGV[2] then return {0, ''} end
if challenge.code_hash ~= ARGV[1] then
  challenge.attempts = (challenge.attempts or 0) + 1
  if challenge.attempts >= 5 then redis.call('DEL', KEYS[1])
  else redis.call('SET', KEYS[1], cjson.encode(challenge), 'KEEPTTL') end
  return {0, ''}
end
redis.call('DEL', KEYS[1])
return {1, value}
`;
const rateScript = `local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n`;
const releaseScript = `if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0`;

export function createAuth({ redis, cache, store, sendCode, secret, prefix = 'telegram-bot:', challengeTTL = CHALLENGE_TTL, sessionTTL = SESSION_TTL, now = Date.now, lockTTL = 300 }) {
  // Storage operations have explicit semantics; the Worker supplies a Durable
  // Object implementation, while Docker continues to use atomic Redis scripts.
  const state = cache || {
    get: key => redis.get(key),
    ttl: key => redis.ttl ? redis.ttl(key) : 60,
    set: (key, value, options) => redis.set(key, value, options),
    del: key => redis.del(key),
    increment: (key, seconds) => redis.eval(rateScript, { keys: [key], arguments: [String(seconds)] }),
    consume: (key, hash, purpose) => redis.eval(consumeChallengeScript, { keys: [key], arguments: [hash, purpose] }),
    release: (key, lease) => redis.eval(releaseScript, { keys: [key], arguments: [lease] }),
  };
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('AUTH_HMAC_SECRET 至少需要 32 字符');
  if (!Number.isInteger(challengeTTL) || challengeTTL < 60 || challengeTTL > 3600 || !Number.isInteger(sessionTTL) || sessionTTL < 60 || sessionTTL > 86400) throw new Error('验证码 TTL 需为 60–3600 秒，登录态 TTL 需为 60–86400 秒');
  const challengeKey = id => `${prefix}challenge:${id}`;
  const sessionKey = token => `${prefix}session:${digest(token)}`;
  const otpHash = (id, code) => createHmac('sha256', secret).update(`${id}:${code}`).digest('hex');
  const safeUser = user => ({ id: user.id, email: user.email });
  async function limit(kind, value, maximum, seconds = challengeTTL) {
    const count = await state.increment(`${prefix}rate:${kind}:${digest(value)}`, seconds);
    if (Number(count)>maximum) {
      const error=new Failure(429,'请求过于频繁，请稍后重试');
      error.retry_after=state.ttl?Math.max(1,await state.ttl(`${prefix}rate:${kind}:${digest(value)}`)):seconds;
      throw error;
    }
  }
  async function issue(purpose, email, values) {
    await limit('email', email, 5);
    const cooldown = `${prefix}mail-cooldown:${digest(email)}`;
    if (!await state.set(cooldown, '1', { NX: true, EX: 60 })) {
      const error=new Failure(429,'请等待 60 秒后再发送邮件验证码');
      error.retry_after=state.ttl?Math.max(1,await state.ttl(cooldown)):60;
      throw error;
    }
    const id = randomUUID(); const code = String(randomInt(100000, 1000000));
    await state.set(challengeKey(id), JSON.stringify({ purpose, email, ...values, code_hash: otpHash(id, code), attempts: 0 }), { EX: challengeTTL });
    try { await sendCode(email, code, purpose); }
    catch {
      await state.del(challengeKey(id));
      throw new Failure(503, '验证码邮件发送失败，请检查邮件服务后重试');
    }
    return { challenge_id: id, status: 'email_code_required', expires_in: challengeTTL };
  }
  async function consume(body, purpose, ip) {
    await limit('verify-ip', ip, 60);
    if (typeof body.challenge_id !== 'string' || !/^[a-f0-9-]{36}$/.test(body.challenge_id) || !/^\d{6}$/.test(body.code || '')) throw new Failure(400, '需要 challenge_id 和 6 位邮件验证码');
    const [success, raw] = await state.consume(challengeKey(body.challenge_id), otpHash(body.challenge_id, String(body.code)), purpose);
    if (Number(success) !== 1) throw new Failure(401, '验证码错误、已使用或已过期');
    return JSON.parse(raw);
  }
  async function session(user) {
    const token = randomBytes(32).toString('hex');
    await state.set(sessionKey(token), JSON.stringify({ user_id: user.id, auth_version: user.auth_version || 0, expires_at: now() + sessionTTL * 1000 }), { EX: sessionTTL });
    return { access_token: token, token_type: 'Bearer', expires_in: sessionTTL, user: safeUser(user) };
  }
  async function authenticate(header) {
    const token = typeof header === 'string' ? header.match(/^Bearer ([a-f0-9]{64})$/)?.[1] : null;
    if (!token) throw new Failure(401, '请先登录，提供有效 Bearer 登录凭据');
    const raw = await state.get(sessionKey(token));
    if (!raw) throw new Failure(401, '登录状态已失效，请重新登录');
    const data = JSON.parse(raw);
    if (data.expires_at <= now()) throw new Failure(401, '登录状态已过期，请重新登录');
    const user = await store.userById(data.user_id);
    if (!user || user.disabled || (data.auth_version || 0) !== (user.auth_version || 0)) throw new Failure(401, '登录状态已撤销');
    return { user: { ...safeUser(user),auth_version:user.auth_version || 0 }, token };
  }
  return {
    authenticate,
    async requireAccount(userId, accountId) {
      if (!await store.ownsAccount(userId, accountId)) throw new Failure(404, '账号不存在');
    },
    async lockPhone(phone) {
      const lockKey = `${prefix}telegram-lock:${digest(phone)}`;
      const lease = randomBytes(16).toString('hex');
      if (!await state.set(lockKey, lease, { NX: true, EX: lockTTL })) throw new Failure(409, '该 Telegram 账号正在操作');
      return async () => state.release(lockKey, lease);
    },
    async route(method, path, body, header, ip) {
      if (method === 'POST' && path === '/auth/register/start') {
        await limit('auth-ip', ip, 20);
        const email = emailAddress(body.email);
        passwordValue(body.password);
        if (await store.userByEmail(email)) throw new Failure(409, '该邮箱已注册，请登录');
        return issue('register', email, { password_hash: await hashPassword(body.password) });
      }
      if (method === 'POST' && path === '/auth/register/verify') {
        const challenge = await consume(body, 'register', ip);
        const user = { id: randomUUID(), email: challenge.email, password_hash: challenge.password_hash };
        try { await store.createUser(user); }
        catch (error) { if (['ER_DUP_ENTRY','23505'].includes(error.code)) throw new Failure(409, '该邮箱已注册，请登录'); throw error; }
        return session(user);
      }
      if (method === 'POST' && path === '/auth/login/start') {
        await limit('auth-ip', ip, 20);
        const email = emailAddress(body.email);
        passwordValue(body.password);
        await limit('password-email', email, 10);
        const user = await store.userByEmail(email);
        // Do comparable password work even when the email does not exist.
        const fallback = '00000000000000000000000000000000:' + '00'.repeat(64);
        const matches = await verifyPassword(body.password, user?.password_hash || fallback);
        if (!user || user.disabled || !matches) throw new Failure(401, '邮箱或密码错误');
        return issue('login', email, { user_id: user.id, auth_version: user.auth_version || 0 });
      }
      if (method === 'POST' && path === '/auth/login/verify') {
        const challenge = await consume(body, 'login', ip);
        const user = await store.userById(challenge.user_id);
        if (!user || user.disabled || (challenge.auth_version || 0)!==(user.auth_version || 0)) throw new Failure(401, '用户不存在或登录验证已撤销');
        return session(user);
      }
      if (method === 'POST' && path === '/auth/logout-all' && store.revokeSessions) {
        const {user}=await authenticate(header);
        await store.revokeSessions(user.id);
        return {ok:true};
      }
      if (method === 'POST' && path === '/auth/password' && store.changePassword) {
        const {user}=await authenticate(header);
        const current=await store.userById(user.id);
        passwordValue(body.current_password);passwordValue(body.new_password);
        await limit('password-change',user.id,5);
        if(!await verifyPassword(body.current_password,current.password_hash))throw new Failure(401,'当前密码错误');
        await store.changePassword(user.id,await hashPassword(body.new_password));
        return {ok:true,status:'login_required'};
      }
      if (method === 'GET' && path === '/auth/me') return safeUser((await authenticate(header)).user);
      if (method === 'POST' && path === '/auth/logout') {
        const { token } = await authenticate(header);
        await state.del(sessionKey(token));
        return { ok: true };
      }
      throw new Failure(404, '接口不存在');
    },
  };
}
