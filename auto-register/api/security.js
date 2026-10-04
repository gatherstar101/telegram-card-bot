import { createCipheriv,createDecipheriv,randomBytes,timingSafeEqual } from 'node:crypto';
import { Failure } from './errors.js';
import { digest } from './auth.js';

export function integer(env,name,fallback,min=1,max=100000) {
  const value=Number(env[name] ?? fallback);
  if(!Number.isInteger(value)||value<min||value>max)throw new Failure(503,`运行配置 ${name} 无效`);
  return value;
}
export function credentials(env,{allowPlaintext=false}={}) {
  let keys;
  try { keys=JSON.parse(env.CREDENTIAL_KEYS || '{}'); } catch { throw new Failure(503,'凭据加密配置无效'); }
  if(!keys||typeof keys!=='object'||Array.isArray(keys))throw new Failure(503,'凭据加密配置无效');
  const id=env.CREDENTIAL_KEY_ID;
  if(!id || !/^[A-Za-z0-9_-]{1,32}$/.test(id) || !keys[id])throw new Failure(503,'需要配置 CREDENTIAL_KEYS 和 CREDENTIAL_KEY_ID');
  const keyFor=name=>{
    const encoded=keys[name];
    if(typeof encoded!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(encoded))throw new Failure(503,'凭据加密密钥不可用');
    const key=Buffer.from(encoded,'base64');
    if(key.length!==32)throw new Failure(503,'凭据加密密钥需为 32 字节');
    return key;
  };
  keyFor(id);
  return {
    seal(value,context) {
      if(value===null||value===undefined)return null;
      const nonce=randomBytes(12);
      const cipher=createCipheriv('aes-256-gcm',keyFor(id),nonce);
      cipher.setAAD(Buffer.from(context));
      const data=Buffer.concat([cipher.update(String(value),'utf8'),cipher.final()]);
      return `enc:${id}:${nonce.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
    },
    open(value,context) {
      if(value===null||value===undefined)return null;
      if(!String(value).startsWith('enc:')) {
        if(allowPlaintext)return String(value);
        throw new Failure(503,'旧凭据需要管理员迁移');
      }
      const [marker,name,nonce,tag,data,...extra]=value.split(':');
      if(extra.length||marker!=='enc'||!name||!nonce||!tag||data===undefined)throw new Failure(503,'凭据数据无效');
      try {
        const cipher=createDecipheriv('aes-256-gcm',keyFor(name),Buffer.from(nonce,'base64'));
        cipher.setAAD(Buffer.from(context));cipher.setAuthTag(Buffer.from(tag,'base64'));
        return Buffer.concat([cipher.update(Buffer.from(data,'base64')),cipher.final()]).toString('utf8');
      } catch { throw new Failure(503,'凭据解密失败'); }
    },
    current:value=>value===null||String(value).startsWith(`enc:${id}:`),
  };
}
export function requireAdmin(request,env) {
  if(typeof env.ADMIN_API_KEY!=='string'||env.ADMIN_API_KEY.length<32)throw new Failure(503,'管理员接口未配置');
  const provided=Buffer.from(request.headers.get('Authorization')||'');
  const expected=Buffer.from(`Bearer ${env.ADMIN_API_KEY}`);
  if(provided.length!==expected.length||!timingSafeEqual(provided,expected))throw new Failure(401,'管理员凭据无效');
}
export async function rate(cache,env,kind,value,max,seconds=60) {
  const key=`${env.REDIS_KEY_PREFIX||'telegram-bot:'}limit:${kind}:${digest(String(value))}`;
  if(await cache.increment(key,seconds)>max) {
    const error=new Failure(429,'请求过于频繁，请稍后重试');
    error.retry_after=cache.ttl?Math.max(1,await cache.ttl(key)):seconds;
    throw error;
  }
}
export function audit(event,fields={}) {
  // Call sites supply only fixed action names, UUIDs, HTTP statuses and counts.
  // Never log body, headers, raw URL, exception text or external API URL.
  console.log(JSON.stringify({event,...fields}));
}

export function validateConfig(env) {
  credentials(env);
  for(const [name,fallback,min,max] of [
    ['OTP_IP_QPS',1,1,100],['API_IP_PER_MINUTE',120,1,10000],['API_USER_PER_MINUTE',60,1,10000],['WEBHOOK_IP_PER_MINUTE',1200,1,10000],
    ['TG_LOGIN_PER_TEN_MINUTES',5,1,20],['TG_CREATE_PER_TEN_MINUTES',10,1,100],['MAX_TG_ACCOUNTS_PER_USER',5,1,100],['MAX_BOTS_PER_USER',20,1,1000],['MAX_CHANNELS_PER_USER',50,1,1000],
    ['TELEGRAM_TIMEOUT_SECONDS',60,15,240],['JOB_TIMEOUT_SECONDS',240,30,240],['JOB_QUEUE_LIMIT',20,1,100],['JOB_RETENTION_SECONDS',604800,86400,2592000],
    ['WEBHOOK_CHAT_PER_MINUTE',5,1,60],['WEBHOOK_BOT_PER_MINUTE',300,1,3000],['WEBHOOK_QUEUE_LIMIT',500,1,10000],['WEBHOOK_RETENTION_SECONDS',604800,172800,2592000],
    ['QUEUE_POLL_INTERVAL_MS',1000,100,10000],['TRUST_PROXY_HOPS',0,0,10],['MYSQL_POOL_SIZE',10,1,100],['MYSQL_CONNECT_TIMEOUT_MS',5000,1000,30000]
  ])integer(env,name,fallback,min,max);
}
