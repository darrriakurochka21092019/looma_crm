import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, audit, pool, transaction } from '../db.js';
import { requireRole, uuid } from '../security.js';
import { MaxError, maxRequest, publicMaxConfig, readMaxConfig, saveMaxConfig } from '../max.js';

const maxId = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/, 'Нужен числовой ID пользователя MAX')
  .refine((s) => BigInt(s) <= 9223372036854775807n, 'Слишком большой ID MAX');
export async function maxRoutes(app: FastifyInstance) {
  app.get('/settings/max', async (req) => {
    requireRole(req, 'owner');
    const config = await readMaxConfig();
    const recipients = (
      await pool.query(
        'SELECT u.id,u.name,u.role,u.active,r.max_user_id,r.enabled,COALESCE(r.version,0) version FROM users u LEFT JOIN max_recipients r ON r.user_id=u.id ORDER BY u.name',
      )
    ).rows;
    const deliveries = (
      await pool.query(
        `SELECT n.id,n.kind,n.status,n.error,n.attempts,n.created_at,n.sent_at,t.title,u.name assignee_name
       FROM task_notifications n JOIN tasks t ON t.id=n.task_id JOIN users u ON u.id=n.user_id
       ORDER BY n.created_at DESC LIMIT 30`,
      )
    ).rows;
    return { ...publicMaxConfig(config), recipients, deliveries };
  });
  app.patch('/settings/max', async (req) => {
    requireRole(req, 'owner');
    const b = z
      .object({
        version: z.number().int().nonnegative(),
        enabled: z.boolean(),
        token: z
          .string()
          .trim()
          .min(1)
          .max(1000)
          .regex(/^\S+$/, 'В токене не должно быть пробелов')
          .optional(),
        reminder_minutes: z.number().int().min(1).max(1440),
      })
      .parse(req.body);
    return saveMaxConfig(req.user.id, b);
  });
  app.post('/settings/max/check', async (req) => {
    requireRole(req, 'owner');
    const config = await readMaxConfig();
    if (!config.token) throw new AppError(400, 'Сначала сохраните токен');
    try {
      const bot = await maxRequest('/me', config.token);
      return { name: bot.name || bot.first_name || bot.username || 'Бот MAX', ok: true };
    } catch (err) {
      throw new AppError(400, err instanceof MaxError ? err.message : 'MAX вернул неверный ответ');
    }
  });
  // One manual lookup for a local installation, not a background polling service.
  // Hosted installations can enter known IDs without consuming bot updates.
  app.post('/settings/max/discover', async (req) => {
    requireRole(req, 'owner');
    const config = await readMaxConfig();
    if (!config.token) throw new AppError(400, 'Сначала сохраните токен');
    try {
      const result = await maxRequest(
        '/updates?timeout=0&limit=100&types=bot_started,message_created',
        config.token,
      );
      const contacts = new Map<string, { id: string; name: string }>();
      for (const update of result.updates || []) {
        const user = update.user || update.message?.sender;
        const id = String(user?.user_id || '');
        if (maxId.safeParse(id).success && !user.is_bot)
          contacts.set(id, {
            id,
            name: String(user.name || user.first_name || user.username || 'Пользователь MAX').slice(
              0,
              200,
            ),
          });
      }
      return { contacts: [...contacts.values()] };
    } catch (err) {
      throw new AppError(
        400,
        err instanceof MaxError ? err.message : 'Не удалось получить пользователей бота',
      );
    }
  });
  app.patch('/settings/max/recipients/:id', async (req) => {
    requireRole(req, 'owner');
    const id = uuid.parse((req.params as any).id);
    const b = z
      .object({ max_user_id: maxId, enabled: z.boolean(), version: z.number().int().nonnegative() })
      .parse(req.body);
    return transaction(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(71630923)');
      if (!(await db.query('SELECT 1 FROM users WHERE id=$1', [id])).rowCount)
        throw new AppError(404, 'Сотрудник не найден');
      const {
        rows: [old],
      } = await db.query('SELECT * FROM max_recipients WHERE user_id=$1 FOR UPDATE', [id]);
      if ((old?.version || 0) !== b.version) throw new AppError(409, 'Привязка MAX уже изменена');
      const {
        rows: [r],
      } = await db.query(
        `INSERT INTO max_recipients(user_id,max_user_id,enabled) VALUES($1,$2,$3)
         ON CONFLICT(user_id) DO UPDATE SET max_user_id=$2,enabled=$3,version=max_recipients.version+1 RETURNING *`,
        [id, b.max_user_id, b.enabled],
      );
      await audit(db, req.user.id, 'integration', 'max', 'max_recipient_updated', null, {
        user_id: id,
        enabled: b.enabled,
      });
      return { version: r.version, enabled: r.enabled, max_user_id: r.max_user_id };
    });
  });
  app.post('/settings/max/retry', async (req) => {
    requireRole(req, 'owner');
    await pool.query(
      "UPDATE task_notifications SET status='pending',attempts=0,next_attempt_at=now(),error=NULL WHERE status='failed'",
    );
    return { ok: true };
  });
}
