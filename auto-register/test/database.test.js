import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {databaseConfig,postgresParameters} from '../api/database.js';
import {createStore} from '../api/store.js';
import {postgresTables} from '../api/postgres-schema.js';
import {tables} from '../api/schema.js';
import {productTables} from '../api/product-schema.js';
import {reliabilityIndexes} from '../api/migrations.js';

const base={DB_HOST:'localhost',DB_DATABASE:'telegram_test',DB_USER:'test',DB_PASSWORD:'test'};
test('DB configuration validates engines, names, ports, privileges and TLS',()=>{
  assert.equal(databaseConfig(base).options.port,3306);
  assert.equal(databaseConfig(base).options.ssl,false);
  assert.equal(databaseConfig({...base,DB_TYPE:'postgresql',DB_PORT:''}).options.port,5432);
  assert.equal(databaseConfig({...base,DB_TYPE:'postgresql',DB_PORT:'15432',DB_AUTO_CREATE_DATABASE:'false'}).autoCreate,false);
  for(const invalid of [{DB_TYPE:'sqlite'},{DB_DATABASE:'bad"name'},{DB_PORT:'0'},{DB_POOL_SIZE:'101'},{DB_AUTO_CREATE_DATABASE:'0'},{DB_SCHEMA_INIT:'0'},{DB_SCHEMA_INIT:'false'},{DB_SCHEMA_LOCK_TIMEOUT_SECONDS:'0'},{DB_SCHEMA_LOCK_TIMEOUT_SECONDS:'301'},{DB_SSL_MODE:'require'},{DB_PASSWORD:''},{DB_TYPE:'postgresql',DB_MAINTENANCE_DATABASE:'unsafe;sql'},{DB_TYPE:'postgresql',DB_DATABASE:'a'.repeat(64)}])assert.throws(()=>databaseConfig({...base,...invalid}));
  assert.doesNotThrow(()=>databaseConfig({...base,DB_SCHEMA_INIT:'false',DB_AUTO_CREATE_DATABASE:'false'}));
  for(const type of ['mysql','postgresql']){
    const config=databaseConfig({...base,DB_TYPE:type,DB_SSL_MODE:'verify-full',DB_SSL_CA:'first\\nsecond'});
    assert.equal(config.options.ssl.rejectUnauthorized,true);
    assert.equal(config.options.ssl.ca,'first\nsecond');
    if(type==='mysql')assert.equal(config.options.ssl.verifyIdentity,true);
  }
  assert.throws(()=>databaseConfig({}),/DB_HOST/);
});
test('PostgreSQL bind translation preserves SQL literals, identifiers and comments',()=>{
  const sql=`SELECT ?, '?', "?", 'it''s ?', $$?$$, $tag$?$tag$ -- ?\n/* ? */ WHERE id=?`;
  assert.deepEqual(postgresParameters(sql),{text:`SELECT $1, '?', "?", 'it''s ?', $$?$$, $tag$?$tag$ -- ?\n/* ? */ WHERE id=$2`,count:2});
  const escapes=String.raw`SELECT '\', ?, E'it\'s ?', "id\", /* outer /* ? */ ? */ ?`;
  assert.deepEqual(postgresParameters(escapes),{text:escapes.slice(0,-1).replace(', ?,',', $1,')+'$2',count:2});
});
test('manual SQL stays aligned with both runtime schemas',async()=>{
  for(const [file,ddl] of [['init.sql',[...tables,...productTables('mysql').map(entry=>typeof entry==='string'?entry:entry.sql)]],['postgresql/init.sql',[...postgresTables,...productTables('postgresql'),...reliabilityIndexes('postgresql')]]]){
    const sql=await readFile(new URL('../sql/'+file,import.meta.url),'utf8');
    for(const statement of ddl)assert.ok(sql.includes(statement+';'),file);
  }
});
test('real SQL transaction rollback, case semantics, key rotation and provisioned DB', {skip:process.env.SECURITY_INTEGRATION!=='1'},async()=>{
  const env={...process.env};const store=await createStore(env);const user=randomUUID(),account=randomUUID();let reopened;
  const email=`Mixed-${user}@example.test`;
  try{
    await assert.rejects(store.transaction(async connection=>{
      await connection.execute('INSERT INTO user_info(id,email,password_hash) VALUES(?,?,?)',[user,email,'hash']);
      throw new Error('rollback-test');
    }),/rollback-test/);
    assert.equal(await store.userById(user),null);
    await store.createUser({id:user,email,password_hash:'hash'});
    assert.equal((await store.userByEmail(email.toLowerCase())).id,user);
    await assert.rejects(store.createUser({id:randomUUID(),email:email.toLowerCase(),password_hash:'hash'}),error=>['23505','ER_DUP_ENTRY'].includes(error.code));
    const state={user_id:user,api_id:12345,api_hash:'a'.repeat(32),phone:'+447700123456',session:'before',status:'authorized'};
    await store.saveAccount(account,state);await store.saveAccount(account,{...state,session:'after'});
    assert.equal((await store.getAccount(account)).session,'after');
    const botId='9007199254740993',username='mixed_'+user.replaceAll('-','').slice(0,15)+'bot';
    await store.save(account,{name:'Test',username,token:botId+':'+ 'a'.repeat(35)});
    assert.equal((await store.get(account,username.toUpperCase())).username,username);
    const [rows]=await store.pool.execute('SELECT telegram_bot_id FROM bot_info WHERE account_id=?',[account]);assert.equal(String(rows[0].telegram_bot_id),botId);
    for(const key of ['CaseKey','casekey'])await store.reserveChannel(account,{request_key:key,customer_id:'test',bot_username:username,title:'test',about:''});
    for(const key of ['PostKey','postkey'])await store.reservePost(account,'CaseKey',{request_key:key,message_text:key});
    await store.postReady(account,'CaseKey','PostKey',123);
    assert.equal((await store.getPost(account,'CaseKey','PostKey')).status,'sent');
    assert.equal((await store.getPost(account,'CaseKey','postkey')).status,'sending');
    // Reconnect without CREATE DATABASE, rotate to a new key and exercise
    // conditional rewrap updates, including nullable credential fields.
    const keyId='test_'+randomBytes(4).toString('hex');
    const rotated={...env,DB_AUTO_CREATE_DATABASE:'false',CREDENTIAL_KEY_ID:keyId,CREDENTIAL_KEYS:JSON.stringify({...JSON.parse(env.CREDENTIAL_KEYS),[keyId]:randomBytes(32).toString('base64')})};
    reopened=await createStore(rotated);await reopened.ready();
    await reopened.rewrap('tg_info','',100);await reopened.rewrap('bot_info','',100);
    assert.equal((await reopened.getAccount(account)).session,'after');
    assert.equal((await reopened.get(account,username)).token,botId+':'+ 'a'.repeat(35));
  }finally{
    await reopened?.close();
    for(const table of ['channel_posts','channel_info','bot_info','tg_info'])await store.pool.execute(`DELETE FROM ${table} WHERE account_id=?`,[account]);
    await store.pool.execute('DELETE FROM user_info WHERE id=?',[user]);await store.close();
  }
});
