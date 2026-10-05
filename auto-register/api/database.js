import mysql from 'mysql2/promise';
import pg from 'pg';
import { integer,audit } from './security.js';

export function databaseConfig(input) {
  const env={...input,DB_TYPE:input.DB_TYPE||'mysql'};
  if(env.DB_PORT==='')delete env.DB_PORT;
  const type=env.DB_TYPE;
  if(!['mysql','postgresql'].includes(type))throw new Error('DB_TYPE 必须为 mysql 或 postgresql');
  for(const name of ['DB_HOST','DB_USER','DB_PASSWORD','DB_DATABASE'])if(!env[name])throw new Error(`需要 ${name}`);
  const database=env.DB_DATABASE;
  if(!new RegExp(`^[A-Za-z0-9_]{1,${type==='mysql'?64:63}}$`).test(database))throw new Error('DB_DATABASE 名称无效');
  const port=integer(env,'DB_PORT',type==='mysql'?3306:5432,1,65535);
  const sslMode=env.DB_SSL_MODE||'disable';
  if(!['disable','verify-full'].includes(sslMode))throw new Error('DB_SSL_MODE 必须为 disable 或 verify-full');
  if(env.DB_AUTO_CREATE_DATABASE!==undefined&&!['true','false'].includes(env.DB_AUTO_CREATE_DATABASE))throw new Error('DB_AUTO_CREATE_DATABASE 必须为 true 或 false');
  if(env.DB_SCHEMA_INIT!==undefined&&!['true','false'].includes(env.DB_SCHEMA_INIT))throw new Error('DB_SCHEMA_INIT 必须为 true 或 false');
  if(env.DB_SCHEMA_INIT==='false'&&env.DB_AUTO_CREATE_DATABASE!=='false')throw new Error('DB_SCHEMA_INIT=false 时需要 DB_AUTO_CREATE_DATABASE=false');
  integer(env,'DB_SCHEMA_LOCK_TIMEOUT_SECONDS',60,1,300);
  const maintenance=env.DB_MAINTENANCE_DATABASE||'postgres';
  if(type==='postgresql'&&!/^[A-Za-z0-9_]{1,63}$/.test(maintenance))throw new Error('DB_MAINTENANCE_DATABASE 名称无效');
  return {type,database,autoCreate:env.DB_AUTO_CREATE_DATABASE!=='false',maintenance,poolSize:integer(env,'DB_POOL_SIZE',10,1,100),timeout:integer(env,'DB_CONNECT_TIMEOUT_MS',5000,1000,30000),
    options:{host:env.DB_HOST,port,user:env.DB_USER,password:env.DB_PASSWORD,ssl:sslMode==='verify-full'?{rejectUnauthorized:true,...(type==='mysql'?{verifyIdentity:true}:{}),...(env.DB_SSL_CA?{ca:env.DB_SSL_CA.replaceAll('\\n','\n')}: {})}:false}};
}
// Only placeholders are adapted. Dialect-specific DDL/upserts remain explicit.
// This lexer ignores quoted strings/identifiers, comments and dollar quotes.
export function postgresParameters(sql) {
  let output='';let index=0;let quote=null;let dollar=null;let comment=null;let depth=0;let escapes=false;
  for(let i=0;i<sql.length;i++) {
    const c=sql[i],next=sql[i+1];
    if(comment==='line'){output+=c;if(c==='\n')comment=null;continue;}
    if(comment==='block'){output+=c;if(c==='/'&&next==='*'){output+=next;i++;depth++;}else if(c==='*'&&next==='/'){output+=next;i++;if(--depth===0)comment=null;}continue;}
    if(dollar){if(sql.startsWith(dollar,i)){output+=dollar;i+=dollar.length-1;dollar=null;}else output+=c;continue;}
    if(quote){output+=c;if(c===quote){if(next===quote){output+=next;i++;}else quote=null;}else if(escapes&&c==='\\'&&next){output+=next;i++;}continue;}
    if(c==='-'&&next==='-'){output+='--';i++;comment='line';continue;}
    if(c==='/'&&next==='*'){output+='/*';i++;comment='block';depth=1;continue;}
    if(c==="'"||c==='"'){quote=c;escapes=c==="'"&&/[eE]/.test(sql[i-1]||'')&&!/[A-Za-z0-9_$]/.test(sql[i-2]||'');output+=c;continue;}
    if(c==='$'){const match=sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);if(match){dollar=match[0];output+=dollar;i+=dollar.length-1;continue;}}
    output+=c==='?'?`$${++index}`:c;
  }
  return {text:output,count:index};
}
function postgresConnection(client) {
  const execute=async(sql,args=[])=>{
    const {text,count}=postgresParameters(sql);
    if(count!==args.length)throw new Error('SQL 参数数量不匹配');
    const result=await client.query(text,args);
    return [result.command==='SELECT'||result.rows.length?result.rows:{affectedRows:result.rowCount},result.fields];
  };
  return {execute,query:execute,beginTransaction:()=>client.query('BEGIN'),commit:()=>client.query('COMMIT'),rollback:()=>client.query('ROLLBACK'),release:()=>client.release()};
}
export async function createDatabase(env) {
  const config=databaseConfig(env);const {type,database,options,poolSize,timeout}=config;
  if(type==='mysql') {
    if(config.autoCreate){const client=await mysql.createConnection({...options,connectTimeout:timeout});try{await client.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);}finally{await client.end();}}
    const pool=mysql.createPool({...options,database,connectionLimit:poolSize,connectTimeout:timeout,charset:'utf8mb4',supportBigNumbers:true,bigNumberStrings:true});
    return {type,database,pool};
  }
  const pgOptions={...options,connectionTimeoutMillis:timeout};
  if(config.autoCreate){const client=new pg.Client({...pgOptions,database:config.maintenance});try{await client.connect();const result=await client.query('SELECT 1 FROM pg_database WHERE datname=$1',[database]);if(!result.rowCount){try{await client.query(`CREATE DATABASE "${database}" ENCODING 'UTF8' TEMPLATE template0`);}catch(error){if(!['42P04','23505'].includes(error.code))throw error;}}}finally{await client.end();}}
  const native=new pg.Pool({...pgOptions,database,max:poolSize});native.on('error',()=>audit('database_pool_error',{type:'postgresql'}));
  const {execute,query}=postgresConnection(native);
  const pool={execute,query,getConnection:async()=>postgresConnection(await native.connect()),end:()=>native.end()};
  return {type,database,pool};
}
export function conflict(type,table,keys,fields=[],extra=[]) {
  const values=fields.map(name=>`${name}=${type==='postgresql'?`EXCLUDED.${name}`:`VALUES(${name})`}`);
  return `${type==='postgresql'?` ON CONFLICT (${keys.join(',')}) DO UPDATE SET`:' ON DUPLICATE KEY UPDATE'} ${[...values,...extra].join(',')}`;
}
