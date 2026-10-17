import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import pg from 'pg';
const enabled = process.env.TEST_RECOVERY === '1';
test(
  'AC-12: pg_dump → архив → pg_restore в пустую базу; документы и суммы сохраняются',
  { skip: !enabled, timeout: 120000 },
  async () => {
    const base = process.env.TEST_DATABASE_URL;
    if (!base || !new URL(base).pathname.includes('test'))
      throw new Error('Dedicated TEST_DATABASE_URL is required');
    const suffix = randomUUID().replace(/-/g, '').slice(0, 8),
      sourceDb = 'looma_backup_test_' + suffix,
      targetDb = 'looma_restore_test_' + suffix;
    const admin = new pg.Pool({ connectionString: base });
    const source = new URL(base),
      target = new URL(base);
    source.pathname = '/' + sourceDb;
    target.pathname = '/' + targetDb;
    await admin.query(`CREATE DATABASE ${sourceDb}`);
    await admin.query(`CREATE DATABASE ${targetDb}`);
    const storage = await mkdtemp(join(tmpdir(), 'looma-source-')),
      restored = await mkdtemp(join(tmpdir(), 'looma-target-'));
    process.env.DATABASE_URL = source.toString();
    process.env.STORAGE_DIR = storage;
    process.env.SEED_PASSWORD = 'Recovery-test-only-2026-password';
    const { migrate } = await import('../server/migrate.js');
    const { seed } = await import('../server/seed.js');
    const { pool } = await import('../server/db.js');
    const { buildApp } = await import('../server/app.js');
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    let archive = '';
    const targetPool = new pg.Pool({ connectionString: target.toString() });
    const run = (script: string, args: string[], env: NodeJS.ProcessEnv) =>
      new Promise<void>((res, rej) => {
        const p = spawn(process.execPath, [script, ...args], {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        p.stdout.on('data', (d) => (out += d));
        p.stderr.on('data', (d) => (out += d));
        p.on('error', rej);
        p.on('close', (c) => (c ? rej(new Error(out)) : res()));
      });
    try {
      await migrate();
      await seed(true);
      app = await buildApp();
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-looma-client': 'web' },
        payload: { email: 'owner@looma.local', password: process.env.SEED_PASSWORD },
      });
      assert.equal(login.statusCode, 200, login.body);
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      const {
        rows: [o],
      } = await pool.query('SELECT id FROM orders LIMIT 1');
      const bytes = Buffer.from('%PDF-1.4\nLOOMA recovery\n%%EOF');
      const boundary = 'looma-recovery';
      const upload = await app.inject({
        method: 'POST',
        url: `/api/documents?order_id=${o.id}&category=contract&visibility=commercial`,
        headers: {
          cookie,
          'x-looma-client': 'web',
          'content-type': 'multipart/form-data; boundary=' + boundary,
        },
        payload: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="recovery.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
          ),
          bytes,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      });
      assert.equal(upload.statusCode, 200, upload.body);
      const before = new Set(await readdir('backups').catch(() => []));
      await run('scripts/backup.mjs', ['--native'], process.env);
      archive =
        (await readdir('backups')).find((n) => n.endsWith('.tar.gz') && !before.has(n)) || '';
      assert.ok(archive);
      await run('scripts/restore.mjs', [resolve('backups', archive), '--native'], {
        ...process.env,
        RESTORE_DATABASE_URL: target.toString(),
        RESTORE_STORAGE_DIR: restored,
      });
      const sql =
        'SELECT count(*)::int count,sum(total)::bigint total,sum(paid)::bigint paid,sum(actual_cost)::bigint cost FROM order_totals';
      assert.deepEqual((await targetPool.query(sql)).rows, (await pool.query(sql)).rows);
      for (const table of [
        'clients',
        'money_movements',
        'audit_events',
        'production_steps',
        'document_versions',
      ])
        assert.deepEqual(
          (await targetPool.query(`SELECT count(*)::int count FROM ${table}`)).rows,
          (await pool.query(`SELECT count(*)::int count FROM ${table}`)).rows,
        );
      const docs = (await targetPool.query('SELECT storage_key FROM document_versions')).rows;
      assert.ok(docs.length > 0);
      for (const d of docs) assert.deepEqual(await readFile(join(restored, d.storage_key)), bytes);
    } finally {
      await app?.close();
      await pool.end();
      await targetPool.end();
      await admin.query(`DROP DATABASE ${sourceDb} WITH (FORCE)`);
      await admin.query(`DROP DATABASE ${targetDb} WITH (FORCE)`);
      await admin.end();
      await rm(storage, { recursive: true, force: true });
      await rm(restored, { recursive: true, force: true });
      if (archive) await rm(join('backups', archive), { force: true });
    }
  },
);
