import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const env=process.env;
if(!env.AUTH_HMAC_SECRET || env.AUTH_HMAC_SECRET.length<32)throw new Error('需要至少 32 字符的 AUTH_HMAC_SECRET');
const secrets={AUTH_HMAC_SECRET:env.AUTH_HMAC_SECRET};
for(const key of ['MAIL_API_KEY','TG_API_HASH'])if(env[key])secrets[key]=env[key];
const child=spawn(process.execPath,[fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url)),'secret','bulk','--config','wrangler.generated.json'],{
  cwd:fileURLToPath(new URL('../',import.meta.url)),env,stdio:['pipe','inherit','inherit'],
});
const completed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
child.stdin.on('error',()=>{});
// Secrets travel over stdin, never command arguments or a temporary file.
child.stdin.end(JSON.stringify(secrets));
if(await completed!==0)throw new Error('Worker Secrets 配置失败');
