import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import {randomBytes,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createStore} from '../api/store.js';
import {databaseConfig} from '../api/database.js';

test('legacy MySQL widths/JSON upgrade and versioned re-encryption preserve data',{skip:process.env.SECURITY_INTEGRATION!=='1'||process.env.DB_TYPE==='postgresql'},async()=>{
 const database='tg_upgrade_'+randomUUID().replaceAll('-','');const v1=randomBytes(32).toString('base64');const env={...process.env,DB_DATABASE:database,CREDENTIAL_KEY_ID:'v1',CREDENTIAL_KEYS:JSON.stringify({v1})};let store;
 const admin=await mysql.createConnection(databaseConfig(env).options);
 try{
  store=await createStore(env);await store.close();store=null;
  await admin.query(`ALTER TABLE ${database}.tg_info MODIFY api_hash CHAR(32) NOT NULL, MODIFY phone VARCHAR(32) NOT NULL, MODIFY phone_code_hash VARCHAR(256) NULL, MODIFY pending_bot JSON NULL, MODIFY pending_channel JSON NULL`);
  await admin.query(`ALTER TABLE ${database}.bot_info MODIFY token VARCHAR(256) NOT NULL, MODIFY webhook_secret VARCHAR(64) NULL`);
  const user=randomUUID(),account=randomUUID();const bot={username:'legacy_example_bot',name:'Legacy',token:'123456:'+ 'a'.repeat(35)};
  await admin.execute(`INSERT INTO ${database}.user_info(id,email,password_hash) VALUES(?,?,?)`,[user,'legacy@example.test','old-password-hash']);
  await admin.execute(`INSERT INTO ${database}.tg_info(account_id,user_id,api_id,api_hash,phone,session,status,pending_bot) VALUES(?,?,?,?,?,?,?,?)`,[account,user,12345,'a'.repeat(32),'+447700123456','legacy-session','authorized',JSON.stringify(bot)]);
  await admin.execute(`INSERT INTO ${database}.bot_info(user_id,account_id,telegram_bot_id,username,name,token,webhook_secret) VALUES(?,?,?,?,?,?,?)`,[user,account,'123456',bot.username,bot.name,bot.token,'s'.repeat(64)]);
  store=await createStore(env);await assert.rejects(store.ready(),e=>e.code==='PHONE_INDEX_NOT_READY');
  const backfill=spawnSync(process.execPath,['scripts/backfill-phones.js'],{env,encoding:'utf8',timeout:30000});assert.equal(backfill.status,0,backfill.stderr);assert.equal(JSON.parse(backfill.stdout).changed,1);
  assert.equal((await admin.execute(`SELECT phone FROM ${database}.tg_info WHERE account_id=?`,[account]))[0][0].phone,'+447700123456');await store.ready();
  await assert.rejects(store.getAccount(account),e=>e.status===503);assert.equal((await store.rewrap('tg_info','',100)).changed,1);assert.equal((await store.rewrap('bot_info','',100)).changed,1);assert.equal((await store.getAccount(account)).session,'legacy-session');assert.equal((await store.getAccount(account)).pending_bot.token,bot.token);assert.equal((await store.get(account,bot.username)).token,bot.token);await store.close();store=null;
  const rotated={...env,CREDENTIAL_KEY_ID:'v2',CREDENTIAL_KEYS:JSON.stringify({v1,v2:randomBytes(32).toString('base64')})};store=await createStore(rotated);await store.rewrap('tg_info','',100);await store.rewrap('bot_info','',100);assert.equal((await store.getAccount(account)).session,'legacy-session');const [rows]=await admin.execute(`SELECT session FROM ${database}.tg_info WHERE account_id=?`,[account]);assert.match(rows[0].session,/^enc:v2:/);
 }finally{await store?.close();await admin.query(`DROP DATABASE IF EXISTS ${database}`);await admin.end();}
});
