import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import PizZip from 'pizzip';

const output = resolve('artifacts');
const root = join(output, 'LOOMA.CRM');
await rm(root, { recursive: true, force: true });
await mkdir(join(root, 'scripts'), { recursive: true });
for (const path of ['dist', 'dist-web', 'db', 'docs', 'templates'])
  await cp(resolve(path), join(root, path), { recursive: true });
for (const name of ['setup.mjs', 'start-ready.mjs', 'backup.mjs', 'restore.mjs'])
  await cp(resolve('scripts', name), join(root, 'scripts', name));
await cp(resolve('start-ready.bat'), join(root, 'start-ready.bat'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
delete pkg.devDependencies;
pkg.scripts = {
  setup: 'node scripts/setup.mjs',
  'db:migrate': 'node dist/server/migrate.js',
  'db:seed': 'node dist/server/seed.js',
  start: 'node scripts/start-ready.mjs',
  backup: 'node scripts/backup.mjs',
  restore: 'node scripts/restore.mjs',
};
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
delete lock.packages[''].devDependencies;
await writeFile(join(root, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
await writeFile(join(root, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
await writeFile(
  join(root, 'START_HERE.txt'),
  `LOOMA.CRM 1.2.0 — готовая сборка без Docker\n\nУЖЕ ЕСТЬ РАБОТАЮЩАЯ CRM? Сначала прочтите docs/UPDATE_1_2.md.\nСохраните старую папку, перенесите .env и storage в новую сборку.\nБаза PostgreSQL остаётся прежней. В браузере после запуска нажмите Ctrl+F5.\n\nТребуются Node.js 24 и работающий PostgreSQL 17.\nИнтерфейс и сервер уже собраны; Vite, tsx и esbuild на этом компьютере не устанавливаются.\n\n1. Распакуй архив целиком в отдельную папку.\n2. Если уже настроила проект, скопируй из прежней папки файл .env в новую, рядом со start-ready.bat.\n   Если использовала документы CRM, перенеси также папку storage.\n3. Если .env ещё нет, выполни node scripts/setup.mjs и открой созданный .env через Блокнот.\n4. В DATABASE_URL укажи подключение к созданной базе:\n   DATABASE_URL=postgres://looma:ПАРОЛЬ_ПОЛЬЗОВАТЕЛЯ_LOOMA@127.0.0.1:5432/looma\n   Специальные символы пароля в URL должны быть percent-encoded.\n5. Открой start-ready.bat. При первом запуске скачаются только зависимости сервера.\n6. После сообщения Server listening открой http://localhost:3001.\n\nЛогин: owner@looma.local. Пароль CRM: SEED_PASSWORD из .env.\nОкно сервера оставь открытым. Остановка: Ctrl+C.\nПовторный запуск сохраняет данные и пароль существующего владельца.\nРабочие настройки, база и документы в этот архив не входят.\n\nИсходники и инструкции: https://github.com/darrriakurochka21092019/looma_crm\n`,
);
const zip = new PizZip();
async function add(directory, prefix) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name),
      name = prefix + entry.name;
    if (entry.isDirectory()) await add(path, name + '/');
    else if (entry.isFile()) zip.file(name, await readFile(path));
    else throw new Error('Unexpected package entry: ' + name);
  }
}
await add(root, 'LOOMA.CRM/');
const archive = join(output, 'LOOMA_CRM_READY.zip');
await writeFile(archive, zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log('Готовая сборка: ' + archive);
