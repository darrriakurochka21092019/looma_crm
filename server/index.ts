import 'dotenv/config';
import { buildApp } from './app.js';
import { migrate } from './migrate.js';
import { pool } from './db.js';
import { startMaxWorker } from './max.js';
if (!process.env.DATABASE_URL)
  throw new Error('DATABASE_URL не задан. Выполните npm run setup и настройте PostgreSQL.');
await migrate();
const app = await buildApp(true);
const stopNotifications = startMaxWorker(app.log);
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await stopNotifications();
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
await app.listen({ port: Number(process.env.PORT || 3001), host: process.env.HOST || '127.0.0.1' });
