import { wrangler } from './wrangler.js';
const name=process.env.CF_D1_DATABASE_NAME || 'telegram_cfworker';
if(!/^[A-Za-z0-9_-]{1,64}$/.test(name))throw new Error('CF_D1_DATABASE_NAME 格式错误');
if(!process.env.CLOUDFLARE_ACCOUNT_ID)throw new Error('需要 CLOUDFLARE_ACCOUNT_ID');
await wrangler(['d1','create',name,'--config','wrangler.jsonc','--update-config=false']);
console.log('将输出的 database_id 填入 .env 的 CF_D1_DATABASE_ID，再执行 npm run configure。');
