import React, { useEffect, useState } from 'react';
import { Plus, Trash2, Upload, Loader2, Check, MessageCircle, Paperclip } from 'lucide-react';
import { post, patch, upload, api, money, decimal, day, key } from './api';
import {
  canFinance,
  roleLabels,
  roleLabels as labels,
  statusLabels,
  statuses,
  documentCategories,
  categories,
  rublesToCents,
  type Item,
  type User,
  type Client,
  type Order,
} from '../../shared/domain';
import { useApp, useLoad, LoadState } from './main';
type Props = { data: any; onSaved: (s?: string) => void };
export function useSubmit() {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function submit(fn: () => Promise<any>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e: any) {
      setError(e.message || 'Не удалось сохранить. Повторите попытку.');
    } finally {
      setBusy(false);
    }
  }
  return { error, busy, submit };
}
export function FormFooter({
  busy,
  error,
  label = 'Сохранить',
}: {
  busy: boolean;
  error: string;
  label?: string;
}) {
  return (
    <>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="form-actions">
        <button className="btn primary" disabled={busy} type="submit">
          {busy ? <Loader2 className="spin" size={16} /> : <Check size={16} />}{' '}
          {busy ? 'Сохраняем…' : label}
        </button>
      </div>
    </>
  );
}
function Field({
  label,
  value,
  onChange,
  required = false,
  type = 'text',
  placeholder = '',
  disabled = false,
}: {
  label: string;
  value: string | number;
  onChange: (s: string) => void;
  required?: boolean;
  type?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <label>
      {label}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        placeholder={placeholder}
        disabled={disabled}
      />
    </label>
  );
}
function OrderSelect({
  value,
  onChange,
  optional = false,
}: {
  value: string;
  onChange: (v: string) => void;
  optional?: boolean;
}) {
  const { data } = useLoad<any>('/orders?limit=200&sort=newest');
  const { data: selected } = useLoad<Order>(
    value && !data?.items.some((o: Order) => o.id === value) ? '/orders/' + value : null,
  );
  return (
    <label>
      Заказ
      <select value={value} onChange={(e) => onChange(e.target.value)} required={!optional}>
        <option value="">{optional ? 'Без заказа' : 'Выберите заказ'}</option>
        {selected && !data?.items.some((o: Order) => o.id === selected.id) && (
          <option value={selected.id}>
            {selected.number} · {selected.title}
          </option>
        )}
        {data?.items.map((o: Order) => (
          <option key={o.id} value={o.id}>
            {o.number} · {o.client_name} · {o.title}
          </option>
        ))}
      </select>
    </label>
  );
}
export function ClientForm({ data, onSaved }: Props) {
  const [v, setV] = useState({
    type: 'person',
    name: '',
    phone: '',
    email: '',
    address: '',
    details: '',
    source: '',
    notes: '',
    consent_basis: '',
    ...data,
  });
  const { error, busy, submit } = useSubmit();
  const set = (k: string, s: string) => setV((o: any) => ({ ...o, [k]: s }));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit(async () => {
          if (data.id) await patch('/clients/' + data.id, v);
          else await post('/clients', v);
          onSaved(data.id ? 'Клиент обновлён' : 'Клиент добавлен');
        });
      }}
    >
      <div className="form-grid">
        <label>
          Тип клиента
          <select value={v.type} onChange={(e) => set('type', e.target.value)}>
            <option value="person">Частное лицо</option>
            <option value="company">Организация</option>
          </select>
        </label>
        <Field label="ФИО / название" value={v.name} onChange={(s) => set('name', s)} required />
        <Field
          label="Телефон"
          type="tel"
          value={v.phone}
          onChange={(s) => set('phone', s)}
          required
          placeholder="+7 900 000-00-00"
        />
        <Field label="Email" type="email" value={v.email} onChange={(s) => set('email', s)} />
        <Field label="Адрес доставки" value={v.address} onChange={(s) => set('address', s)} />
        <Field label="Откуда узнал о вас" value={v.source} onChange={(s) => set('source', s)} />
      </div>
      {v.type === 'company' && (
        <label>
          Реквизиты
          <textarea value={v.details} onChange={(e) => set('details', e.target.value)} />
        </label>
      )}
      <label>
        Примечание
        <textarea value={v.notes} onChange={(e) => set('notes', e.target.value)} />
      </label>
      <Field
        label="Основание обработки контактных данных"
        value={v.consent_basis}
        onChange={(s) => set('consent_basis', s)}
        placeholder="Например: заключение и исполнение договора"
      />
      <FormFooter busy={busy} error={error} />
    </form>
  );
}
const blankItem = () => ({
  kind: 'Диван',
  model: '',
  quantity: 1,
  dimensions: '',
  fabric: '',
  color: '',
  filling: '',
  mechanism: '',
  notes: '',
  price_text: '',
  cost_text: '',
});
export function OrderForm({ data, onSaved }: Props) {
  const { user, users } = useApp();
  const { data: clients } = useLoad<Client[]>('/clients?limit=200');
  const [v, setV] = useState({
    client_id: data.client_id || '',
    title: data.title || '',
    due_date: data.due_date || '',
    manager_id: data.manager_id || user.id,
    master_id: data.master_id || '',
    notes: data.notes || '',
    discount_text: decimal(data.discount || 0),
  });
  const [items, setItems] = useState<any[]>(
    data.items
      ? data.items.map((i: any) => ({
          ...i,
          price_text: decimal(i.price),
          cost_text: decimal(i.planned_cost),
        }))
      : [blankItem()],
  );
  const [idem] = useState(key);
  const { error, busy, submit } = useSubmit();
  const set = (k: string, s: string) => setV((o) => ({ ...o, [k]: s }));
  const setItem = (idx: number, k: string, s: string) =>
    setItems((a) =>
      a.map((i, n) => (n === idx ? { ...i, [k]: k === 'quantity' ? Number(s) : s } : i)),
    );
  let total = 0;
  try {
    total =
      items.reduce((n, i) => n + rublesToCents(i.price_text || '0') * i.quantity, 0) -
      rublesToCents(v.discount_text || '0');
  } catch {}
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit(async () => {
          const prepared = items.map(({ price_text, cost_text, ...i }) => ({
            ...i,
            price: rublesToCents(price_text),
            ...(canFinance(user.role) ? { planned_cost: rublesToCents(cost_text || '0') } : {}),
          }));
          const payload = {
            ...v,
            manager_id: v.manager_id || null,
            master_id: v.master_id || null,
            discount: rublesToCents(v.discount_text || '0'),
            items: prepared,
          };
          if (data.id) await patch('/orders/' + data.id, { ...payload, version: data.version });
          else await post('/orders', { ...payload, idempotency_key: idem });
          onSaved(data.id ? 'Заказ обновлён' : 'Заказ создан');
        });
      }}
    >
      <div className="form-grid">
        <label>
          Клиент
          <select
            value={v.client_id}
            required
            disabled={!!data.id}
            onChange={(e) => set('client_id', e.target.value)}
          >
            <option value="">Выберите клиента</option>
            {clients?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · +{c.phone}
              </option>
            ))}
          </select>
        </label>
        <Field
          label="Название заказа"
          value={v.title}
          onChange={(s) => set('title', s)}
          required
          placeholder="Например: Диван «Луна»"
        />
        <Field
          label="Обещанная дата готовности"
          type="date"
          value={v.due_date}
          onChange={(s) => set('due_date', s)}
          required
        />
        <label>
          Менеджер
          <select value={v.manager_id} onChange={(e) => set('manager_id', e.target.value)}>
            {users
              .filter((u) => ['owner', 'manager'].includes(u.role) && u.active)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Мастер
          <select value={v.master_id} onChange={(e) => set('master_id', e.target.value)}>
            <option value="">Пока не назначен</option>
            {users
              .filter((u) => ['owner', 'master'].includes(u.role) && u.active)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
          </select>
        </label>
        <Field
          label="Скидка на заказ, ₽"
          value={v.discount_text}
          onChange={(s) => set('discount_text', s)}
        />
      </div>
      <div className="form-section-heading">
        <h3>Изделия в заказе</h3>
        {(!data.id || ['owner', 'manager'].includes(user.role)) && (
          <button
            className="btn small"
            type="button"
            onClick={() => setItems((a) => [...a, blankItem()])}
          >
            <Plus size={15} /> Изделие
          </button>
        )}
      </div>
      {items.map((i, idx) => (
        <div className="item-form" key={idx}>
          <div className="item-form-heading">
            <b>Изделие {idx + 1}</b>
            {items.length > 1 && (!data.id || ['owner', 'manager'].includes(user.role)) && (
              <button
                type="button"
                className="icon-btn"
                onClick={() => setItems((a) => a.filter((_, n) => n !== idx))}
                aria-label="Удалить изделие"
              >
                <Trash2 size={16} />
              </button>
            )}
          </div>
          <div className="form-grid three">
            <label>
              Тип
              <select value={i.kind} onChange={(e) => setItem(idx, 'kind', e.target.value)}>
                {['Диван', 'Кровать', 'Кресло', 'Пуф', 'Иное'].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <Field
              label="Модель"
              required
              value={i.model}
              onChange={(s) => setItem(idx, 'model', s)}
            />
            <Field
              label="Количество"
              type="number"
              value={i.quantity}
              onChange={(s) => setItem(idx, 'quantity', s)}
              required
            />
            <Field
              label="Размеры, Д × Ш × В, см"
              value={i.dimensions}
              onChange={(s) => setItem(idx, 'dimensions', s)}
            />
            <Field
              label="Ткань и артикул"
              value={i.fabric}
              onChange={(s) => setItem(idx, 'fabric', s)}
            />
            <Field label="Цвет" value={i.color} onChange={(s) => setItem(idx, 'color', s)} />
            <Field
              label="Наполнение"
              value={i.filling}
              onChange={(s) => setItem(idx, 'filling', s)}
            />
            <Field
              label="Механизм"
              value={i.mechanism}
              onChange={(s) => setItem(idx, 'mechanism', s)}
            />
            <Field
              label="Цена за единицу, ₽"
              required
              value={i.price_text}
              onChange={(s) => setItem(idx, 'price_text', s)}
            />
            {canFinance(user.role) && (
              <Field
                label="План затрат за единицу, ₽"
                value={i.cost_text}
                onChange={(s) => setItem(idx, 'cost_text', s)}
              />
            )}
          </div>
          <Field
            label="Технические примечания"
            value={i.notes}
            onChange={(s) => setItem(idx, 'notes', s)}
          />
        </div>
      ))}
      <label>
        Примечания к заказу
        <textarea value={v.notes} onChange={(e) => set('notes', e.target.value)} />
      </label>
      {v.due_date && v.due_date < day() && (
        <div className="callout warning">
          Дата готовности уже прошла. Заказ будет отмечен как просроченный.
        </div>
      )}
      <div className="form-total">
        <span>Стоимость заказа</span>
        <b>{money(total)}</b>
      </div>
      <FormFooter
        busy={busy}
        error={error}
        label={data.id ? 'Сохранить изменения' : 'Создать заказ'}
      />
    </form>
  );
}
export function PaymentForm({ data, expense, onSaved }: Props & { expense: boolean }) {
  const [v, setV] = useState({
    order_id: data.order_id || '',
    kind: 'receipt',
    amount: expense ? decimal(data.outstanding) : '',
    occurred_on: day(),
    method: 'Перевод',
    account: 'Расчётный счёт',
    status: 'confirmed',
    note: '',
  });
  const [selectedOrder, setSelectedOrder] = useState<any>(data.order || null);
  useEffect(() => {
    let active = true;
    if (!expense && v.order_id)
      api('/orders/' + v.order_id)
        .then((o) => {
          if (active) setSelectedOrder(o);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [v.order_id, expense]);
  const [idem] = useState(key);
  const { error, busy, submit } = useSubmit();
  const set = (k: string, s: string) => setV((o) => ({ ...o, [k]: s }));
  let amount = 0;
  try {
    amount = rublesToCents(v.amount);
  } catch {}
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit(async () => {
          const payload = { ...v, amount: rublesToCents(v.amount), idempotency_key: idem };
          await post(
            expense ? '/expenses/' + data.id + '/payments' : '/orders/' + v.order_id + '/payments',
            payload,
          );
          onSaved(
            expense
              ? 'Оплата расхода проведена'
              : v.kind === 'refund'
                ? 'Возврат проведён'
                : 'Платёж сохранён',
          );
        });
      }}
    >
      {expense ? (
        <div className="callout">
          {data.category} · {data.supplier || 'Без поставщика'}
          <br />
          Не оплачено: <b>{money(data.outstanding)}</b>
        </div>
      ) : (
        <>
          <OrderSelect value={v.order_id} onChange={(s) => set('order_id', s)} />
          <label>
            Вид операции
            <select value={v.kind} onChange={(e) => set('kind', e.target.value)}>
              <option value="receipt">Поступление от клиента</option>
              <option value="refund">Возврат клиенту</option>
            </select>
          </label>
        </>
      )}
      <div className="form-grid">
        <Field label="Сумма, ₽" value={v.amount} onChange={(s) => set('amount', s)} required />
        <Field
          label="Дата операции"
          type="date"
          value={v.occurred_on}
          onChange={(s) => set('occurred_on', s)}
          required
        />
        <label>
          Способ
          <select value={v.method} onChange={(e) => set('method', e.target.value)}>
            {['Перевод', 'Наличные', 'Карта', 'Иное'].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Счёт / касса
          <select value={v.account} onChange={(e) => set('account', e.target.value)}>
            {['Расчётный счёт', 'Касса', 'Иной счёт'].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
      </div>
      <label>
        Статус
        <select value={v.status} onChange={(e) => set('status', e.target.value)}>
          <option value="confirmed">Подтверждён — учесть в итогах</option>
          <option value="draft">Черновик — не учитывать</option>
        </select>
      </label>
      <label>
        Комментарий
        <textarea value={v.note} onChange={(e) => set('note', e.target.value)} />
      </label>
      {!expense &&
        v.kind === 'receipt' &&
        selectedOrder?.debt !== undefined &&
        amount > selectedOrder.debt && (
          <div className="callout warning">
            Оплата превышает долг на {money(amount - selectedOrder.debt)}. Система сохранит
            переплату отдельно.
          </div>
        )}
      <FormFooter busy={busy} error={error} label="Сохранить операцию" />
    </form>
  );
}
export function ExpenseForm({ data, onSaved }: Props) {
  const [v, setV] = useState({
    order_id: data.order_id || '',
    category: data.category || 'Материалы',
    supplier: data.supplier || '',
    amount: data.amount ? decimal(data.amount) : '',
    incurred_on: data.incurred_on || day(),
    notes: data.notes || '',
    tax_payment: data.tax_payment || false,
  });
  const [idem] = useState(key);
  const { error, busy, submit } = useSubmit();
  const set = (k: string, s: string | boolean) => setV((o) => ({ ...o, [k]: s }));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit(async () => {
          if (data.id)
            await patch('/expenses/' + data.id, {
              ...v,
              amount: rublesToCents(v.amount),
              version: data.version,
            });
          else
            await post('/expenses', {
              ...v,
              order_id: v.order_id || null,
              amount: rublesToCents(v.amount),
              idempotency_key: idem,
            });
          onSaved(
            data.id
              ? 'Расход обновлён'
              : 'Расход учтён. Оплата добавляется отдельно в журнале расходов.',
          );
        });
      }}
    >
      {!data.id && <OrderSelect value={v.order_id} onChange={(s) => set('order_id', s)} optional />}
      <div className="form-grid">
        <label>
          Категория
          <select value={v.category} onChange={(e) => set('category', e.target.value)}>
            {categories.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <Field
          label="Поставщик / получатель"
          value={v.supplier}
          onChange={(s) => set('supplier', s)}
        />
        <Field
          label="Сумма расхода, ₽"
          value={v.amount}
          required
          onChange={(s) => set('amount', s)}
        />
        <Field
          label="Дата возникновения расхода"
          type="date"
          value={v.incurred_on}
          required
          onChange={(s) => set('incurred_on', s)}
        />
      </div>
      {!v.order_id && !data.id && (
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={v.tax_payment}
            onChange={(e) => set('tax_payment', e.target.checked)}
          />{' '}
          Это налоговый расход (не включать в прибыль до налогов)
        </label>
      )}
      <label>
        Комментарий
        <textarea value={v.notes} onChange={(e) => set('notes', e.target.value)} />
      </label>
      <div className="inline-note">
        Расход попадёт в затраты сейчас. Когда оплатите его — добавьте оплату, чтобы изменился
        денежный поток.
      </div>
      <FormFooter busy={busy} error={error} />
    </form>
  );
}
export function TaskForm({ data, onSaved }: Props) {
  const { users, user } = useApp();
  const [kind, setKind] = useState(data.order_id ? 'order' : 'standalone');
  const [v, setV] = useState({
    title: data.title || '',
    description: data.description || '',
    order_id: data.order_id || '',
    assignee_id: data.assignee_id || user.id,
    due_at: data.due_at
      ? new Date(
          new Date(data.due_at).getTime() - new Date(data.due_at).getTimezoneOffset() * 60000,
        )
          .toISOString()
          .slice(0, 16)
      : day() + 'T18:00',
    priority: data.priority || 'normal',
  });
  const { error, busy, submit } = useSubmit();
  const set = (k: string, s: string) => setV((o) => ({ ...o, [k]: s }));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit(async () => {
          if (kind === 'order' && !v.order_id) throw new Error('Выберите заказ');
          const payload = {
            ...v,
            order_id: kind === 'order' ? v.order_id || null : null,
            due_at: new Date(v.due_at).toISOString(),
          };
          if (data.id) await patch('/tasks/' + data.id, { ...payload, version: data.version });
          else await post('/tasks', payload);
          onSaved(data.id ? 'Задача обновлена' : 'Задача создана');
        });
      }}
    >
      <Field label="Что нужно сделать" value={v.title} onChange={(s) => set('title', s)} required />
      <label>
        Описание
        <textarea value={v.description} onChange={(e) => set('description', e.target.value)} />
      </label>
      <div className="segmented task-kind" aria-label="Тип задачи">
        <button
          type="button"
          className={kind === 'standalone' ? 'active' : ''}
          onClick={() => setKind('standalone')}
        >
          Отдельная задача
        </button>
        <button
          type="button"
          className={kind === 'order' ? 'active' : ''}
          onClick={() => setKind('order')}
        >
          По заказу
        </button>
      </div>
      {kind === 'order' && <OrderSelect value={v.order_id} onChange={(s) => set('order_id', s)} />}
      <div className="form-grid">
        <label>
          Исполнитель
          <select value={v.assignee_id} onChange={(e) => set('assignee_id', e.target.value)}>
            {users
              .filter(
                (u) => u.active && (['owner', 'manager'].includes(user.role) || u.id === user.id),
              )
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} · {roleLabels[u.role]}
                </option>
              ))}
          </select>
        </label>
        <Field
          label="Срок (по времени вашего устройства)"
          type="datetime-local"
          value={v.due_at}
          required
          onChange={(s) => set('due_at', s)}
        />
        <label>
          Приоритет
          <select value={v.priority} onChange={(e) => set('priority', e.target.value)}>
            <option value="low">Низкий</option>
            <option value="normal">Обычный</option>
            <option value="high">Высокий</option>
          </select>
        </label>
      </div>
      <FormFooter
        busy={busy}
        error={error}
        label={data.id ? 'Сохранить задачу' : 'Создать задачу'}
      />
    </form>
  );
}
export function DocumentForm({ data, onSaved }: Props) {
  const { user } = useApp();
  const [v, setV] = useState({
    order_id: data.order_id || '',
    category: data.category || 'contract',
    visibility:
      data.visibility ||
      (user.role === 'accountant'
        ? 'financial'
        : user.role === 'master'
          ? 'technical'
          : 'commercial'),
    comment: '',
  });
  const [files, setFiles] = useState<File[]>([]);
  const [selectionError, setSelectionError] = useState('');
  const addFiles = (incoming: File[]) => {
    const unique = [...files, ...incoming].filter(
      (f, i, all) =>
        all.findIndex(
          (other) =>
            other.name === f.name && other.size === f.size && other.lastModified === f.lastModified,
        ) === i,
    );
    const next = data.document_id ? incoming : unique;
    if (next.length > (data.document_id ? 1 : 10)) {
      setSelectionError(
        data.document_id
          ? 'Для новой версии выберите один файл'
          : 'За один раз можно загрузить до 10 файлов',
      );
      return;
    }
    if (
      next.some((f) => f.size > 25 * 1024 * 1024) ||
      next.reduce((n, f) => n + f.size, 0) > 100 * 1024 * 1024
    ) {
      setSelectionError('До 25 МБ на файл и до 100 МБ на всю загрузку');
      return;
    }
    setSelectionError('');
    setFiles(next);
  };
  const { error, busy, submit } = useSubmit();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit(async () => {
          if (!files.length) throw new Error('Выберите файлы');
          if (selectionError) throw new Error(selectionError);
          const q = new URLSearchParams({
            ...v,
            ...(data.document_id
              ? { document_id: data.document_id, version: String(data.version) }
              : {}),
          });
          await upload('/documents?' + q, files);
          onSaved(
            data.document_id ? 'Новая версия сохранена' : `Прикреплено файлов: ${files.length}`,
          );
        });
      }}
    >
      <OrderSelect value={v.order_id} onChange={(s) => setV((o) => ({ ...o, order_id: s }))} />
      <div className="form-grid">
        <label>
          Категория
          <select
            disabled={!!data.document_id}
            value={v.category}
            onChange={(e) => setV((o) => ({ ...o, category: e.target.value }))}
          >
            {Object.entries(documentCategories).map(([k, l]) => (
              <option value={k} key={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          Кому доступен
          <select
            disabled={!!data.document_id}
            value={v.visibility}
            onChange={(e) => setV((o) => ({ ...o, visibility: e.target.value }))}
          >
            {[
              ['commercial', 'Коммерческие документы'],
              ['technical', 'Технические документы'],
              ['financial', 'Финансовые документы'],
            ]
              .filter(
                ([k]) =>
                  ['owner', 'manager'].includes(user.role) ||
                  (user.role === 'master' && k === 'technical') ||
                  (user.role === 'accountant' && k === 'financial'),
              )
              .map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
          </select>
        </label>
      </div>
      <label
        className="drop-zone"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          addFiles(Array.from(e.dataTransfer.files));
        }}
      >
        <Upload size={28} />
        <b>
          {data.document_id ? 'Выберите новую версию файла' : 'Выберите файлы или перетащите сюда'}
        </b>
        <span>PDF, JPG, PNG, DOCX, XLSX, XLS · до 25 МБ на файл</span>
        {!data.document_id && <span>До 10 файлов за раз · всего до 100 МБ</span>}
        <input
          type="file"
          multiple={!data.document_id}
          aria-label="Файлы документов"
          accept=".pdf,.jpg,.jpeg,.png,.docx,.xlsx,.xls"
          onChange={(e) => {
            addFiles(Array.from(e.target.files || []));
            e.target.value = '';
          }}
        />
      </label>
      {selectionError && (
        <div className="callout error" role="alert">
          {selectionError}
        </div>
      )}
      {files.length > 0 && (
        <ul className="upload-file-list">
          {files.map((file, i) => (
            <li key={i}>
              <Paperclip size={15} />
              <span>
                {file.name}
                <small>{(file.size / 1024).toFixed(0)} КБ</small>
              </span>
              <button
                type="button"
                className="icon-btn"
                aria-label={'Убрать ' + file.name}
                onClick={() => {
                  setFiles(files.filter((_, n) => n !== i));
                  setSelectionError('');
                }}
              >
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <label>
        Комментарий
        <textarea
          value={v.comment}
          onChange={(e) => setV((o) => ({ ...o, comment: e.target.value }))}
        />
      </label>
      {data.document_id && (
        <div className="inline-note">
          Будет создана версия {data.version + 1}. Предыдущая останется в истории версий.
        </div>
      )}
      <FormFooter busy={busy} error={error} label="Загрузить" />
    </form>
  );
}
export function StatusForm({ data, onSaved }: Props) {
  const { user } = useApp();
  const [status, setStatus] = useState(data.status),
    [reason, setReason] = useState(''),
    [handed, setHanded] = useState(false);
  const { error, busy, submit } = useSubmit();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit(async () => {
          await patch('/orders/' + data.id, {
            version: data.version,
            status,
            reason,
            handed_over: handed,
          });
          onSaved('Статус заказа изменён');
        });
      }}
    >
      <label>
        Статус заказа
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {statuses.map((s) => (
            <option value={s} key={s}>
              {statusLabels[s]}
            </option>
          ))}
        </select>
      </label>
      {['paused', 'cancelled'].includes(status) && (
        <label>
          Причина
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} required />
        </label>
      )}
      {status === 'closed' && (
        <>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={handed}
              onChange={(e) => setHanded(e.target.checked)}
              required
            />{' '}
            Изделие передано клиенту
          </label>
          <div className="callout">
            Закрытие заказа не означает полную оплату. Неоплаченный остаток останется в
            задолженности.
          </div>
        </>
      )}
      <FormFooter busy={busy} error={error} />
    </form>
  );
}
export function StepForm({ data, onSaved }: Props) {
  const { user, users } = useApp();
  const [v, setV] = useState({
    status: data.status,
    comment: data.comment,
    assignee_id: data.assignee_id || '',
    due_date: data.due_date || '',
  });
  const { error, busy, submit } = useSubmit();
  const canAssign = ['owner', 'manager'].includes(user.role);
  const allowed = canAssign || (user.role === 'master' && data.assignee_id === user.id);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit(async () => {
          await patch('/steps/' + data.id, {
            status: v.status,
            comment: v.comment,
            version: data.version,
            ...(canAssign
              ? {
                  assignee_id: v.assignee_id || null,
                  ...(v.due_date ? { due_date: v.due_date } : {}),
                }
              : {}),
          });
          onSaved('Этап обновлён');
        });
      }}
    >
      <h3>{data.name}</h3>
      <label>
        Статус
        <select
          value={v.status}
          disabled={!allowed}
          onChange={(e) => setV((o) => ({ ...o, status: e.target.value }))}
        >
          {[
            ['new', 'Ожидает'],
            ['doing', 'В работе'],
            ['done', 'Готово'],
            ['skipped', 'Пропущен'],
          ].map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
      </label>
      {canAssign && (
        <div className="form-grid">
          <label>
            Исполнитель
            <select
              value={v.assignee_id}
              onChange={(e) => setV((o) => ({ ...o, assignee_id: e.target.value }))}
            >
              <option value="">Не назначен</option>
              {users
                .filter((u) => u.active && ['owner', 'master'].includes(u.role))
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
            </select>
          </label>
          <Field
            label="Срок"
            type="date"
            value={v.due_date}
            onChange={(s) => setV((o) => ({ ...o, due_date: s }))}
          />
        </div>
      )}
      <label>
        Комментарий
        <textarea
          disabled={!allowed}
          value={v.comment}
          onChange={(e) => setV((o) => ({ ...o, comment: e.target.value }))}
        />
      </label>
      {allowed ? (
        <FormFooter busy={busy} error={error} />
      ) : (
        <p className="muted">Изменять этот этап может назначенный исполнитель или менеджер.</p>
      )}
    </form>
  );
}
export function ContractForm({ data, onSaved }: Props) {
  const [terms, setTerms] = useState(''),
    [date, setDate] = useState(day());
  const { error, busy, submit } = useSubmit();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit(async () => {
          await post('/orders/' + data.id + '/contract', {
            payment_terms: terms,
            contract_date: date,
          });
          onSaved('Договор сформирован и сохранён в документах заказа');
        });
      }}
    >
      <div className="callout">
        Договор будет сформирован из утверждённого владельцем шаблона DOCX. В него попадут клиент,
        изделия, стоимость и срок заказа.
      </div>
      <Field label="Дата договора" type="date" value={date} onChange={setDate} required />
      <label>
        Условия оплаты
        <textarea
          value={terms}
          onChange={(e) => setTerms(e.target.value)}
          required
          placeholder="Например: 50% предоплата, 50% до доставки"
        />
      </label>
      <FormFooter busy={busy} error={error} label="Сформировать DOCX" />
    </form>
  );
}
export function PlanForm({ data, onSaved }: Props) {
  const [v, setV] = useState({ title: 'Предоплата', amount: '', due_date: day() });
  const { error, busy, submit } = useSubmit();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit(async () => {
          await post('/orders/' + data.id + '/payment-plans', {
            ...v,
            amount: rublesToCents(v.amount),
          });
          onSaved('План платежа добавлен');
        });
      }}
    >
      <Field
        label="Название платежа"
        value={v.title}
        required
        onChange={(s) => setV((o) => ({ ...o, title: s }))}
      />
      <Field
        label="Сумма, ₽"
        value={v.amount}
        required
        onChange={(s) => setV((o) => ({ ...o, amount: s }))}
      />
      <Field
        label="Плановая дата"
        type="date"
        value={v.due_date}
        required
        onChange={(s) => setV((o) => ({ ...o, due_date: s }))}
      />
      <div className="inline-note">Плановый платёж не означает поступление денег.</div>
      <FormFooter busy={busy} error={error} />
    </form>
  );
}
export function TaxForm({ data, onSaved }: Props) {
  const r = data.summary.tax_record;
  const [v, setV] = useState({
    adjustment: decimal(r?.adjustment || 0),
    reason: r?.reason || '',
    status: r?.status || 'reserved',
    payment_id: r?.payment_id || '',
  });
  const { error, busy, submit } = useSubmit();
  const payments = data.movements.filter(
    (m: any) =>
      m.kind === 'expense_payment' &&
      m.status === 'confirmed' &&
      data.expenses.some((e: any) => e.id === m.expense_id && e.tax_payment),
  );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit(async () => {
          const sign = v.adjustment.trim().startsWith('-') ? -1 : 1;
          const adjustment = sign * rublesToCents(v.adjustment.replace(/^[+-]/, ''));
          await post('/tax-reservations', {
            period: data.period,
            ...v,
            adjustment,
            payment_id: v.payment_id || null,
          });
          onSaved('Налоговый резерв сохранён');
        });
      }}
    >
      <div className="callout">
        Период {data.period}. Расчёт по текущим операциям: <b>{money(data.summary.tax_estimate)}</b>
        . Сохранение повторно пересчитает резерв.
      </div>
      <Field
        label="Ручная корректировка, ₽ (можно со знаком минус)"
        value={v.adjustment}
        onChange={(s) => setV((o) => ({ ...o, adjustment: s }))}
      />
      <label>
        Обоснование корректировки
        <textarea
          value={v.reason}
          onChange={(e) => setV((o) => ({ ...o, reason: e.target.value }))}
        />
      </label>
      <label>
        Статус
        <select value={v.status} onChange={(e) => setV((o) => ({ ...o, status: e.target.value }))}>
          <option value="reserved">Отложено</option>
          <option value="paid">Фактически оплачено</option>
        </select>
      </label>
      {v.status === 'paid' && (
        <label>
          Оплата налогового расхода
          <select
            value={v.payment_id}
            required
            onChange={(e) => setV((o) => ({ ...o, payment_id: e.target.value }))}
          >
            <option value="">Выберите оплату на сумму резерва</option>
            {payments.map((m: any) => (
              <option key={m.id} value={m.id}>
                {m.occurred_on} · {money(m.amount)}
              </option>
            ))}
          </select>
        </label>
      )}
      <FormFooter busy={busy} error={error} />
    </form>
  );
}
export function CommentsForm({ data, onSaved }: Props) {
  const { open, user } = useApp();
  const {
    data: comments,
    error: loadError,
    setData,
  } = useLoad<any[]>('/tasks/' + data.id + '/comments');
  const [text, setText] = useState('');
  const { error, busy, submit } = useSubmit();
  return (
    <>
      <div className="comment-task">
        <h3>{data.title}</h3>
        {['owner', 'manager'].includes(user.role) && (
          <button className="text-btn" onClick={() => open('task', data)}>
            Изменить задачу
          </button>
        )}
        <p>{data.description}</p>
        <span className="muted">
          {data.assignee_name} · {new Date(data.due_at).toLocaleString('ru-RU')}
        </span>
      </div>
      <div className="comments-list">
        {comments ? (
          comments.length ? (
            comments.map((c) => (
              <div className="comment" key={c.id}>
                <b>{c.author_name}</b>
                <small>{new Date(c.created_at).toLocaleString('ru-RU')}</small>
                <p>{c.text}</p>
              </div>
            ))
          ) : (
            <p className="muted">Комментариев пока нет.</p>
          )
        ) : (
          <LoadState error={loadError} />
        )}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(async () => {
            await post('/tasks/' + data.id + '/comments', { text });
            setText('');
            setData(await api('/tasks/' + data.id + '/comments'));
          });
        }}
      >
        <label>
          Комментарий
          <textarea value={text} onChange={(e) => setText(e.target.value)} required />
        </label>
        <FormFooter busy={busy} error={error} label="Добавить комментарий" />
      </form>
      {data.order_id && (
        <button
          className="text-btn"
          onClick={() =>
            open('document', {
              order_id: data.order_id,
              category: 'other',
              visibility: 'technical',
            })
          }
        >
          <Paperclip size={15} /> Прикрепить файл к заказу этой задачи
        </button>
      )}
    </>
  );
}
