import initialSchema from '../migrations/0001_init.sql';
import { Failure } from '../../auto-register/api/errors.js';

const initialized = new WeakSet();
// Cache only successful initialization. Concurrent first requests can each run
// the idempotent batch; no request awaits another request's in-flight I/O.
export async function ensureSchema(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') throw new Failure(503,'请在 Cloudflare Bindings 中关联名为 DB 的 D1 数据库');
  if (initialized.has(db)) return;
  // Do not rewrite an already published migration. Make the bootstrap copy
  // idempotent and record its application in Wrangler's migration ledger.
  const statements = initialSchema
    .replace(/^CREATE TABLE /gm,'CREATE TABLE IF NOT EXISTS ')
    .replace(/^CREATE INDEX /gm,'CREATE INDEX IF NOT EXISTS ')
    .split(';').map(sql=>sql.trim()).filter(Boolean);
  statements.unshift('CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)');
  statements.push("INSERT OR IGNORE INTO d1_migrations(name) VALUES('0001_init.sql')");
  await db.batch(statements.map(sql=>db.prepare(sql)));
  initialized.add(db);
}
