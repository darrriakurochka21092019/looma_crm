export const roles = ['owner', 'manager', 'accountant', 'master'] as const;
export type Role = (typeof roles)[number];
export const roleLabels: Record<Role, string> = {
  owner: 'Владелец',
  manager: 'Менеджер',
  accountant: 'Бухгалтер',
  master: 'Мастер',
};
export const statuses = [
  'new',
  'calculation',
  'approval',
  'contract',
  'production',
  'ready',
  'closed',
  'paused',
  'cancelled',
] as const;
export type OrderStatus = (typeof statuses)[number];
export const statusLabels: Record<OrderStatus, string> = {
  new: 'Новая заявка',
  calculation: 'Расчёт',
  approval: 'Согласование',
  contract: 'Договор / предоплата',
  production: 'В производстве',
  ready: 'Готов к доставке',
  closed: 'Закрыт',
  paused: 'Приостановлен',
  cancelled: 'Отменён',
};
export const taskStatuses = {
  new: 'Новая',
  doing: 'В работе',
  waiting: 'Ожидает',
  done: 'Выполнена',
} as const;
export const stepLabels = [
  'Подготовка материалов',
  'Каркас',
  'Раскрой',
  'Пошив / обивка',
  'Сборка',
  'Контроль качества',
  'Доставка',
];
export const categories = [
  'Материалы',
  'Ткань',
  'Фурнитура',
  'Работа мастера',
  'Доставка',
  'Аренда',
  'Реклама',
  'Связь',
  'Другое',
];
export const documentCategories = {
  contract: 'Договор',
  appendix: 'Приложение',
  sketch: 'Эскиз',
  receipt: 'Чек',
  act: 'Акт',
  photo: 'Фото',
  proposal: 'Коммерческое предложение',
  invoice: 'Товарная накладная',
  other: 'Прочее',
} as const;
export type User = { id: string; name: string; email: string; role: Role; active: boolean };
export type Client = {
  id: string;
  type: 'person' | 'company';
  name: string;
  phone: string;
  email: string;
  address: string;
  details: string;
  source: string;
  notes: string;
  consent_basis: string;
  document_details?: import('./document-generation.js').DocumentParty;
  version: number;
  created_at: string;
};
export type Item = {
  id?: string;
  kind: string;
  model: string;
  quantity: number;
  dimensions: string;
  fabric: string;
  color: string;
  filling: string;
  mechanism: string;
  notes: string;
  price?: number;
  planned_cost?: number;
  photo_document_id?: string | null;
  photo?: { id: string; name: string; version: number } | null;
};
export type Order = {
  id: string;
  number: string;
  client_id: string;
  client_name: string;
  client_phone: string;
  client_address?: string;
  title: string;
  status: OrderStatus;
  due_date: string;
  manager_id: string | null;
  manager_name: string;
  master_id: string | null;
  master_name: string;
  notes: string;
  version: number;
  closed_at: string | null;
  created_at: string;
  discount?: number;
  total?: number;
  planned_cost?: number;
  actual_cost?: number;
  paid?: number;
  debt?: number;
  overpayment?: number;
  gross_profit?: number;
  margin?: number;
  items?: Item[];
};
export type Expense = {
  id: string;
  order_id: string | null;
  order_number?: string;
  category: string;
  supplier: string;
  amount: number;
  paid: number;
  outstanding: number;
  incurred_on: string;
  notes: string;
  tax_payment: boolean;
};
export type Movement = {
  id: string;
  kind: 'receipt' | 'refund' | 'expense_payment';
  order_id: string | null;
  order_number: string | null;
  expense_id: string | null;
  amount: number;
  occurred_on: string;
  status: 'draft' | 'confirmed';
  method: string;
  account: string;
  note: string;
};
export type Task = {
  id: string;
  title: string;
  description: string;
  order_id: string | null;
  order_number: string | null;
  assignee_id: string;
  assignee_name: string;
  due_at: string;
  status: keyof typeof taskStatuses;
  priority: 'low' | 'normal' | 'high';
  version: number;
};
export type DocumentRecord = {
  id: string;
  order_id: string;
  order_number: string;
  client_name: string;
  category: keyof typeof documentCategories;
  visibility: 'commercial' | 'financial' | 'technical';
  name: string;
  version: number;
  size: number;
  created_at: string;
  author_name: string;
  versions?: { version: number; created_at: string; name: string; size: number }[];
};
export function canFinance(role: Role) {
  return role === 'owner' || role === 'manager' || role === 'accountant';
}
/** UI amounts arrive as decimal RUB strings. All domain arithmetic uses integer kopecks. */
export function rublesToCents(value: string): number {
  const s = value.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error('Введите сумму с точностью до копеек');
  const [whole, fraction = ''] = s.split('.');
  const n = Number(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')));
  if (!Number.isSafeInteger(n) || n > 9_000_000_000_000) throw new Error('Сумма слишком большая');
  return n;
}
export function reserveFor(base: number, rateBps: number): number {
  return Number((BigInt(Math.max(0, base)) * BigInt(rateBps) + 5000n) / 10000n);
}
export function orderFinance(subtotal: number, discount: number, cost: number, paid: number) {
  const total = subtotal - discount,
    gross_profit = total - cost;
  return {
    total,
    actual_cost: cost,
    paid,
    debt: Math.max(0, total - paid),
    overpayment: Math.max(0, paid - total),
    gross_profit,
    margin: total > 0 ? Math.round((gross_profit / total) * 10000) / 100 : 0,
  };
}
