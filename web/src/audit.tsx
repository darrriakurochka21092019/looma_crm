import React from 'react';
import { money, dateLabel } from './api';
import { statusLabels, taskStatuses, documentCategories } from '../../shared/domain';
export function auditActionLabel(action: string) {
  return (
    (
      {
        created: 'Создана запись',
        updated: 'Изменена запись',
        receipt: 'Получен платёж',
        refund: 'Оформлен возврат',
        expense_created: 'Учтён расход',
        expense_updated: 'Уточнён расход',
        expense_paid: 'Оплачен расход',
        step_updated: 'Обновлён этап',
        document_uploaded: 'Загружен документ',
        task_created: 'Создана задача',
        task_updated: 'Изменена задача',
        payment_plan_added: 'Добавлен план платежа',
        contract_generated: 'Сформирован договор',
        login: 'Вход в систему',
        password_changed: 'Изменён пароль',
        permissions_changed: 'Изменены права доступа',
        invitation_accepted: 'Принято приглашение',
        owner_initialized: 'Создан кабинет владельца',
        contract_template_uploaded: 'Обновлён шаблон договора',
        confirmed: 'Подтверждена операция',
        reserved: 'Сохранён налоговый резерв',
        comment_added: 'Добавлен комментарий',
      } as Record<string, string>
    )[action] || 'Обновлена запись'
  );
}
export function entityLabel(entity: string) {
  return (
    (
      {
        order: 'Заказ',
        client: 'Клиент',
        task: 'Задача',
        expense: 'Расход',
        movement: 'Денежная операция',
        user: 'Сотрудник',
        invitation: 'Приглашение',
        settings: 'Настройки',
        tax: 'Налоговый резерв',
        import: 'Импорт',
      } as Record<string, string>
    )[entity] || 'Рабочее пространство'
  );
}
const labels: Record<string, string> = {
  number: 'Номер',
  title: 'Название',
  name: 'Название',
  status: 'Статус',
  due_date: 'Срок',
  discount: 'Скидка',
  total: 'Стоимость',
  amount: 'Сумма',
  category: 'Категория',
  supplier: 'Поставщик',
  incurred_on: 'Дата расхода',
  occurred_on: 'Дата оплаты',
  note: 'Примечание',
  notes: 'Примечание',
  comment: 'Комментарий',
  version: 'Версия',
  visibility: 'Доступ',
  method: 'Способ оплаты',
  account: 'Счёт / касса',
  handed_over_at: 'Дата передачи',
  closed_at: 'Дата закрытия',
  items: 'Изделия',
  priority: 'Приоритет',
  due_at: 'Срок задачи',
  role: 'Роль',
  active: 'Доступ активен',
  reason: 'Причина',
};
function display(key: string, value: any) {
  if (value === null || value === undefined || value === '') return '—';
  if (['discount', 'total', 'amount'].includes(key)) return money(value);
  if (
    ['due_date', 'incurred_on', 'occurred_on', 'handed_over_at', 'closed_at', 'due_at'].includes(
      key,
    )
  )
    return dateLabel(value);
  if (key === 'status')
    return (
      (
        {
          ...statusLabels,
          ...taskStatuses,
          reserved: 'Отложено',
          paid: 'Фактически оплачен',
          confirmed: 'Подтверждён',
          draft: 'Черновик',
          skipped: 'Пропущен',
        } as Record<string, string>
      )[value] || String(value)
    );
  if (key === 'category')
    return (documentCategories as Record<string, string>)[value] || String(value);
  if (key === 'visibility')
    return (
      {
        commercial: 'Коммерческие документы',
        technical: 'Технические документы',
        financial: 'Финансовые документы',
      } as any
    )[value];
  if (key === 'priority')
    return ({ high: 'Высокий', normal: 'Обычный', low: 'Низкий' } as any)[value];
  if (key === 'role')
    return (
      { owner: 'Владелец', manager: 'Менеджер', accountant: 'Бухгалтер', master: 'Мастер' } as any
    )[value];
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  if (key === 'items' && Array.isArray(value))
    return value
      .map((i) => `${i.model} · ${i.quantity} шт. · ${money(i.price)} за единицу`)
      .join('\n');
  return String(value);
}
export function AuditValues({ value }: { value: any }) {
  const entries = value ? Object.entries(value).filter(([k]) => labels[k]) : [];
  return entries.length ? (
    <dl className="audit-values">
      {entries.map(([k, v]) => (
        <React.Fragment key={k}>
          <dt>{labels[k]}</dt>
          <dd>{display(k, v)}</dd>
        </React.Fragment>
      ))}
    </dl>
  ) : (
    <p className="muted">Нет предыдущих значений</p>
  );
}
