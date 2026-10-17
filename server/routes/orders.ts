import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, audit, idempotent, pool, transaction, type DB } from '../db.js';
import {
  accessibleOrder,
  date,
  money,
  projectItem,
  projectOrder,
  requireRole,
  uuid,
} from '../security.js';
import { canFinance, statuses, type User } from '../../shared/domain.js';
export const clientSchema = z.object({
  type: z.enum(['person', 'company']).default('person'),
  name: z.string().trim().min(1).max(200),
  phone: z
    .string()
    .transform((s) => s.replace(/\D/g, ''))
    .refine((s) => s.length >= 10 && s.length <= 15, 'Телефон должен содержать 10–15 цифр')
    .transform((s) =>
      s.length === 10 ? '7' + s : s.length === 11 && s[0] === '8' ? '7' + s.slice(1) : s,
    ),
  email: z.union([z.literal(''), z.string().email()]).default(''),
  address: z.string().max(1000).default(''),
  details: z.string().max(3000).default(''),
  source: z.string().max(100).default(''),
  notes: z.string().max(5000).default(''),
  consent_basis: z.string().max(1000).default(''),
});
export const itemSchema = z.object({
  kind: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  quantity: z.number().int().min(1).max(1000),
  dimensions: z.string().max(200).default(''),
  fabric: z.string().max(300).default(''),
  color: z.string().max(200).default(''),
  filling: z.string().max(300).default(''),
  mechanism: z.string().max(300).default(''),
  notes: z.string().max(5000).default(''),
  price: money,
  planned_cost: money.optional(),
});
export const orderSchema = z.object({
  client_id: uuid,
  title: z.string().trim().min(1).max(200),
  due_date: date,
  manager_id: uuid.nullable().default(null),
  master_id: uuid.nullable().default(null),
  discount: money.default(0),
  notes: z.string().max(10000).default(''),
  items: z.array(itemSchema).min(1).max(100),
});
export async function insertOrder(db: DB, b: z.infer<typeof orderSchema>, user: User) {
  const subtotal = b.items.reduce((s, i) => s + i.price * i.quantity, 0);
  if (!Number.isSafeInteger(subtotal) || subtotal > 9e12)
    throw new AppError(400, 'Стоимость заказа слишком большая');
  const planned = b.items.reduce((sum, i) => sum + (i.planned_cost || 0) * i.quantity, 0);
  if (!Number.isSafeInteger(planned) || planned > 9e12)
    throw new AppError(400, 'План затрат слишком большой');
  if (b.discount > subtotal) throw new AppError(400, 'Скидка больше стоимости изделий');
  await validateAssignees(db, b.manager_id, b.master_id);
  const {
    rows: [n],
  } = await db.query("SELECT nextval('order_number_seq') n");
  const number = `LM-${String(n.n).padStart(5, '0')}`;
  const {
    rows: [o],
  } = await db.query(
    'INSERT INTO orders(number,client_id,title,due_date,manager_id,master_id,discount,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [
      number,
      b.client_id,
      b.title,
      b.due_date,
      b.manager_id || user.id,
      b.master_id,
      b.discount,
      b.notes,
    ],
  );
  for (const [position, i] of b.items.entries()) await insertItem(db, o.id, i, user.role, position);
  const {
    rows: [s],
  } = await db.query('SELECT data FROM settings WHERE id=1');
  for (const [pos, name] of (s.data.step_names as string[]).entries())
    await db.query(
      'INSERT INTO production_steps(order_id,name,position,assignee_id,due_date) VALUES($1,$2,$3,$4,$5)',
      [o.id, name, pos, b.master_id, b.due_date],
    );
  await audit(db, user.id, 'order', o.id, 'created', null, {
    number,
    title: b.title,
    total: subtotal - b.discount,
  });
  return o;
}
async function validateAssignees(db: DB, manager: string | null, master: string | null) {
  for (const [id, allowed] of [
    [manager, ['manager', 'owner']],
    [master, ['master', 'owner']],
  ] as const) {
    if (
      id &&
      !(
        await db.query('SELECT 1 FROM users WHERE id=$1 AND role=ANY($2::text[]) AND active', [
          id,
          allowed,
        ])
      ).rowCount
    )
      throw new AppError(400, 'Неверный исполнитель или менеджер');
  }
}
async function insertItem(
  db: DB,
  id: string,
  i: z.infer<typeof itemSchema>,
  role: string,
  position = 0,
) {
  await db.query(
    'INSERT INTO order_items(order_id,kind,model,quantity,dimensions,fabric,color,filling,mechanism,notes,price,planned_cost,position) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
    [
      id,
      i.kind,
      i.model,
      i.quantity,
      i.dimensions,
      i.fabric,
      i.color,
      i.filling,
      i.mechanism,
      i.notes,
      i.price,
      canFinance(role as any) ? i.planned_cost || 0 : 0,
      position,
    ],
  );
}
export async function orderRoutes(app: FastifyInstance) {
  app.get('/clients', async (req) => {
    const q = z
      .object({
        q: z.string().max(200).default(''),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse(req.query);
    const isMaster = req.user.role === 'master';
    const params: any[] = [`%${q.q}%`];
    let where = '(c.name ILIKE $1 OR c.phone ILIKE $1 OR c.email ILIKE $1)';
    if (isMaster) {
      params.push(req.user.id);
      where +=
        ' AND EXISTS(SELECT 1 FROM orders o WHERE o.client_id=c.id AND (o.master_id=$2 OR EXISTS(SELECT 1 FROM production_steps ps WHERE ps.order_id=o.id AND ps.assignee_id=$2)))';
    }
    params.push(q.limit, (q.page - 1) * q.limit);
    const select = isMaster ? 'c.id,c.name,c.phone,c.address' : 'c.*';
    return (
      await pool.query(
        `SELECT ${select},count(*) OVER()::int AS total_count FROM clients c WHERE ${where} ORDER BY c.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      )
    ).rows;
  });
  app.post('/clients', async (req) => {
    requireRole(req, 'owner', 'manager');
    const b = clientSchema.parse(req.body);
    return transaction(async (db) => {
      const {
        rows: [c],
      } = await db.query(
        'INSERT INTO clients(type,name,phone,email,address,details,source,notes,consent_basis) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
        Object.values(b),
      );
      await audit(db, req.user.id, 'client', c.id, 'created', null, b);
      return c;
    });
  });
  app.patch('/clients/:id', async (req) => {
    requireRole(req, 'owner', 'manager');
    const id = uuid.parse((req.params as any).id);
    const b = clientSchema.extend({ version: z.number().int() }).parse(req.body);
    return transaction(async (db) => {
      const {
        rows: [old],
      } = await db.query('SELECT * FROM clients WHERE id=$1 FOR UPDATE', [id]);
      if (!old) throw new AppError(404, 'Клиент не найден');
      if (old.version !== b.version)
        throw new AppError(409, 'Клиент уже изменён другим сотрудником. Обновите карточку');
      const {
        rows: [c],
      } = await db.query(
        'UPDATE clients SET type=$2,name=$3,phone=$4,email=$5,address=$6,details=$7,source=$8,notes=$9,consent_basis=$10,version=version+1 WHERE id=$1 RETURNING *',
        [
          id,
          b.type,
          b.name,
          b.phone,
          b.email,
          b.address,
          b.details,
          b.source,
          b.notes,
          b.consent_basis,
        ],
      );
      await audit(db, req.user.id, 'client', id, 'updated', old, c);
      return c;
    });
  });
  app.get('/orders', async (req) => {
    const q = z
      .object({
        q: z.string().max(200).default(''),
        status: z.enum(statuses).optional(),
        client_id: uuid.optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(200).default(30),
        sort: z.enum(['due', 'newest']).default('due'),
      })
      .parse(req.query);
    const params: any[] = [`%${q.q}%`];
    let where =
      'NOT archived AND (title ILIKE $1 OR number ILIKE $1 OR client_name ILIKE $1 OR client_phone ILIKE $1)';
    if (q.status) {
      params.push(q.status);
      where += ` AND status=$${params.length}`;
    }
    if (q.client_id) {
      params.push(q.client_id);
      where += ` AND client_id=$${params.length}`;
    }
    if (req.user.role === 'master') {
      params.push(req.user.id);
      where += ` AND (master_id=$${params.length} OR EXISTS(SELECT 1 FROM production_steps p WHERE p.order_id=order_totals.id AND p.assignee_id=$${params.length}))`;
    }
    const {
      rows: [c],
    } = await pool.query(`SELECT count(*)::int count FROM order_totals WHERE ${where}`, params);
    params.push(q.limit, (q.page - 1) * q.limit);
    const { rows } = await pool.query(
      `SELECT * FROM order_totals WHERE ${where} ORDER BY ${q.sort === 'due' ? 'due_date ASC' : 'created_at DESC'},id LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return {
      items: rows.map((o) => projectOrder(o, req.user.role)),
      total: c.count,
      page: q.page,
      limit: q.limit,
    };
  });
  app.post('/orders', async (req) => {
    requireRole(req, 'owner', 'manager');
    const b = orderSchema.extend({ idempotency_key: uuid }).parse(req.body);
    return transaction((db) =>
      idempotent(db, b.idempotency_key, req.user.id, 'order', b, async () =>
        projectOrder(await insertOrder(db, b, req.user), req.user.role),
      ),
    );
  });
  app.get('/orders/:id', async (req) => {
    const id = (req.params as any).id;
    await accessibleOrder(req.user, id);
    const {
      rows: [o],
    } = await pool.query('SELECT * FROM order_totals WHERE id=$1', [id]);
    const items = (
      await pool.query('SELECT * FROM order_items WHERE order_id=$1 ORDER BY position,id', [id])
    ).rows;
    const steps = (
      await pool.query(
        'SELECT p.*,u.name assignee_name FROM production_steps p LEFT JOIN users u ON u.id=p.assignee_id WHERE order_id=$1 ORDER BY position',
        [id],
      )
    ).rows;
    const plans =
      req.user.role === 'master'
        ? []
        : (
            await pool.query('SELECT * FROM payment_plans WHERE order_id=$1 ORDER BY due_date', [
              id,
            ])
          ).rows;
    return {
      ...projectOrder(o, req.user.role),
      items: items.map((i) => projectItem(i, req.user.role)),
      steps,
      payment_plans: plans,
    };
  });
  app.patch('/orders/:id', async (req) => {
    requireRole(req, 'owner', 'manager');
    const id = uuid.parse((req.params as any).id);
    const b = z
      .object({
        version: z.number().int(),
        title: z.string().trim().min(1).max(200).optional(),
        due_date: date.optional(),
        manager_id: uuid.nullable().optional(),
        master_id: uuid.nullable().optional(),
        notes: z.string().max(10000).optional(),
        status: z.enum(statuses).optional(),
        reason: z.string().max(2000).optional(),
        handed_over: z.boolean().optional(),
        discount: money.optional(),
        items: z.array(itemSchema).min(1).max(100).optional(),
      })
      .parse(req.body);
    return transaction(async (db) => {
      const old = await accessibleOrder(req.user, id, db, true);
      if (old.version !== b.version)
        throw new AppError(409, 'Заказ изменён другим сотрудником. Обновите карточку');
      const oldItems = (
        await db.query('SELECT * FROM order_items WHERE order_id=$1 ORDER BY position,id', [id])
      ).rows;
      const oldTotal = oldItems.reduce((s, i) => s + i.price * i.quantity, 0) - old.discount;
      if (
        req.user.role === 'manager' &&
        ['contract', 'production', 'ready', 'closed'].includes(old.status)
      ) {
        const changed =
          (b.discount !== undefined && b.discount !== old.discount) ||
          (b.items &&
            b.items.some(
              (i, n) => i.price !== oldItems[n]?.price || i.quantity !== oldItems[n]?.quantity,
            ));
        if (changed) throw new AppError(403, 'После договора цену и количество меняет владелец');
      }
      const {
        rows: [settings],
      } = await db.query('SELECT data FROM settings WHERE id=1');
      if (b.status && ['paused', 'cancelled'].includes(b.status)) {
        requireRole(req, 'owner');
        if (!b.reason?.trim()) throw new AppError(400, 'Укажите причину остановки или отмены');
      }
      if (b.status === 'production' && !(b.master_id || old.master_id))
        throw new AppError(400, 'Назначьте мастера перед запуском производства');
      if (
        b.status === 'ready' &&
        (
          await db.query(
            "SELECT 1 FROM production_steps WHERE order_id=$1 AND name<>'Доставка' AND status NOT IN ('done','skipped')",
            [id],
          )
        ).rowCount
      )
        throw new AppError(400, 'Завершите этапы производства и контроль качества');
      if (b.status === 'closed' && old.status !== 'closed') {
        if (req.user.role === 'manager' && !settings.data.manager_can_close)
          throw new AppError(403, 'Закрывать заказы может только владелец');
        if (!b.handed_over) throw new AppError(400, 'Подтвердите передачу изделия клиенту');
      }
      await validateAssignees(db, b.manager_id ?? old.manager_id, b.master_id ?? old.master_id);
      let newItems = b.items;
      if (newItems) {
        const previous = oldItems;
        // Managers may edit specifications and prices; protected planned costs remain server-side.
        if (!canFinance(req.user.role)) {
          if (previous.length !== newItems.length)
            throw new AppError(403, 'Изменение состава изделий после создания доступно владельцу');
          newItems = newItems.map((i, p) => ({ ...i, planned_cost: previous[p].planned_cost }));
        }
        const planned = newItems.reduce((sum, i) => sum + (i.planned_cost || 0) * i.quantity, 0);
        if (!Number.isSafeInteger(planned) || planned > 9e12)
          throw new AppError(400, 'План затрат слишком большой');
        const subtotal = newItems.reduce((s, i) => s + i.price * i.quantity, 0);
        if (!Number.isSafeInteger(subtotal) || subtotal > 9e12)
          throw new AppError(400, 'Стоимость заказа слишком большая');
        if ((b.discount ?? old.discount) > subtotal)
          throw new AppError(400, 'Скидка больше стоимости изделий');
        await db.query('DELETE FROM order_items WHERE order_id=$1', [id]);
        for (const [position, i] of newItems.entries())
          await insertItem(db, id, i, 'owner', position);
      } else if (b.discount !== undefined) {
        const {
          rows: [x],
        } = await db.query(
          'SELECT COALESCE(sum(price*quantity),0)::bigint subtotal FROM order_items WHERE order_id=$1',
          [id],
        );
        if (b.discount > x.subtotal) throw new AppError(400, 'Скидка больше стоимости изделий');
      }
      const status = b.status ?? old.status;
      const closed = status === 'closed' ? old.closed_at || new Date() : null;
      const {
        rows: [o],
      } = await db.query(
        'UPDATE orders SET title=$2,due_date=$3,manager_id=$4,master_id=$5,notes=$6,status=$7,status_reason=$8,discount=$9,closed_at=$10,handed_over_at=$11,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',
        [
          id,
          b.title ?? old.title,
          b.due_date ?? old.due_date,
          b.manager_id === undefined ? old.manager_id : b.manager_id,
          b.master_id === undefined ? old.master_id : b.master_id,
          b.notes ?? old.notes,
          status,
          b.reason ?? old.status_reason,
          b.discount ?? old.discount,
          closed,
          b.handed_over ? new Date() : old.handed_over_at,
        ],
      );
      await audit(
        db,
        req.user.id,
        'order',
        id,
        'updated',
        { ...old, items: oldItems, total: oldTotal },
        {
          ...o,
          items: newItems ?? oldItems,
          total: (newItems ?? oldItems).reduce((s, i) => s + i.price * i.quantity, 0) - o.discount,
        },
      );
      return projectOrder(o, req.user.role);
    });
  });
  app.post('/orders/:id/payment-plans', async (req) => {
    requireRole(req, 'owner', 'manager', 'accountant');
    const id = uuid.parse((req.params as any).id);
    await accessibleOrder(req.user, id);
    const b = z
      .object({ title: z.string().min(1).max(200), amount: money.positive(), due_date: date })
      .parse(req.body);
    return transaction(async (db) => {
      const {
        rows: [p],
      } = await db.query(
        'INSERT INTO payment_plans(order_id,title,amount,due_date) VALUES($1,$2,$3,$4) RETURNING *',
        [id, b.title, b.amount, b.due_date],
      );
      await audit(db, req.user.id, 'order', id, 'payment_plan_added', null, p);
      return p;
    });
  });
  app.patch('/steps/:id', async (req) => {
    const id = uuid.parse((req.params as any).id);
    const b = z
      .object({
        status: z.enum(['new', 'doing', 'done', 'skipped']),
        comment: z.string().max(3000).default(''),
        version: z.number().int(),
        assignee_id: uuid.nullable().optional(),
        due_date: date.optional(),
      })
      .parse(req.body);
    return transaction(async (db) => {
      const {
        rows: [s],
      } = await db.query('SELECT * FROM production_steps WHERE id=$1 FOR UPDATE', [id]);
      if (!s) throw new AppError(404, 'Этап не найден');
      await accessibleOrder(req.user, s.order_id, db);
      requireRole(req, 'owner', 'manager', 'master');
      if (req.user.role === 'master' && s.assignee_id !== req.user.id)
        throw new AppError(403, 'Этот этап назначен другому сотруднику');
      if (req.user.role === 'master' && (b.assignee_id !== undefined || b.due_date !== undefined))
        throw new AppError(403, 'Назначать этапы может менеджер');
      if (s.version !== b.version) throw new AppError(409, 'Этап уже изменён. Обновите карточку');
      if (b.assignee_id) await validateAssignees(db, null, b.assignee_id);
      const {
        rows: [n],
      } = await db.query(
        'UPDATE production_steps SET status=$2,comment=$3,assignee_id=$4,due_date=$5,version=version+1 WHERE id=$1 RETURNING *',
        [
          id,
          b.status,
          b.comment,
          b.assignee_id === undefined ? s.assignee_id : b.assignee_id,
          b.due_date ?? s.due_date,
        ],
      );
      await audit(db, req.user.id, 'order', s.order_id, 'step_updated', s, n);
      return n;
    });
  });
  app.get('/orders/:id/history', async (req) => {
    const id = uuid.parse((req.params as any).id);
    await accessibleOrder(req.user, id);
    requireRole(req, 'owner', 'accountant');
    return (
      await pool.query(
        "SELECT a.*,u.name author_name FROM audit_events a LEFT JOIN users u ON u.id=a.author_id WHERE entity='order' AND entity_id=$1 ORDER BY created_at DESC LIMIT 200",
        [id],
      )
    ).rows;
  });
}
