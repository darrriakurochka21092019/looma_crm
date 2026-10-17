import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, audit, pool, transaction } from '../db.js';
import { accessibleOrder, uuid } from '../security.js';
const schema = z.object({
  title: z.string().trim().min(1).max(250),
  description: z.string().max(10000).default(''),
  order_id: uuid.nullable().default(null),
  assignee_id: uuid,
  due_at: z.string().datetime({ offset: true }),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
});
export async function taskRoutes(app: FastifyInstance) {
  app.get('/tasks', async (req) => {
    const q = z
      .object({
        scope: z.enum(['mine', 'team', 'overdue']).default('mine'),
        order_id: uuid.optional(),
      })
      .parse(req.query);
    const params: any[] = [];
    let where = 'true';
    if (req.user.role === 'owner' && q.scope !== 'mine') {
    } else if (req.user.role === 'manager' && q.scope !== 'mine') {
      params.push(req.user.id);
      where = '(t.assignee_id=$1 OR t.author_id=$1)';
    } else {
      params.push(req.user.id);
      where = 't.assignee_id=$1';
    }
    if (q.scope === 'overdue') where += " AND t.due_at<now() AND t.status<>'done'";
    if (q.order_id) {
      await accessibleOrder(req.user, q.order_id);
      params.push(q.order_id);
      where += ` AND t.order_id=$${params.length}`;
    }
    return (
      await pool.query(
        `SELECT t.*,u.name assignee_name,o.number order_number FROM tasks t JOIN users u ON u.id=t.assignee_id LEFT JOIN orders o ON o.id=t.order_id WHERE ${where} ORDER BY t.due_at LIMIT 500`,
        params,
      )
    ).rows;
  });
  app.post('/tasks', async (req) => {
    const b = schema.parse(req.body);
    return transaction(async (db) => {
      const {
        rows: [a],
      } = await db.query('SELECT role FROM users WHERE id=$1 AND active', [b.assignee_id]);
      if (!a) throw new AppError(400, 'Исполнитель не найден');
      if (
        req.user.role !== 'owner' &&
        b.assignee_id !== req.user.id &&
        !(req.user.role === 'manager' && a.role === 'master')
      )
        throw new AppError(403, 'Нет права назначать задачу этому сотруднику');
      if (b.order_id) {
        await accessibleOrder(req.user, b.order_id, db);
        const {
          rows: [order],
        } = await db.query('SELECT master_id FROM orders WHERE id=$1', [b.order_id]);
        if (
          a.role === 'master' &&
          order.master_id !== b.assignee_id &&
          !(
            await db.query('SELECT 1 FROM production_steps WHERE order_id=$1 AND assignee_id=$2', [
              b.order_id,
              b.assignee_id,
            ])
          ).rowCount
        )
          throw new AppError(400, 'Сначала назначьте мастера на этот заказ или этап');
      }
      const {
        rows: [t],
      } = await db.query(
        'INSERT INTO tasks(title,description,order_id,author_id,assignee_id,due_at,priority) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [b.title, b.description, b.order_id, req.user.id, b.assignee_id, b.due_at, b.priority],
      );
      await audit(
        db,
        req.user.id,
        b.order_id ? 'order' : 'task',
        b.order_id || t.id,
        'task_created',
        null,
        t,
      );
      return t;
    });
  });
  app.patch('/tasks/:id', async (req) => {
    const id = uuid.parse((req.params as any).id);
    const b = z
      .object({
        title: z.string().trim().min(1).max(250).optional(),
        description: z.string().max(10000).optional(),
        order_id: uuid.nullable().optional(),
        assignee_id: uuid.optional(),
        due_at: z.string().datetime({ offset: true }).optional(),
        priority: z.enum(['low', 'normal', 'high']).optional(),
        status: z.enum(['new', 'doing', 'waiting', 'done']).optional(),
        version: z.number().int(),
      })
      .parse(req.body);
    return transaction(async (db) => {
      const {
        rows: [t],
      } = await db.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [id]);
      if (!t) throw new AppError(404, 'Задача не найдена');
      if (
        req.user.role !== 'owner' &&
        t.assignee_id !== req.user.id &&
        !(req.user.role === 'manager' && t.author_id === req.user.id)
      )
        throw new AppError(403, 'Нет доступа');
      if (t.version !== b.version) throw new AppError(409, 'Задача уже изменена. Обновите список');
      if (
        Object.keys(b).some((k) => !['status', 'version'].includes(k)) &&
        !['owner', 'manager'].includes(req.user.role)
      )
        throw new AppError(403, 'Изменять условия задачи может менеджер или владелец');
      const assignee = b.assignee_id || t.assignee_id,
        orderId = b.order_id === undefined ? t.order_id : b.order_id;
      if (b.assignee_id) {
        const {
          rows: [a],
        } = await db.query('SELECT role FROM users WHERE id=$1 AND active', [assignee]);
        if (!a) throw new AppError(400, 'Исполнитель не найден');
        if (req.user.role === 'manager' && assignee !== req.user.id && a.role !== 'master')
          throw new AppError(403, 'Нет права назначать задачу этому сотруднику');
      }
      if (orderId) {
        await accessibleOrder(req.user, orderId, db);
        const {
          rows: [a],
        } = await db.query('SELECT role FROM users WHERE id=$1', [assignee]);
        if (
          a?.role === 'master' &&
          !(
            await db.query(
              'SELECT 1 FROM orders WHERE id=$1 AND master_id=$2 UNION SELECT 1 FROM production_steps WHERE order_id=$1 AND assignee_id=$2',
              [orderId, assignee],
            )
          ).rowCount
        )
          throw new AppError(400, 'Мастер должен быть назначен на этот заказ');
      }
      const {
        rows: [n],
      } = await db.query(
        'UPDATE tasks SET status=$2,title=$3,description=$4,order_id=$5,assignee_id=$6,due_at=$7,priority=$8,version=version+1 WHERE id=$1 RETURNING *',
        [
          id,
          b.status ?? t.status,
          b.title ?? t.title,
          b.description ?? t.description,
          orderId,
          assignee,
          b.due_at ?? t.due_at,
          b.priority ?? t.priority,
        ],
      );
      await audit(
        db,
        req.user.id,
        t.order_id ? 'order' : 'task',
        t.order_id || id,
        'task_updated',
        t,
        n,
      );
      return n;
    });
  });
  async function accessibleTask(req: any, id: string) {
    const {
      rows: [t],
    } = await pool.query('SELECT * FROM tasks WHERE id=$1', [id]);
    if (!t) throw new AppError(404, 'Задача не найдена');
    if (
      req.user.role !== 'owner' &&
      t.assignee_id !== req.user.id &&
      !(req.user.role === 'manager' && t.author_id === req.user.id)
    )
      throw new AppError(403, 'Нет доступа');
    return t;
  }
  app.get('/tasks/:id/comments', async (req) => {
    const id = uuid.parse((req.params as any).id);
    await accessibleTask(req, id);
    return (
      await pool.query(
        'SELECT c.*,u.name author_name FROM task_comments c JOIN users u ON u.id=c.author_id WHERE task_id=$1 ORDER BY created_at',
        [id],
      )
    ).rows;
  });
  app.post('/tasks/:id/comments', async (req) => {
    const id = uuid.parse((req.params as any).id);
    await accessibleTask(req, id);
    const b = z.object({ text: z.string().trim().min(1).max(5000) }).parse(req.body);
    return transaction(async (db) => {
      const {
        rows: [c],
      } = await db.query(
        'INSERT INTO task_comments(task_id,author_id,text) VALUES($1,$2,$3) RETURNING *',
        [id, req.user.id, b.text],
      );
      await audit(db, req.user.id, 'task', id, 'comment_added', null, { id: c.id });
      return c;
    });
  });
}
