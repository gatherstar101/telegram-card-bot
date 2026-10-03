import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if (!/^\d+$/.test(process.env.TG_API_ID || '') || !/^[a-f0-9]{32}$/i.test(process.env.TG_API_HASH || '')) throw new Error('需要 TG_API_ID 和 TG_API_HASH；探测不需要手机号或验证码');
const child=spawn(process.execPath,[fileURLToPath(new URL('../node_modules/vitest/vitest.mjs',import.meta.url)),'run','test/telegram-probe.test.js'],{
  cwd:fileURLToPath(new URL('../',import.meta.url)),stdio:'inherit',env:{...process.env,TELEGRAM_PROBE:'1'},
});
child.once('error',error=>{console.error(error.message);process.exitCode=1;});
child.once('exit',code=>{process.exitCode=code ?? 1;});
