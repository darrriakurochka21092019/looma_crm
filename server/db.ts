import 'dotenv/config';
import pg from 'pg';
import { createHash } from 'node:crypto';
pg.types.setTypeParser(20, (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error('Money overflow');
  return n;
});
pg.types.setTypeParser(1082, (value) => value);
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 12),
});
export type DB = Pick<pg.PoolClient, 'query'>;
export async function transaction<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const r = await fn(db);
    await db.query('COMMIT');
    return r;
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
  }
}
export async function audit(
  db: DB,
  actor: string,
  entity: string,
  id: string,
  action: string,
  before: unknown = null,
  after: unknown = null,
) {
  await db.query(
    'INSERT INTO audit_events(entity,entity_id,action,author_id,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6)',
    [entity, id, action, actor, before, after],
  );
}
export function hash(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}
export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export async function idempotent<T>(
  db: DB,
  key: string,
  actor: string,
  scope: string,
  body: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const requestHash = hash(JSON.stringify(body));
  await db.query(
    'INSERT INTO mutation_keys(key,actor_id,scope,request_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
    [key, actor, scope, requestHash],
  );
  const {
    rows: [row],
  } = await db.query('SELECT * FROM mutation_keys WHERE key=$1 FOR UPDATE', [key]);
  if (row.actor_id !== actor || row.scope !== scope || row.request_hash !== requestHash)
    throw new AppError(409, 'Ключ повторного запроса уже использован для других данных');
  if (row.result !== null) return row.result as T;
  const result = await fn();
  await db.query('UPDATE mutation_keys SET result=$2 WHERE key=$1', [key, JSON.stringify(result)]);
  return result;
}
