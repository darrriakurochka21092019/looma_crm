import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
if (existsSync('.env')) {
  console.log('.env уже существует. Настройки сохранены.');
  process.exit(0);
}
const dbPassword = randomBytes(24).toString('hex'),
  ownerPassword = randomBytes(15).toString('base64url');
const env = `DATABASE_URL=postgres://looma:${dbPassword}@127.0.0.1:5432/looma\nPOSTGRES_USER=looma\nPOSTGRES_PASSWORD=${dbPassword}\nPOSTGRES_DB=looma\nPORT=3001\nHOST=127.0.0.1\nAPP_ORIGIN=http://localhost:3001,http://localhost:5173,http://127.0.0.1:5173\nNODE_ENV=development\nCOOKIE_SECURE=false\nSTORAGE_DIR=./storage\nCOMPANY_TIMEZONE=Europe/Moscow\nSEED_PASSWORD=${ownerPassword}\n`;
writeFileSync('.env', env, { mode: 0o600, flag: 'wx' });
console.log(
  'Настройки созданы в .env.\nЛогин владельца: owner@looma.local\nПароль владельца — значение SEED_PASSWORD в файле .env.\nДля чистой базы: npm run db:seed\nС демонстрационными заказами: npm run db:seed -- --demo',
);
