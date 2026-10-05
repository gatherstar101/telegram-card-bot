import {digest} from './auth.js';
import {Failure} from './errors.js';

// Offline, restartable migration. Never claims ownership for unverified accounts.
export async function backfillPhoneIndex(pool,crypt){
  let after='',changed=0;
  while(true){
    const [rows]=await pool.execute('SELECT account_id,phone FROM tg_info WHERE phone_key IS NULL AND account_id>? ORDER BY account_id LIMIT 100',[after]);
    for(const row of rows){
      const phone=crypt.open(row.phone,`tg:${row.account_id}:phone`);
      if(typeof phone!=='string'||!/^\+\d{7,15}$/.test(phone))throw new Failure(503,'历史账号手机号无效，索引补齐已停止');
      const [result]=await pool.execute('UPDATE tg_info SET phone_key=? WHERE account_id=? AND phone_key IS NULL AND phone=?',[digest(phone),row.account_id,row.phone]);
      changed+=result.affectedRows;
    }
    if(rows.length<100)break;
    after=rows.at(-1).account_id;
  }
  const [remaining]=await pool.execute('SELECT account_id FROM tg_info WHERE phone_key IS NULL LIMIT 1');
  if(remaining.length)throw new Failure(503,'仍有账号索引未补齐，请停止账号写入后重新运行');
  return {changed};
}
