import { DurableObject } from 'cloudflare:workers';

// Each auth key has its own object. OTP consumption and lease release never
// cross an await boundary: transactionSync makes concurrent calls atomic.
export class AuthState extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS entry(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL,expires_at INTEGER NOT NULL)');
  }
  current() {
    const row = this.ctx.storage.sql.exec('SELECT value,expires_at FROM entry WHERE id=1').toArray()[0];
    if (row && row.expires_at <= Date.now()) {
      this.ctx.storage.sql.exec('DELETE FROM entry');
      return null;
    }
    return row || null;
  }
  write(value,expires) {
    this.ctx.storage.sql.exec('INSERT INTO entry(id,value,expires_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at', value,expires);
  }
  async schedule() {
    const row = this.current();
    if (row) await this.ctx.storage.setAlarm(row.expires_at);
  }
  get() { return this.current()?.value ?? null; }
  ttl() { const row=this.current();return row?Math.max(1,Math.ceil((row.expires_at-Date.now())/1000)):0; }
  async set(value,options) {
    const result = this.ctx.storage.transactionSync(() => {
      if (options.NX && this.current()) return null;
      if (!Number.isInteger(options.EX) || options.EX <= 0) throw new Error('Invalid TTL');
      this.write(value,Date.now()+options.EX*1000);
      return 'OK';
    });
    await this.schedule();
    return result;
  }
  del() { this.ctx.storage.sql.exec('DELETE FROM entry'); return 1; }
  async increment(seconds) {
    const count = this.ctx.storage.transactionSync(() => {
      const row = this.current();
      const count = Number(row?.value || 0)+1;
      this.write(String(count),row?.expires_at ?? Date.now()+seconds*1000);
      return count;
    });
    await this.schedule();
    return count;
  }
  consume(hash,purpose) {
    return this.ctx.storage.transactionSync(() => {
      const row = this.current();
      if (!row) return [0,''];
      const challenge = JSON.parse(row.value);
      if (challenge.purpose !== purpose) return [0,''];
      if (challenge.code_hash !== hash) {
        challenge.attempts = (challenge.attempts || 0)+1;
        if (challenge.attempts >= 5) this.del();
        else this.write(JSON.stringify(challenge),row.expires_at);
        return [0,''];
      }
      this.del();
      return [1,row.value];
    });
  }
  release(lease) {
    return this.ctx.storage.transactionSync(() => this.current()?.value === lease ? this.del() : 0);
  }
  async alarm() { await this.schedule(); }
}

export function createAuthCache(env) {
  const object = key => env.AUTH_STATE.get(env.AUTH_STATE.idFromName(key));
  return {
    get: key => object(key).get(),
    ttl: key => object(key).ttl(),
    set: (key,value,options) => object(key).set(value,options),
    del: key => object(key).del(),
    increment: (key,seconds) => object(key).increment(seconds),
    consume: (key,hash,purpose) => object(key).consume(hash,purpose),
    release: (key,lease) => object(key).release(lease),
  };
}
