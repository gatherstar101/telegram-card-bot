import mysql from 'mysql2/promise';
import { mkdir,writeFile } from 'node:fs/promises';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const env=process.env;
for(const key of ['MYSQL_HOST','MYSQL_USER','MYSQL_PASSWORD','MYSQL_DATABASE'])if(!env[key])throw new Error(`需要 ${key}`);
if(!/^[A-Za-z0-9_]{1,64}$/.test(env.MYSQL_DATABASE))throw new Error('MYSQL_DATABASE 格式错误');
const output=resolve(env.D1_EXPORT_FILE || fileURLToPath(new URL('../../data/d1-export.sql',import.meta.url)));
const tables={
  user_info:['id','email','password_hash','created_at'],
  tg_info:['account_id','user_id','api_id','api_hash','phone','session','status','expires_at','phone_code_hash','pending_bot','pending_channel','created_at','updated_at'],
  bot_info:['id','user_id','account_id','telegram_bot_id','username','name','token','customer_id','landing_url','card_text','card_image','button_text','webhook_secret','webhook_url','created_at','updated_at'],
  channel_info:['account_id','user_id','request_key','customer_id','bot_username','title','about','channel_id','access_hash','invite_url','status','posts','created_at'],
};
function literal(value) {
  if(value===null || value===undefined)return 'NULL';
  if(typeof value==='number') {
    if(!Number.isSafeInteger(value))throw new Error('Unsafe numeric export value');
    return String(value);
  }
  if(value instanceof Date)value=value.toISOString();
  else if(typeof value==='object')value=JSON.stringify(value);
  // Hex text preserves quotes, backslashes, Unicode and even embedded NULs.
  return `CAST(X'${Buffer.from(String(value),'utf8').toString('hex')}' AS TEXT)`;
}
const connection=await mysql.createConnection({
  host:env.MYSQL_HOST,port:Number(env.MYSQL_PORT || 3306),user:env.MYSQL_USER,
  password:env.MYSQL_PASSWORD,database:env.MYSQL_DATABASE,charset:'utf8mb4',
  supportBigNumbers:true,bigNumberStrings:true,timezone:'Z',
});
try {
  await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  await connection.query('SET TRANSACTION READ ONLY');
  await connection.beginTransaction();
  const lines=['-- Sensitive Telegram data export. Import only into empty migrated D1 tables.'];
  let count=0;
  for(const [table,columns] of Object.entries(tables)) {
    const [rows]=await connection.query(`SELECT ${columns.map(c=>`\`${c}\``).join(',')} FROM \`${table}\``);
    for(const row of rows)lines.push(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(c=>literal(row[c])).join(',')});`);
    count+=rows.length;
  }
  await connection.commit();
  await mkdir(dirname(output),{recursive:true,mode:0o700});
  await writeFile(output,lines.join('\n')+'\n',{flag:'wx',mode:0o600});
  console.log(`已导出 ${count} 条记录到 ${output}；不含 Redis 登录态。文件已存在时不会覆盖。`);
} finally { await connection.end(); }
