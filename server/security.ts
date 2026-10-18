import type { FastifyRequest } from 'fastify';
import { AppError, pool, type DB } from './db.js';
import { canFinance, type User, type Role } from '../shared/domain.js';
import { z } from 'zod';
declare module 'fastify' {
  interface FastifyRequest {
    user: User;
  }
}
export const uuid = z.string().uuid();
export const money = z.number().int().min(0).max(9_000_000_000_000);
export const positiveMoney = money.positive();
export const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s,
    'Некорректная дата',
  );
export const text = z.string().trim().max(10000);
export function requireRole(req: FastifyRequest, ...roles: Role[]) {
  if (!roles.includes(req.user.role)) throw new AppError(403, 'Нет доступа');
}
export function requireFinance(req: FastifyRequest) {
  if (!canFinance(req.user.role))
    throw new AppError(403, 'Финансовые данные доступны владельцу, менеджеру и бухгалтеру');
}
export async function accessibleOrder(user: User, id: string, db: DB = pool, lock = false) {
  uuid.parse(id);
  const {
    rows: [o],
  } = await db.query(`SELECT * FROM orders WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
  if (!o) throw new AppError(404, 'Заказ не найден');
  if (
    user.role === 'master' &&
    o.master_id !== user.id &&
    !(
      await db.query('SELECT 1 FROM production_steps WHERE order_id=$1 AND assignee_id=$2', [
        id,
        user.id,
      ])
    ).rowCount
  )
    throw new AppError(403, 'Нет доступа к этому заказу');
  return o;
}
export function projectOrder(o: Record<string, any>, role: Role) {
  const general = [
    'id',
    'number',
    'client_id',
    'client_name',
    'client_phone',
    'client_address',
    'title',
    'status',
    'due_date',
    'manager_id',
    'manager_name',
    'master_id',
    'master_name',
    'notes',
    'version',
    'closed_at',
    'created_at',
    'updated_at',
    'handed_over_at',
    'status_reason',
  ];
  const allowed =
    role === 'master'
      ? general
      : canFinance(role)
        ? [
            ...general,
            'discount',
            'total',
            'planned_cost',
            'actual_cost',
            'paid',
            'debt',
            'overpayment',
            'gross_profit',
          ]
        : [...general, 'discount', 'total'];
  return {
    ...Object.fromEntries(allowed.map((k) => [k, o[k]])),
    ...(canFinance(role) && typeof o.total === 'number'
      ? { margin: o.total > 0 ? Math.round((o.gross_profit / o.total) * 10000) / 100 : 0 }
      : {}),
  };
}
export function projectItem(i: Record<string, any>, role: Role) {
  const x = { ...i };
  if (!canFinance(role)) delete x.planned_cost;
  if (role === 'master') delete x.price;
  return x;
}
