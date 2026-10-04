import { createCipheriv,createDecipheriv,randomBytes,timingSafeEqual } from 'node:crypto';
import { Failure } from '../../auto-register/api/errors.js';
import { digest } from '../../auto-register/api/auth.js';

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
  const key=`${env.AUTH_STATE_PREFIX||'telegram-bot:'}limit:${kind}:${digest(String(value))}`;
  if(await cache.increment(key,seconds)>max) {
    const error=new Failure(429,'请求过于频繁，请稍后重试');
    error.retry_after=cache.ttl?await cache.ttl(key):seconds;
    throw error;
  }
}
export function audit(event,fields={}) {
  // Call sites supply only fixed action names, UUIDs, HTTP statuses and counts.
  // Never log body, headers, raw URL, exception text or external API URL.
  console.log(JSON.stringify({event,...fields}));
}
