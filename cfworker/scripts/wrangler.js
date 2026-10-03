import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const base=fileURLToPath(new URL('../',import.meta.url));
const executable=fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url));
export async function wrangler(args) {
  const child=spawn(process.execPath,[executable,...args],{cwd:base,stdio:'inherit',env:process.env});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  if(code!==0)throw new Error(`Wrangler 退出码 ${code}`);
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  if(args[0]==='deploy') await wrangler(['d1','migrations','apply','DB','--remote','--config','wrangler.generated.json']);
  await wrangler([...args,'--config','wrangler.generated.json']);
}
