import { access, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { release } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const marker = resolve(root, 'node_modules/.looma-runtime-lock');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error('Для запуска нужен Node.js 22.12 или новее. Рекомендуется Node.js 24.');
  process.exit(1);
}
function run(command, args, title) {
  console.log('LOOMA.CRM: ' + title + '…');
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: false });
    const stop = (signal) => child.kill(signal);
    const stopTerm = () => stop('SIGTERM');
    const stopInt = () => stop('SIGINT');
    const detach = () => {
      process.removeListener('SIGTERM', stopTerm);
      process.removeListener('SIGINT', stopInt);
    };
    process.on('SIGTERM', stopTerm);
    process.on('SIGINT', stopInt);
    child.once('error', (error) => {
      detach();
      reject(new Error(`${title}: ${error.message}`));
    });
    child.once('exit', (code, signal) => {
      detach();
      if (code === 0) resolveRun();
      else {
        const crash = typeof code === 'number' && code >>> 0 === 0xc0000005;
        reject(
          new Error(
            crash
              ? `${title}: аварийное завершение Node.js (0xC0000005). Скопируйте весь вывод этого окна, начиная со строки «Запуск LOOMA.CRM».`
              : `${title}: код ${code ?? signal}. См. сообщение выше.`,
          ),
        );
      }
    });
  });
}
try {
  console.log(
    `Запуск LOOMA.CRM: Node.js ${process.versions.node}, ${process.platform} ${release()}, ${process.arch}`,
  );
  await readFile(resolve(root, 'dist/server/index.js'));
  await readFile(resolve(root, 'dist-web/index.html'));
  await run(process.execPath, ['scripts/setup.mjs'], 'Создание настроек');
  const fingerprint = createHash('sha256')
    .update(await readFile(resolve(root, 'package-lock.json')))
    .digest('hex');
  const installed = await readFile(marker, 'utf8').catch(() => '');
  if (installed !== fingerprint) {
    console.log('Устанавливаются только зависимости готового приложения, без Vite, tsx и esbuild.');
    const npmArgs = ['ci', '--omit=dev', '--ignore-scripts', '--no-fund'];
    if (process.platform === 'win32') {
      const npmCli = resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
      await access(npmCli);
      await run(process.execPath, [npmCli, ...npmArgs], 'Установка зависимостей');
    } else await run('npm', npmArgs, 'Установка зависимостей');
    await run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import {hashPassword,verifyPassword} from './dist/server/passwords.js'; const h=await hashPassword('LOOMA install check'); if(!await verifyPassword(h,'LOOMA install check')) process.exit(1);",
      ],
      'Проверка готового модуля паролей',
    );
    await writeFile(marker, fingerprint);
  }
  await run(process.execPath, ['dist/server/seed.js'], 'Подготовка базы и владельца');
  const { config } = await import('dotenv');
  config({ path: resolve(root, '.env'), quiet: true });
  console.log(`После запуска сервера открой http://localhost:${process.env.PORT || 3001}`);
  console.log(
    'Логин: owner@looma.local. Пароль: SEED_PASSWORD в .env. Окно сервера оставь открытым.',
  );
  await run(process.execPath, ['dist/server/index.js'], 'Сервер');
} catch (error) {
  console.error('LOOMA.CRM: ' + error.message);
  process.exitCode = 1;
}
