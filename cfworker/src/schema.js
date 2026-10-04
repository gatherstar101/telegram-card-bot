import initialSchema from '../migrations/0001_init.sql';
import securitySchema from '../migrations/0002_security.sql';
import { Failure } from '../../auto-register/api/errors.js';

const initialized=new WeakSet();
export async function ensureSchema(db) {
  if(!db||typeof db.prepare!=='function'||typeof db.batch!=='function')throw new Failure(503,'请在 Cloudflare Bindings 中关联名为 DB 的 D1 数据库');
  if(initialized.has(db))return;
  const statements=['CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)'];
  for(const [name,sql] of [['0001_init.sql',initialSchema],['0002_security.sql',securitySchema]]) {
    statements.push(...sql.replace(/^CREATE TABLE (?!IF NOT EXISTS )/gm,'CREATE TABLE IF NOT EXISTS ').replace(/^CREATE INDEX (?!IF NOT EXISTS )/gm,'CREATE INDEX IF NOT EXISTS ').split(';').map(s=>s.trim()).filter(Boolean));
    statements.push(`INSERT OR IGNORE INTO d1_migrations(name) VALUES('${name}')`);
  }
  // Both bootstrap migrations contain only additive, idempotent CREATEs.
  // Future ALTER/data migrations must be explicitly applied before deployment.
  await db.batch(statements.map(sql=>db.prepare(sql)));
  initialized.add(db);
}
