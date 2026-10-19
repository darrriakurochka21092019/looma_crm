import 'dotenv/config';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import staticPlugin from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { AppError, databaseUnavailable, hash, pool } from './db.js';
import { authRoutes } from './routes/auth.js';
import { orderRoutes } from './routes/orders.js';
import { financeRoutes } from './routes/finance.js';
import { taskRoutes } from './routes/tasks.js';
import { documentRoutes } from './routes/documents.js';
import { documentGenerationRoutes } from './routes/document-generation.js';
import { settingsRoutes } from './routes/settings.js';
import { importRoutes } from './routes/imports.js';
import { maxRoutes } from './routes/max.js';
export async function buildApp(logger = false) {
  const app = Fastify({
    logger: logger
      ? { redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers.set-cookie'] }
      : false,
    bodyLimit: 1024 * 1024,
    trustProxy: process.env.TRUST_PROXY === 'true',
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameSrc: ["'self'", 'blob:'],
        upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
      },
    },
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });
  await app.register(multipart, {
    limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 10, parts: 11 },
  });
  app.decorateRequest('user', undefined as any);
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const origins = (process.env.APP_ORIGIN || 'http://localhost:5173')
      .split(',')
      .map((s) => s.trim());
    // The same local app is commonly opened through either loopback hostname.
    for (const origin of [...origins]) {
      try {
        const url = new URL(origin);
        if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
          url.hostname = url.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
          origins.push(url.origin);
        }
      } catch {
        /* Invalid configured origins are never allowed. */
      }
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && !origins.includes(origin))
        throw new AppError(403, 'Источник запроса не разрешён');
      // Browser form submissions cannot set this header; SameSite cookie is an additional protection.
      if (req.headers['x-looma-client'] !== 'web')
        throw new AppError(403, 'Необходим заголовок клиента CRM');
    }
    if (
      req.url.split('?')[0] === '/api/health' ||
      req.url.startsWith('/api/auth/login') ||
      req.url.startsWith('/api/auth/invite/') ||
      req.url.startsWith('/api/auth/accept-invite')
    )
      return;
    const token = req.cookies.looma_session;
    if (!token) throw new AppError(401, 'Войдите в LOOMA.CRM');
    const {
      rows: [u],
    } = await pool.query(
      'SELECT u.id,u.name,u.email,u.role,u.active FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active',
      [hash(token)],
    );
    if (!u) throw new AppError(401, 'Сессия истекла. Войдите снова');
    req.user = u;
    reply.header('Cache-Control', 'no-store');
  });
  app.setErrorHandler((err: any, req, reply) => {
    if (databaseUnavailable(err)) {
      req.log.warn({ code: err.code || 'CONNECTION_LOST' }, 'PostgreSQL temporarily unavailable');
      return reply.status(503).header('Retry-After', '5').send({
        message:
          'Связь с базой временно прервана. Подождите несколько секунд и обновите данные. Перед повтором оплаты проверьте журнал операций.',
      });
    }
    if (err instanceof z.ZodError) {
      reply.status(400).send({
        message: err.issues
          .map((i) => {
            const names: Record<string, string> = {
              amount: 'Сумма',
              price: 'Цена',
              quantity: 'Количество',
              phone: 'Телефон',
              name: 'Имя',
              email: 'Email',
              password: 'Пароль',
              title: 'Название',
              due_date: 'Срок',
              due_at: 'Срок',
              items: 'Изделия',
              discount: 'Скидка',
              client_id: 'Клиент',
              assignee_id: 'Исполнитель',
              planned_cost: 'План затрат',
              version: 'Версия записи',
              occurred_on: 'Дата оплаты',
              incurred_on: 'Дата расхода',
            };
            const field = i.path
              .map((p) => (typeof p === 'number' ? String(p + 1) : names[String(p)] || 'Поле'))
              .join(' / ');
            const message = /[а-яё]/i.test(i.message)
              ? i.message
              : (
                  {
                    too_small: 'Заполните поле или увеличьте значение',
                    too_big: 'Слишком большое значение',
                    invalid_format: 'Неверный формат',
                    invalid_type: 'Проверьте значение',
                  } as Record<string, string>
                )[i.code] || 'Проверьте значение';
            return field ? field + ': ' + message : message;
          })
          .join('; '),
      });
      return;
    }
    if (err.code === '23505') {
      reply.status(409).send({
        message:
          'Такая запись уже существует. Проверьте телефон, номер договора или повтор операции',
      });
      return;
    }
    if (err.code === '23503') {
      reply.status(400).send({ message: 'Связанная запись не найдена или ещё используется' });
      return;
    }
    const status = err.statusCode || 500;
    if (status >= 500) req.log.error({ code: err.code, name: err.name }, 'Request failed');
    reply.status(status).send({
      message: status >= 500 ? 'Не удалось выполнить операцию. Повторите попытку' : err.message,
    });
  });
  await app.register(
    async (api) => {
      api.get('/health', async () => {
        await pool.query('SELECT 1');
        return { status: 'ok', app: 'LOOMA.CRM', version: '1.2.1' };
      });
      await authRoutes(api);
      await orderRoutes(api);
      await taskRoutes(api);
      await financeRoutes(api);
      await documentRoutes(api);
      await documentGenerationRoutes(api);
      await settingsRoutes(api);
      await maxRoutes(api);
      await importRoutes(api);
    },
    { prefix: '/api' },
  );
  if (existsSync(resolve('dist-web/index.html'))) {
    await app.register(staticPlugin, { root: resolve('dist-web'), prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/'))
        return reply.status(404).send({ message: 'Маршрут не найден' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}
