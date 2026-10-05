import {createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {integer} from './security.js';
import {tables} from './schema.js';
import {postgresTables} from './postgres-schema.js';
import {productTables} from './product-schema.js';

const additions=[['project_info','epoch','BIGINT NOT NULL DEFAULT 0'],['project_resources','version','INT NOT NULL DEFAULT 1'],['workflow_runs','project_epoch','BIGINT NOT NULL DEFAULT 0'],['business_events','version','INT NULL'],['api_jobs','project_id','VARCHAR(36) NULL'],['api_jobs','workflow_id','VARCHAR(36) NULL'],['tg_info','phone_key','VARCHAR(64) NULL'],['webhook_deliveries','remote_message_id','VARCHAR(32) NULL']];
export const reliabilityIndexes=type=>type==='mysql'?[{table:'tg_info',name:'ix_tg_phone',sql:'CREATE INDEX ix_tg_phone ON tg_info (phone_key,status,user_id)'}]:['CREATE INDEX IF NOT EXISTS ix_tg_phone ON tg_info (phone_key,status,user_id)'];
export async function initializeSchema({pool,type,database},env) {
  const definitions=[...(type==='postgresql'?postgresTables:tables),...productTables(type)];
  if(env.DB_SCHEMA_INIT==='false'){
    // A runtime account can validate compatibility using SELECT privileges only.
    for(const entry of definitions){const sql=typeof entry==='string'?entry:entry.sql;const table=sql.match(/^CREATE TABLE IF NOT EXISTS (\w+)/)?.[1];if(table)await pool.execute(`SELECT * FROM ${table} LIMIT 0`);}
    for(const [table,column] of additions)await pool.execute(`SELECT ${column} FROM ${table} LIMIT 0`);
    return;
  }
  const seconds=integer(env,'DB_SCHEMA_LOCK_TIMEOUT_SECONDS',60,1,300);
  const connection=await pool.getConnection();let locked=false;
  const key='tg-schema:'+createHash('sha256').update(database).digest('hex').slice(0,48);
  try{
    if(type==='mysql'){
      const [rows]=await connection.execute('SELECT GET_LOCK(?,?) AS acquired',[key,seconds]);locked=Number(rows[0].acquired)===1;
    }else{
      const deadline=Date.now()+seconds*1000;
      do{const [rows]=await connection.execute("SELECT pg_try_advisory_lock(hashtext(current_database()),hashtext('telegram-bot-schema')) AS acquired");locked=rows[0].acquired;if(!locked&&Date.now()<deadline)await sleep(Math.min(100,deadline-Date.now()));}while(!locked&&Date.now()<deadline);
    }
    if(!locked)throw new Error('数据库结构初始化锁等待超时，请稍后重试');
    // All DDL uses the same session that owns the advisory lock.
    for(const entry of definitions){
      if(typeof entry==='string')await connection.execute(entry);
      else{const [indexes]=await connection.execute('SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND INDEX_NAME=?',[database,entry.table,entry.name]);if(!indexes.length)await connection.execute(entry.sql);}
    }
    for(const [table,column,definition] of additions){
      const [columns]=await connection.execute('SELECT column_name FROM information_schema.columns WHERE table_schema=? AND table_name=? AND column_name=?',[type==='mysql'?database:'public',table,column]);
      if(!columns.length)await connection.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    for(const entry of reliabilityIndexes(type)){
      if(typeof entry==='string')await connection.execute(entry);
      else{const [indexes]=await connection.execute('SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND INDEX_NAME=?',[database,entry.table,entry.name]);if(!indexes.length)await connection.execute(entry.sql);}
    }
    if(type==='mysql')for(const [table,column,definition] of [['tg_info','api_hash','TEXT NOT NULL'],['tg_info','phone','TEXT NOT NULL'],['tg_info','phone_code_hash','TEXT NULL'],['tg_info','pending_bot','MEDIUMTEXT NULL'],['tg_info','pending_channel','MEDIUMTEXT NULL'],['bot_info','token','TEXT NOT NULL'],['bot_info','webhook_secret','TEXT NULL']]){
      const [rows]=await connection.execute('SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=?',[database,table,column]);
      if(!['text','mediumtext','longtext'].includes(rows[0]?.DATA_TYPE))await connection.query(`ALTER TABLE ${table} MODIFY ${column} ${definition}`);
    }
  }finally{
    try{if(locked)await connection.execute(type==='mysql'?'SELECT RELEASE_LOCK(?)':"SELECT pg_advisory_unlock(hashtext(current_database()),hashtext('telegram-bot-schema'))",type==='mysql'?[key]:[]);}finally{connection.release();}
  }
}
