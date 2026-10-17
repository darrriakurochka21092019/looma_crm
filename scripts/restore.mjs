import 'dotenv/config';
import { mkdtemp, mkdir, readFile, readdir, cp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import pg from 'pg';
import * as tar from 'tar';
const archive = process.argv.slice(2).find((v) => !v.startsWith('--'));
if (!archive) throw new Error('Usage: npm run restore -- backup.tar.gz [--native]');
const target = process.env.RESTORE_DATABASE_URL,
  storagePath = process.env.RESTORE_STORAGE_DIR;
if (!target || !storagePath)
  throw new Error(
    'Set RESTORE_DATABASE_URL to a new EMPTY database and RESTORE_STORAGE_DIR to a new empty directory. Working data will not be overwritten.',
  );
if (
  target === process.env.DATABASE_URL ||
  resolve(storagePath) === resolve(process.env.STORAGE_DIR || 'storage')
)
  throw new Error('Use a separate database and document directory for the recovery check.');
const dest = resolve(storagePath);
let initial = [];
try {
  initial = await readdir(dest);
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
if (initial.length) throw new Error('RESTORE_STORAGE_DIR must be empty');
const pool = new pg.Pool({ connectionString: target });
const tables = await pool.query(
  "SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'",
);
await pool.end();
if (tables.rows[0].n !== 0) throw new Error('Recovery target must be an empty database');
const temp = await mkdtemp(join(tmpdir(), 'looma-restore-'));
const entries = [];
try {
  await tar.t({
    file: resolve(archive),
    onReadEntry: (e) => {
      if (e.type !== 'File' && e.type !== 'Directory')
        throw new Error('Archive links are not allowed');
      if (e.path.startsWith('/') || e.path.split(/[\\/]/).includes('..'))
        throw new Error('Invalid archive path');
      entries.push(e.path);
    },
  });
  await tar.x({
    file: resolve(archive),
    cwd: temp,
    strict: true,
    preservePaths: false,
    preserveOwner: false,
    noChown: true,
  });
  const roots = await readdir(temp);
  if (roots.length !== 1) throw new Error('Invalid backup structure');
  const base = join(temp, roots[0]),
    manifest = JSON.parse(await readFile(join(base, 'manifest.json'), 'utf8'));
  if (manifest.app !== 'LOOMA.CRM' || manifest.format !== 1) throw new Error('Unsupported backup');
  const dump = join(base, 'database.dump');
  if (
    manifest.dump_sha256 &&
    manifest.dump_sha256 !==
      createHash('sha256')
        .update(await readFile(dump))
        .digest('hex')
  )
    throw new Error('Backup checksum mismatch');
  const u = new URL(target),
    native = process.argv.includes('--native');
  const env = {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: u.pathname.slice(1),
  };
  const args = native
    ? ['--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', '-d', env.PGDATABASE]
    : [
        'compose',
        'exec',
        '-T',
        'db',
        'pg_restore',
        '-U',
        env.PGUSER,
        '-d',
        env.PGDATABASE,
        '--no-owner',
        '--no-acl',
        '--exit-on-error',
        '--single-transaction',
      ];
  const command = native ? process.env.PG_RESTORE_BIN || 'pg_restore' : 'docker';
  await new Promise((res, rej) => {
    const p = spawn(command, args, { env, stdio: ['pipe', 'inherit', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', rej);
    p.on('close', (code) => (code === 0 ? res() : rej(new Error(err))));
    p.stdin.on('error', () => {});
    readFile(dump)
      .then((data) => p.stdin.end(data))
      .catch(rej);
  });
  await mkdir(dest, { recursive: true });
  const recoveredStorage = join(base, 'storage');
  for (const entry of await readdir(recoveredStorage))
    await cp(join(recoveredStorage, entry), join(dest, entry), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  console.log(
    'Восстановление завершено в отдельную базу и каталог: ' +
      dest +
      '\nПроверьте вход, заказы и скачивание документов перед переключением рабочей конфигурации.',
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
