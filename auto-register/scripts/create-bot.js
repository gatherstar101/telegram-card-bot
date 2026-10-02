import { open, readFile, mkdir, chmod, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createInterface } from 'node:readline/promises';
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';

async function main() {
  process.umask(0o077);
  const config = {};
  for (const key of ['TG_API_ID', 'TG_API_HASH', 'TG_PHONE', 'TG_BOT_NAME', 'TG_BOT_USERNAME']) {
    config[key] = process.env[key]?.trim();
    if (!config[key]) throw new Error(`缺少环境变量：${key}`);
  }
  if (!/^\d+$/.test(config.TG_API_ID) || !Number.isSafeInteger(Number(config.TG_API_ID)) || Number(config.TG_API_ID) <= 0) throw new Error('TG_API_ID 必须为正整数');
  if (!/^[a-f0-9]{32}$/i.test(config.TG_API_HASH)) throw new Error('TG_API_HASH 格式错误');
  if (!/^[a-z][a-z0-9_]{4,31}$/i.test(config.TG_BOT_USERNAME) || !/bot$/i.test(config.TG_BOT_USERNAME)) throw new Error('TG_BOT_USERNAME 格式错误');
  const tokenPath = process.env.TG_TOKEN_FILE || 'scripts/.bot-token.env';
  const sessionPath = process.env.TG_SESSION_PATH || 'scripts/.telegram-user.session';
  await mkdir(dirname(tokenPath), { recursive: true });
  const output = await open(tokenPath, 'wx', 0o600);
  let saved = false;
  let client;
  let terminal;
  try {
    let session = '';
    try { session = (await readFile(sessionPath, 'utf8')).trim(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    client = new TelegramClient(new StringSession(session), Number(config.TG_API_ID), config.TG_API_HASH, { connectionRetries: 3 });
    const ask = async (key, prompt) => {
      if (process.env[key]) return process.env[key];
      if (!process.stdin.isTTY) throw new Error(`非交互运行需要环境变量：${key}`);
      terminal ??= createInterface({ input: process.stdin, output: process.stdout });
      return terminal.question(prompt);
    };
    await client.start({
      phoneNumber: async () => config.TG_PHONE,
      phoneCode: () => ask('TG_PHONE_CODE', 'Telegram 登录验证码：'),
      password: () => ask('TG_PASSWORD', '两步验证密码（终端输入会显示，请优先通过环境变量传入）：'),
      onError: (error) => { throw error; },
    });
    await mkdir(dirname(sessionPath), { recursive: true });
    const sessionFile = await open(sessionPath, 'w', 0o600);
    try {
      await chmod(sessionPath, 0o600);
      await sessionFile.writeFile(client.session.save());
    } finally { await sessionFile.close(); }
    if ((await client.getMe()).bot) throw new Error('需要个人账号登录');
    const botfather = await client.getEntity('BotFather');
    const exchange = async (message) => {
      const sent = await client.sendMessage(botfather, { message });
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const replies = await client.getMessages(botfather, { limit: 10, minId: sent.id });
        const reply = [...replies].filter(item => !item.out && item.id > sent.id).sort((a, b) => a.id - b.id)[0];
        if (reply) return reply.message || '';
        await sleep(1000);
      }
      throw new Error('等待 BotFather 回复超时，请检查对话再重试');
    };
    await exchange('/cancel');
    if (!/name/i.test(await exchange('/newbot'))) throw new Error('BotFather 未要求名称，请检查对话或账号限制');
    if (!/username/i.test(await exchange(config.TG_BOT_NAME))) throw new Error('BotFather 未要求用户名，请检查对话');
    const reply = await exchange(config.TG_BOT_USERNAME);
    const token = reply.match(/\b\d+:[A-Za-z0-9_-]{30,}\b/)?.[0];
    if (!token) throw new Error('未获得 Token，请检查 BotFather 对话：用户名可能被占用或创建受限');
    await output.writeFile(`BOT_TOKEN=${token}\n`);
    await output.sync();
    saved = true;
    console.log(`创建成功：https://t.me/${config.TG_BOT_USERNAME}\nToken 已保存到：${tokenPath}`);
  } finally {
    terminal?.close();
    await output.close();
    if (!saved) await unlink(tokenPath);
    await client?.disconnect();
  }
}

main().catch(error => {
  console.error(`创建失败：${error.code === 'EEXIST' ? 'Token 输出文件已存在，请检查后调整 TG_TOKEN_FILE' : error.message}`);
  process.exitCode = 1;
});
