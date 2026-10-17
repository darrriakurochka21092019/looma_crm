import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pool, transaction } from './db.js';
export async function migrate() {
  await transaction(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(71630921)');
    await db.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const files = (await readdir(resolve('db'))).filter((n) => n.endsWith('.sql')).sort();
    for (const f of files) {
      if (!(await db.query('SELECT 1 FROM schema_migrations WHERE name=$1', [f])).rowCount) {
        await db.query(await readFile(resolve('db', f), 'utf8'));
        await db.query('INSERT INTO schema_migrations(name) VALUES($1)', [f]);
      }
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await migrate();
    console.log('Миграции применены');
  } finally {
    await pool.end();
  }
}
