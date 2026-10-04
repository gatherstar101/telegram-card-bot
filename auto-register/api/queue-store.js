import { randomUUID } from 'node:crypto';

// Fixed table names only. SQL transactions arbitrate claims between replicas.
export function queueStore(store,table,running) {
  if(!['api_jobs','webhook_deliveries'].includes(table))throw new Error('Invalid queue');
  const where=table==='api_jobs'?'id=?':'bot_id=? AND update_id=?';
  const key=row=>table==='api_jobs'?[row.id]:[row.bot_id,row.update_id];
  const one=async(sql,args=[])=>{const [rows]=await store.pool.execute(sql,args);return rows[0]||null;};
  return {
    one,
    async update(row,values,leased=false) {
      const fields=Object.keys(values);
      const [result]=await store.pool.execute(`UPDATE ${table} SET ${fields.map(f=>`${f}=?`).join(',')} WHERE ${where}${leased?' AND lease=?':''}`,[...Object.values(values),...key(row),...(leased?[row.lease]:[])]);
      return result.affectedRows;
    },
    async claim(seconds) {
      return store.transaction(async conn=>{
        const now=Date.now();
        const [rows]=await conn.execute(`SELECT * FROM ${table} WHERE (status='queued' AND next_at<=?) OR (status=? AND lease_until<=?) ORDER BY next_at LIMIT 1 FOR UPDATE SKIP LOCKED`,[now,running,now]);
        if(!rows.length)return null;
        const row=rows[0];const lease=randomUUID();
        await conn.execute(`UPDATE ${table} SET status=?,lease=?,lease_until=?,updated_at=? WHERE ${where}`,[running,lease,now+seconds*1000,now,...key(row)]);
        return {...row,previous_status:row.status,status:running,lease};
      });
    },
    async heartbeat(row,seconds){return this.update(row,{lease_until:Date.now()+seconds*1000},true);},
    async cleanup(seconds){await store.pool.execute(`DELETE FROM ${table} WHERE status IN ('succeeded','failed','cancelled','sent') AND updated_at<?`,[Date.now()-seconds*1000]);},
  };
}
export function background(action,{interval=1000,onError=()=>{}}={}) {
  let stopping=false;let timer;let active=Promise.resolve();
  const tick=()=>{active=(async()=>{try{await action();}catch{onError();}finally{if(!stopping)timer=setTimeout(tick,interval);}})();};
  tick();
  return async()=>{stopping=true;clearTimeout(timer);await active;};
}
export async function withLease(cache,key,action,seconds=600) {
  const lease=randomUUID();
  if(!await cache.set(key,lease,{NX:true,EX:seconds}))return {busy:true};
  try{return {value:await action()};}finally{await cache.release(key,lease);}
}
