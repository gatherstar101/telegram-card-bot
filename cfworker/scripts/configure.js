import { readFile,writeFile } from 'node:fs/promises';

const base = new URL('../',import.meta.url);
const config = JSON.parse(await readFile(new URL('wrangler.jsonc',base),'utf8'));
const env = process.env;
const required = name => {
  if (!env[name]?.trim()) throw new Error(`需要环境变量 ${name}`);
  return env[name].trim();
};
config.account_id = required('CLOUDFLARE_ACCOUNT_ID');
if (!/^[a-f0-9]{32}$/i.test(config.account_id)) throw new Error('CLOUDFLARE_ACCOUNT_ID 格式错误');
config.name = env.CF_WORKER_NAME || config.name;
if (!/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(config.name)) throw new Error('CF_WORKER_NAME 格式错误');
config.d1_databases[0].database_id = required('CF_D1_DATABASE_ID');
if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(config.d1_databases[0].database_id) || /^0+-0+-0+-0+-0+$/.test(config.d1_databases[0].database_id)) throw new Error('CF_D1_DATABASE_ID 必须为已创建 D1 数据库的 UUID');
config.d1_databases[0].database_name = env.CF_D1_DATABASE_NAME || config.d1_databases[0].database_name;
if (!/^[A-Za-z0-9_-]{1,64}$/.test(config.d1_databases[0].database_name)) throw new Error('CF_D1_DATABASE_NAME 格式错误');
config.limits.cpu_ms = Number(env.CF_CPU_MS || 30000);
if (!Number.isInteger(config.limits.cpu_ms) || config.limits.cpu_ms < 10 || config.limits.cpu_ms > 300000) throw new Error('CF_CPU_MS 必须在 10–300000 范围内');
for (const name of [...Object.keys(config.vars),'TG_API_ID','TG_PHONE','TG_BOT_NAME','TG_BOT_USERNAME']) {
  if (env[name] !== undefined) config.vars[name] = env[name];
}
for (const [name,min,max] of [['AUTH_CHALLENGE_TTL_SECONDS',60,3600],['AUTH_SESSION_TTL_SECONDS',60,86400]]) {
  const value = Number(config.vars[name]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} 范围为 ${min}–${max}`);
}
// AUTH_HMAC_SECRET, MAIL_API_KEY, TG_API_HASH and Cloudflare API tokens are
// deliberately excluded. They must be provisioned as encrypted Worker secrets.
await writeFile(new URL('wrangler.generated.json',base),JSON.stringify(config,null,2)+'\n',{mode:0o600});
console.log('已生成 wrangler.generated.json；密钥请通过 wrangler secret put 配置。');
