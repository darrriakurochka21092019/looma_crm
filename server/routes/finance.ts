import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as XLSX from '@e965/xlsx';
import { AppError, audit, idempotent, pool, transaction, type DB } from '../db.js';
import {
  accessibleOrder,
  date,
  money,
  positiveMoney,
  projectOrder,
  requireFinance,
  uuid,
} from '../security.js';
import { canFinance, reserveFor } from '../../shared/domain.js';
export function localDay() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: process.env.COMPANY_TIMEZONE || 'Europe/Moscow',
  }).format(new Date());
}
export function periodDates(period: string) {
  const [y, m] = period.split('-').map(Number);
  return { from: `${period}-01`, until: new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10) };
}
export const periodSchema = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/);
export async function report(db: DB, period: string) {
  const { from, until } = periodDates(period);
  const {
    rows: [s],
  } = await db.query('SELECT data FROM settings WHERE id=1');
  const settings = s.data;
  const {
    rows: [cash],
  } = await db.query(
    `SELECT COALESCE(sum(CASE WHEN kind='receipt' THEN amount WHEN kind='refund' THEN -amount ELSE 0 END),0)::bigint receipts,COALESCE(sum(CASE WHEN kind='expense_payment' THEN amount ELSE 0 END),0)::bigint payouts FROM recorded_money_movements WHERE status='confirmed' AND occurred_on >= $1 AND occurred_on < $2`,
    [from, until],
  );
  const {
    rows: [profit],
  } = await db.query(
    `SELECT COALESCE(sum(total),0)::bigint revenue,COALESCE(sum(actual_cost),0)::bigint direct_cost,COALESCE(sum(gross_profit),0)::bigint gross_profit,count(*)::int closed_count FROM recorded_order_totals WHERE closed_at AT TIME ZONE $3 >= $1::date AND closed_at AT TIME ZONE $3 < $2::date AND status='closed'`,
    [from, until, settings.timezone],
  );
  const {
    rows: [overhead],
  } = await db.query(
    'SELECT COALESCE(sum(amount),0)::bigint overhead FROM expenses WHERE order_id IS NULL AND NOT tax_payment AND incurred_on >= $1 AND incurred_on < $2',
    [from, until],
  );
  const {
    rows: [all],
  } = await db.query(
    `SELECT COALESCE(sum(CASE WHEN kind='receipt' THEN amount ELSE -amount END),0)::bigint balance FROM recorded_money_movements WHERE status='confirmed' AND occurred_on < $1`,
    [until],
  );
  const {
    rows: [debt],
  } = await db.query(
    'SELECT COALESCE(sum(debt),0)::bigint debt,COALESCE(sum(overpayment),0)::bigint overpayment FROM recorded_order_totals WHERE NOT archived',
  );
  const management_profit = profit.gross_profit - overhead.overhead;
  const tax_base = Math.max(
    0,
    settings.tax_base === 'receipts' ? cash.receipts : management_profit,
  );
  const estimate = reserveFor(tax_base, settings.tax_rate_bps);
  const {
    rows: [stored],
  } = await db.query('SELECT * FROM current_tax_reservations WHERE period=$1', [period]);
  const tax_reserve = stored ? Math.max(0, stored.calculated_amount + stored.adjustment) : estimate;
  const {
    rows: [reserved],
  } = await db.query(
    "SELECT COALESCE(sum(GREATEST(0,calculated_amount+adjustment)),0)::bigint reserved FROM current_tax_reservations WHERE period <= $1 AND status='reserved'",
    [period],
  );
  const reserved_total = reserved.reserved + (stored ? 0 : estimate);
  const balance = all.balance + settings.opening_balance;
  return {
    period,
    ...cash,
    cashflow: cash.receipts - cash.payouts,
    ...profit,
    overhead: overhead.overhead,
    management_profit,
    ...debt,
    tax_base,
    tax_rate_bps: stored?.rate_bps ?? settings.tax_rate_bps,
    tax_reserve,
    tax_estimate: estimate,
    tax_current_rate_bps: settings.tax_rate_bps,
    tax_record: stored || null,
    reserved_total,
    balance,
    available: balance - reserved_total,
  };
}
export const movementSchema = z.object({
  amount: positiveMoney,
  occurred_on: date,
  method: z.string().min(1).max(100).default('Перевод'),
  account: z.string().min(1).max(100).default('Расчётный счёт'),
  status: z.enum(['draft', 'confirmed']).default('confirmed'),
  note: z.string().max(3000).default(''),
  idempotency_key: uuid,
});
async function checkMovement(
  db: DB,
  kind: string,
  orderId: string | null,
  expenseId: string | null,
  amount: number,
) {
  if (orderId) {
    await db.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
    if (kind === 'refund') {
      const {
        rows: [r],
      } = await db.query(
        "SELECT COALESCE(sum(CASE WHEN kind='receipt' THEN amount ELSE -amount END),0)::bigint net FROM money_movements WHERE order_id=$1 AND status='confirmed'",
        [orderId],
      );
      if (amount > r.net) throw new AppError(400, 'Возврат превышает фактически полученную сумму');
    }
  }
  if (expenseId) {
    const {
      rows: [e],
    } = await db.query('SELECT * FROM expenses WHERE id=$1 FOR UPDATE', [expenseId]);
    if (!e) throw new AppError(404, 'Расход не найден');
    const {
      rows: [p],
    } = await db.query(
      "SELECT COALESCE(sum(amount),0)::bigint paid FROM money_movements WHERE expense_id=$1 AND status='confirmed'",
      [expenseId],
    );
    if (amount > e.amount - p.paid)
      throw new AppError(400, 'Оплата превышает неоплаченный остаток расхода');
  }
}
export async function financeRoutes(app: FastifyInstance) {
  app.get('/dashboard', async (req) => {
    const q = z.object({ period: periodSchema.default(localDay().slice(0, 7)) }).parse(req.query);
    const isMaster = req.user.role === 'master';
    const params = isMaster ? [req.user.id] : [];
    const where = isMaster
      ? ' AND (master_id=$1 OR EXISTS(SELECT 1 FROM production_steps p WHERE p.order_id=recorded_order_totals.id AND p.assignee_id=$1))'
      : '';
    const orders = (
      await pool.query(
        `SELECT * FROM recorded_order_totals WHERE NOT archived AND status NOT IN ('closed','paused','cancelled') ${where} ORDER BY due_date LIMIT 6`,
        params,
      )
    ).rows;
    const counts = (
      await pool.query(
        `SELECT status,count(*)::int count FROM recorded_order_totals WHERE NOT archived ${where} GROUP BY status`,
        params,
      )
    ).rows;
    const tasks = (
      await pool.query(
        "SELECT t.*,u.name assignee_name,o.number order_number FROM tasks t JOIN users u ON u.id=t.assignee_id LEFT JOIN orders o ON o.id=t.order_id WHERE assignee_id=$1 AND t.status<>'done' AND (o.id IS NULL OR (NOT o.archived AND o.status NOT IN ('paused','cancelled'))) ORDER BY due_at LIMIT 5",
        [req.user.id],
      )
    ).rows;
    const warnings = orders
      .filter((o) => o.due_date < localDay())
      .map((o) => ({
        type: 'order',
        id: o.id,
        title: `${o.number} — срок готовности прошёл`,
        description: o.title,
      }));
    for (const t of tasks.filter((t) => new Date(t.due_at) < new Date()))
      warnings.push({ type: 'task', id: t.id, title: 'Просрочена задача', description: t.title });
    if (canFinance(req.user.role)) {
      for (const o of orders.filter((o) => o.debt > 0 && o.due_date <= localDay()))
        warnings.push({
          type: 'order',
          id: o.id,
          title: `${o.number} — ожидается доплата`,
          description: o.client_name,
        });
    }
    const tomorrow = new Date(Date.parse(localDay()) + 86400000).toISOString().slice(0, 10);
    for (const o of orders.filter((o) => o.due_date === tomorrow))
      warnings.push({
        type: 'order',
        id: o.id,
        title: `${o.number} — готовность завтра`,
        description: o.title,
      });
    const summary = canFinance(req.user.role)
      ? await transaction(async (db) => {
          await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
          return report(db, q.period);
        })
      : null;
    const { from, until } = periodDates(q.period);
    const chart = canFinance(req.user.role)
      ? (
          await pool.query(
            "SELECT occurred_on AS point_date,sum(CASE WHEN kind='receipt' THEN amount ELSE -amount END)::bigint amount FROM recorded_money_movements WHERE status='confirmed' AND kind IN ('receipt','refund') AND occurred_on >= $1 AND occurred_on < $2 GROUP BY occurred_on ORDER BY occurred_on",
            [from, until],
          )
        ).rows.map((r) => ({ day: r.point_date, amount: r.amount }))
      : [];
    return {
      summary,
      orders: orders.map((o) => projectOrder(o, req.user.role)),
      counts,
      tasks,
      warnings,
      chart,
      today: localDay(),
    };
  });
  app.get('/finance', async (req) => {
    requireFinance(req);
    const q = z
      .object({ period: periodSchema.default(localDay().slice(0, 7)), order_id: uuid.optional() })
      .parse(req.query);
    return transaction(async (db) => {
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const summary = await report(db, q.period);
      const { from, until } = periodDates(q.period);
      const movements = (
        await db.query(
          `SELECT m.*,o.number order_number,e.category expense_category,u.name author_name FROM ${q.order_id ? 'money_movements' : 'recorded_money_movements'} m LEFT JOIN expenses e ON e.id=m.expense_id LEFT JOIN orders o ON o.id=COALESCE(m.order_id,e.order_id) LEFT JOIN users u ON u.id=m.author_id WHERE ${q.order_id ? '(m.order_id=$1 OR e.order_id=$1)' : 'm.occurred_on >= $1 AND m.occurred_on < $2'} ORDER BY occurred_on DESC,m.created_at DESC LIMIT 1000`,
          q.order_id ? [q.order_id] : [from, until],
        )
      ).rows;
      const expenses = (
        await db.query(
          `SELECT e.*,o.number order_number,COALESCE(p.paid,0)::bigint paid,(e.amount-COALESCE(p.paid,0))::bigint outstanding FROM ${q.order_id ? 'expenses' : 'recorded_expenses'} e LEFT JOIN orders o ON o.id=e.order_id LEFT JOIN LATERAL (SELECT sum(amount) paid FROM money_movements WHERE expense_id=e.id AND status='confirmed') p ON true ${q.order_id ? 'WHERE e.order_id=$1' : ''} ORDER BY incurred_on DESC LIMIT 1000`,
          q.order_id ? [q.order_id] : [],
        )
      ).rows;
      const debts = (
        await db.query(
          'SELECT * FROM recorded_order_totals WHERE debt>0 AND NOT archived ORDER BY due_date LIMIT 1000',
        )
      ).rows.map((o) => projectOrder(o, req.user.role));
      const taxes = (
        await db.query('SELECT * FROM current_tax_reservations ORDER BY period DESC LIMIT 120')
      ).rows;
      return { summary, movements, expenses, debts, taxes };
    });
  });
  app.post('/orders/:id/payments', async (req) => {
    requireFinance(req);
    const id = uuid.parse((req.params as any).id);
    const b = movementSchema
      .extend({ kind: z.enum(['receipt', 'refund']).default('receipt') })
      .parse(req.body);
    return transaction((db) =>
      idempotent(db, b.idempotency_key, req.user.id, `payment:${id}`, b, async () => {
        await accessibleOrder(req.user, id, db, true);
        if (b.status === 'confirmed') await checkMovement(db, b.kind, id, null, b.amount);
        const {
          rows: [m],
        } = await db.query(
          'INSERT INTO money_movements(kind,order_id,amount,occurred_on,method,account,status,note,author_id,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
          [
            b.kind,
            id,
            b.amount,
            b.occurred_on,
            b.method,
            b.account,
            b.status,
            b.note,
            req.user.id,
            b.idempotency_key,
          ],
        );
        await audit(db, req.user.id, 'order', id, b.kind, null, m);
        return m;
      }),
    );
  });
  app.post('/expenses', async (req) => {
    requireFinance(req);
    const b = z
      .object({
        order_id: uuid.nullable().default(null),
        category: z.string().min(1).max(100),
        supplier: z.string().max(200).default(''),
        amount: positiveMoney,
        incurred_on: date,
        notes: z.string().max(3000).default(''),
        tax_payment: z.boolean().default(false),
        idempotency_key: uuid,
      })
      .parse(req.body);
    return transaction((db) =>
      idempotent(db, b.idempotency_key, req.user.id, 'expense', b, async () => {
        if (b.order_id) await accessibleOrder(req.user, b.order_id, db);
        if (b.tax_payment && b.order_id)
          throw new AppError(400, 'Налоговый платёж относится к компании');
        const {
          rows: [e],
        } = await db.query(
          'INSERT INTO expenses(order_id,category,supplier,amount,incurred_on,notes,tax_payment,author_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
          [
            b.order_id,
            b.category,
            b.supplier,
            b.amount,
            b.incurred_on,
            b.notes,
            b.tax_payment,
            req.user.id,
          ],
        );
        await audit(
          db,
          req.user.id,
          b.order_id ? 'order' : 'expense',
          b.order_id || e.id,
          'expense_created',
          null,
          e,
        );
        return e;
      }),
    );
  });
  app.patch('/expenses/:id', async (req) => {
    requireFinance(req);
    const id = uuid.parse((req.params as any).id);
    const b = z
      .object({
        version: z.number().int(),
        category: z.string().min(1).max(100),
        supplier: z.string().max(200),
        amount: positiveMoney,
        incurred_on: date,
        notes: z.string().max(3000),
      })
      .parse(req.body);
    return transaction(async (db) => {
      const {
        rows: [old],
      } = await db.query('SELECT * FROM expenses WHERE id=$1 FOR UPDATE', [id]);
      if (!old) throw new AppError(404, 'Расход не найден');
      if (old.version !== b.version) throw new AppError(409, 'Расход изменён другим сотрудником');
      const {
        rows: [p],
      } = await db.query(
        "SELECT COALESCE(sum(amount),0)::bigint paid FROM money_movements WHERE expense_id=$1 AND status='confirmed'",
        [id],
      );
      if (b.amount < p.paid) throw new AppError(400, 'Сумма расхода меньше уже проведённых оплат');
      if (
        (
          await db.query(
            'SELECT 1 FROM tax_reservations t JOIN money_movements m ON m.id=t.payment_id WHERE m.expense_id=$1',
            [id],
          )
        ).rowCount
      )
        throw new AppError(400, 'Расход связан с оплаченным налоговым резервом');
      const {
        rows: [e],
      } = await db.query(
        'UPDATE expenses SET category=$2,supplier=$3,amount=$4,incurred_on=$5,notes=$6,version=version+1 WHERE id=$1 RETURNING *',
        [id, b.category, b.supplier, b.amount, b.incurred_on, b.notes],
      );
      await audit(
        db,
        req.user.id,
        old.order_id ? 'order' : 'expense',
        old.order_id || id,
        'expense_updated',
        old,
        e,
      );
      return e;
    });
  });
  app.post('/expenses/:id/payments', async (req) => {
    requireFinance(req);
    const id = uuid.parse((req.params as any).id);
    const b = movementSchema.parse(req.body);
    return transaction((db) =>
      idempotent(db, b.idempotency_key, req.user.id, `expense_payment:${id}`, b, async () => {
        if (b.status === 'confirmed')
          await checkMovement(db, 'expense_payment', null, id, b.amount);
        else if (!(await db.query('SELECT 1 FROM expenses WHERE id=$1', [id])).rowCount)
          throw new AppError(404, 'Расход не найден');
        const {
          rows: [m],
        } = await db.query(
          "INSERT INTO money_movements(kind,expense_id,amount,occurred_on,method,account,status,note,author_id,idempotency_key) VALUES('expense_payment',$1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
          [
            id,
            b.amount,
            b.occurred_on,
            b.method,
            b.account,
            b.status,
            b.note,
            req.user.id,
            b.idempotency_key,
          ],
        );
        const {
          rows: [e],
        } = await db.query('SELECT order_id FROM expenses WHERE id=$1', [id]);
        await audit(
          db,
          req.user.id,
          e.order_id ? 'order' : 'expense',
          e.order_id || id,
          'expense_paid',
          null,
          m,
        );
        return m;
      }),
    );
  });
  app.post('/movements/:id/confirm', async (req) => {
    requireFinance(req);
    const id = uuid.parse((req.params as any).id);
    return transaction(async (db) => {
      const {
        rows: [m],
      } = await db.query('SELECT * FROM money_movements WHERE id=$1 FOR UPDATE', [id]);
      if (!m) throw new AppError(404, 'Операция не найдена');
      if (m.status === 'confirmed') return m;
      await checkMovement(db, m.kind, m.order_id, m.expense_id, m.amount);
      await db.query("UPDATE money_movements SET status='confirmed' WHERE id=$1", [id]);
      await audit(
        db,
        req.user.id,
        m.order_id ? 'order' : 'movement',
        m.order_id || id,
        'confirmed',
        m,
        { ...m, status: 'confirmed' },
      );
      return { ...m, status: 'confirmed' };
    });
  });
  app.post('/tax-reservations', async (req) => {
    requireFinance(req);
    const b = z
      .object({
        period: periodSchema,
        adjustment: z.number().int().min(-9e12).max(9e12).default(0),
        reason: z.string().max(2000).default(''),
        status: z.enum(['reserved', 'paid']).default('reserved'),
        payment_id: uuid.nullable().default(null),
      })
      .parse(req.body);
    return transaction(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(71630922)');
      const r = await report(db, b.period);
      if (b.adjustment && !b.reason.trim())
        throw new AppError(400, 'Укажите обоснование корректировки');
      if (r.tax_estimate + b.adjustment < 0)
        throw new AppError(400, 'Резерв не может быть отрицательным');
      if (b.status === 'paid') {
        if (!b.payment_id)
          throw new AppError(400, 'Выберите подтверждённую оплату налогового расхода');
        const {
          rows: [p],
        } = await db.query(
          "SELECT m.* FROM money_movements m JOIN expenses e ON e.id=m.expense_id WHERE m.id=$1 AND m.status='confirmed' AND e.tax_payment FOR UPDATE OF m",
          [b.payment_id],
        );
        if (!p || p.amount !== r.tax_estimate + b.adjustment)
          throw new AppError(400, 'Сумма оплаты налогового расхода должна совпадать с резервом');
      }
      const {
        rows: [record],
      } = await db.query(
        `INSERT INTO tax_reservations(period,base_amount,rate_bps,calculated_amount,adjustment,reason,status,payment_id,author_id,base_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(period) DO UPDATE SET base_type=EXCLUDED.base_type,base_amount=EXCLUDED.base_amount,rate_bps=EXCLUDED.rate_bps,calculated_amount=EXCLUDED.calculated_amount,adjustment=EXCLUDED.adjustment,reason=EXCLUDED.reason,status=EXCLUDED.status,payment_id=EXCLUDED.payment_id,author_id=EXCLUDED.author_id,created_at=now() RETURNING *`,
        [
          b.period,
          r.tax_base,
          r.tax_current_rate_bps,
          r.tax_estimate,
          b.adjustment,
          b.reason,
          b.status,
          b.status === 'paid' ? b.payment_id : null,
          req.user.id,
          (await db.query('SELECT data FROM settings WHERE id=1')).rows[0].data.tax_base,
        ],
      );
      await audit(db, req.user.id, 'tax', record.id, 'reserved', r.tax_record, record);
      return record;
    });
  });
  app.get('/reports/export', async (req, reply) => {
    requireFinance(req);
    const q = z.object({ period: periodSchema.default(localDay().slice(0, 7)) }).parse(req.query);
    const wb = await transaction(async (db) => {
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const r = await report(db, q.period);
      const orders = (
        await db.query(
          'SELECT number,client_name,title,total,actual_cost,gross_profit,paid,debt,due_date,status FROM recorded_order_totals WHERE NOT archived ORDER BY due_date',
        )
      ).rows;
      const movements = (
        await db.query(
          'SELECT kind,amount,occurred_on,status,method,account,note FROM recorded_money_movements WHERE occurred_on >= $1 AND occurred_on < $2 ORDER BY occurred_on',
          Object.values(periodDates(q.period)),
        )
      ).rows;
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(
        book,
        XLSX.utils.aoa_to_sheet([
          ['LOOMA.CRM', q.period],
          ['Показатель', 'Рубли'],
          ['Поступления', r.receipts / 100],
          ['Выплаты', r.payouts / 100],
          ['Денежный поток', r.cashflow / 100],
          ['Выручка закрытых заказов', r.revenue / 100],
          ['Прямые затраты закрытых заказов', r.direct_cost / 100],
          ['Общие расходы периода', r.overhead / 100],
          ['Управленческая прибыль до налогов', r.management_profit / 100],
          ['Оценочный налоговый резерв', r.tax_reserve / 100],
          ['Долги клиентов на текущий момент', r.debt / 100],
          ['Баланс на конец периода', r.balance / 100],
        ]),
        'Сводка',
      );
      XLSX.utils.book_append_sheet(
        book,
        XLSX.utils.json_to_sheet(
          orders.map((o) => ({
            Номер: o.number,
            Клиент: o.client_name,
            Заказ: o.title,
            Цена: o.total / 100,
            'Факт затрат': o.actual_cost / 100,
            'Валовая прибыль': o.gross_profit / 100,
            Получено: o.paid / 100,
            Долг: o.debt / 100,
            Срок: o.due_date,
            Статус: o.status,
          })),
        ),
        'Заказы на текущую дату',
      );
      XLSX.utils.book_append_sheet(
        book,
        XLSX.utils.json_to_sheet(movements.map((m) => ({ ...m, amount: m.amount / 100 }))),
        'Движение денег',
      );
      return book;
    });
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="LOOMA-report-${q.period}.xlsx"`);
    return reply.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  });
}
