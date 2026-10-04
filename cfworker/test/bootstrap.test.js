import { beforeEach,it,expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import worker from '../src/index.js';
import { ensureSchema } from '../src/schema.js';

beforeEach(async()=>{await reset();});
// Each wrapper represents a fresh isolate or a changed DB binding. No SQL
// migrations run in setup: this exercises the Dashboard first-request path.
const database = () => ({prepare:sql=>env.DB.prepare(sql),batch:statements=>env.DB.batch(statements)});
it('creates all four business tables on the first protected request without build env',async()=>{
  const response=await worker.fetch(new Request('https://example.test/v1/accounts'),{...env,DB:database()});
  expect(response.status).toBe(401);
  const rows=await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('user_info','tg_info','bot_info','channel_info') ORDER BY name").all();
  expect(rows.results.map(row=>row.name)).toEqual(['bot_info','channel_info','tg_info','user_info']);
  expect((await env.DB.prepare('SELECT name FROM d1_migrations').all()).results).toEqual([{name:'0001_init.sql'},{name:'0002_security.sql'}]);
});
it('initializes concurrently and retains existing rows when a new isolate initializes again',async()=>{
  await Promise.all([ensureSchema(database()),ensureSchema(database())]);
  await env.DB.prepare('INSERT INTO user_info(id,email,password_hash) VALUES(?,?,?)').bind('retained-user','keep@example.test','stored-password-hash').run();
  await ensureSchema(database());
  expect((await env.DB.prepare('SELECT email FROM user_info WHERE id=?').bind('retained-user').first()).email).toBe('keep@example.test');
});
it('retries failed initialization and reports a missing DB binding clearly',async()=>{
  let attempts=0;
  const db={prepare:sql=>env.DB.prepare(sql),batch:statements=>{attempts++;if(attempts===1)throw new Error('Temporary D1 failure');return env.DB.batch(statements);}};
  await expect(ensureSchema(db)).rejects.toThrow('Temporary D1 failure');
  await ensureSchema(db);
  expect(attempts).toBe(2);
  const response=await worker.fetch(new Request('https://example.test/v1/accounts'),{...env,DB:undefined});
  expect(response.status).toBe(503);
  expect((await response.json()).error).toContain('DB');
});
