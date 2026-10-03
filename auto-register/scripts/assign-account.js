// Operator-only migration: not exposed as an HTTP endpoint.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createStore } from '../api/store.js';
import { emailAddress } from '../api/auth.js';

process.umask(0o077);
const id = process.env.MIGRATE_ACCOUNT_ID;
if (!/^[a-f0-9-]{36}$/.test(id || '')) throw new Error('需要 MIGRATE_ACCOUNT_ID');
const email = emailAddress(process.env.MIGRATE_EMAIL);
const store = await createStore();
try {
  const user = await store.userByEmail(email);
  if (!user) throw new Error('归属邮箱必须先完成平台注册');
  const path = join(process.env.DATA_DIR || './data', `${id}.json`);
  const state = JSON.parse(await readFile(path, 'utf8'));
  if (state.user_id && state.user_id !== user.id) throw new Error('该会话已属于其他用户');
  state.user_id = user.id;
  await store.saveAccount(id, state);
  console.log('原 Telegram JSON 会话已导入 tg_info 并绑定至指定注册用户');
} finally { await store.close(); }
