import 'dotenv/config';
import { mkdir, cp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createWriteStream, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import * as tar from 'tar';
const source = process.env.DATABASE_URL;
if (!source) throw new Error('DATABASE_URL is required');
const url = new URL(source),
  native = process.argv.includes('--native');
const stamp = new Date().toISOString().replace(/[:.]/g, '-'),
  root = resolve('backups'),
  name = 'looma-' + stamp,
  dir = join(root, name);
await mkdir(dir, { recursive: true, mode: 0o700 });
const pgEnv = {
  ...process.env,
  PGHOST: url.hostname,
  PGPORT: url.port || '5432',
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGDATABASE: url.pathname.slice(1),
};
export async function runToFile(command, args, env, out) {
  return new Promise((res, rej) => {
    const p = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stream = createWriteStream(out, { mode: 0o600, flags: 'wx' });
    p.stdout.pipe(stream);
    let error = '';
    p.stderr.on('data', (d) => (error += d));
    p.on('error', rej);
    stream.on('error', rej);
    p.on('close', (code) => {
      stream.on('finish', () => (code === 0 ? res() : rej(new Error(error || 'pg_dump failed'))));
      if (stream.writableFinished) code === 0 ? res() : rej(new Error(error));
    });
  });
}
try {
  const command = native ? process.env.PG_DUMP_BIN || 'pg_dump' : 'docker';
  const args = native
    ? ['-Fc', '--no-owner', '--no-acl']
    : [
        'compose',
        'exec',
        '-T',
        'db',
        'pg_dump',
        '-U',
        pgEnv.PGUSER,
        '-d',
        pgEnv.PGDATABASE,
        '-Fc',
        '--no-owner',
        '--no-acl',
      ];
  const dump = join(dir, 'database.dump');
  await runToFile(command, args, pgEnv, dump);
  const storage = resolve(process.env.STORAGE_DIR || 'storage');
  try {
    await cp(storage, join(dir, 'storage'), { recursive: true, errorOnExist: true, force: false });
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    await mkdir(join(dir, 'storage'));
  }
  const digest = await new Promise((res, rej) => {
    const h = createHash('sha256'),
      r = createReadStream(dump);
    r.on('data', (d) => h.update(d));
    r.on('end', () => res(h.digest('hex')));
    r.on('error', rej);
  });
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        app: 'LOOMA.CRM',
        format: 1,
        created_at: new Date().toISOString(),
        database: 'database.dump',
        storage: 'storage',
        dump_sha256: digest,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  const archive = join(root, name + '.tar.gz');
  await tar.c({ gzip: true, file: archive, cwd: root, portable: true }, [name]);
  await rm(dir, { recursive: true });
  console.log('Резервная копия создана: ' + archive);
} catch (e) {
  await rm(dir, { recursive: true, force: true });
  throw e;
}
