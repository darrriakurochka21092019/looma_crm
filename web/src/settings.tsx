import { auditActionLabel, entityLabel } from './audit';
import React, { useState } from 'react';
import { DocumentPartyFields } from './document-party';
import {
  Check,
  Copy,
  Download,
  FileText,
  Plus,
  ShieldCheck,
  Upload,
  Users,
  ChevronRight,
  ArrowRight,
  Database,
  Loader2,
} from 'lucide-react';
import { useApp, useLoad, LoadState, Empty } from './main';
import { FormFooter, useSubmit } from './forms';
import { api, post, patch, upload, decimal, money, dateLabel } from './api';
import { roleLabels, type User } from '../../shared/domain';
export function SettingsPage() {
  const { data, error } = useLoad<any>('/settings');
  const [tab, setTab] = useState('company');
  if (!data) return <LoadState error={error} />;
  return (
    <div className="settings-layout">
      <div className="settings-menu">
        {[
          ['company', 'Компания и расчёты'],
          ['team', 'Сотрудники и роли'],
          ['max', 'Уведомления в MAX'],
          ['template', 'Шаблон договора'],
          ['import', 'Импорт из Excel'],
          ['backup', 'Резервное копирование'],
          ['audit', 'Журнал действий'],
        ].map(([s, l]) => (
          <button
            data-help-tab={'settings:' + s}
            key={s}
            className={tab === s ? 'active' : ''}
            onClick={() => setTab(s)}
          >
            {l}
            <ChevronRight size={16} />
          </button>
        ))}
      </div>
      <section className="card settings-content" data-help="settings-content">
        {tab === 'company' && <CompanySettings initial={data} />}{' '}
        {tab === 'team' && <TeamSettings />}
        {tab === 'max' && <MaxSettings />}
        {tab === 'template' && <TemplateSettings settings={data} />}{' '}
        {tab === 'import' && <ImportPage />}
        {tab === 'backup' && <BackupInfo />}
        {tab === 'audit' && <AuditSettings />}
      </section>
    </div>
  );
}
function MaxSettings() {
  const { data, error } = useLoad<any>('/settings/max');
  const { notify, refresh } = useApp();
  const [contacts, setContacts] = useState<{ id: string; name: string }[]>([]);
  const [working, setWorking] = useState(false);
  const [connectionError, setConnectionError] = useState('');
  const check = async (discover = false) => {
    setWorking(true);
    setConnectionError('');
    try {
      const result = await post('/settings/max/' + (discover ? 'discover' : 'check'), {});
      if (discover) {
        setContacts(result.contacts);
        if (!result.contacts.length)
          setConnectionError(
            'Новых пользователей не найдено. Откройте бота в MAX, нажмите «Начать» или отправьте ему сообщение, затем повторите поиск.',
          );
        else notify('Пользователи найдены. Выберите их напротив сотрудников.');
      } else notify('Бот отвечает: ' + result.name);
    } catch (err: any) {
      setConnectionError(err.message);
    } finally {
      setWorking(false);
    }
  };
  if (!data) return <LoadState error={error} />;
  const deliveryLabels: Record<string, string> = {
    pending: 'В очереди',
    sending: 'Отправляется',
    sent: 'Доставлено в MAX',
    cancelled: 'Неактуально',
    failed: 'Ошибка',
  };
  return (
    <div className="max-settings">
      <h2>Уведомления о задачах в MAX</h2>
      <p className="muted">
        Исполнитель получает назначения, изменения и завершение задач, напоминание перед сроком и
        уведомление о просрочке. Для заказов в архиве уведомления отключены.
      </p>
      <MaxConfigForm key={data.version} data={data} />
      <div className="max-actions">
        <button className="btn" disabled={!data.configured || working} onClick={() => check()}>
          Проверить бота
        </button>
        <button className="btn" disabled={!data.configured || working} onClick={() => check(true)}>
          Найти ID сотрудников
        </button>
      </div>
      <details className="max-help">
        <summary>Как подключить MAX</summary>
        <ol>
          <li>Создайте бота через «MAX для бизнеса» и скопируйте его токен из настроек бота.</li>
          <li>Вставьте токен в поле выше, включите уведомления и нажмите «Сохранить MAX».</li>
          <li>Каждый сотрудник должен открыть этого бота в MAX и нажать «Начать».</li>
          <li>
            Нажмите «Найти ID сотрудников», выберите пользователя напротив нужного сотрудника и
            сохраните привязку. Можно ввести известный числовой ID вручную.
          </li>
        </ol>
        <p>
          Поиск ID предназначен для локального запуска и выполняется только по нажатию кнопки. Если
          бот уже использует Webhook в другом приложении, введите ID вручную. Для отправки сообщений
          публичный домен не требуется.
        </p>
      </details>
      <p className="inline-note">
        Уведомления отправляются, пока запущен сервер CRM и есть интернет. После сна компьютера
        очередь продолжит работу.
      </p>
      {connectionError && (
        <div className="callout error" role="alert">
          {connectionError}
        </div>
      )}
      <h3>Получатели</h3>
      <p className="muted">Привязку выполняет владелец. У каждого сотрудника — свой ID MAX.</p>
      <div className="max-recipients" data-help="max-recipients">
        {data.recipients.map((recipient: any) => (
          <MaxRecipient
            key={recipient.id + ':' + recipient.version}
            recipient={recipient}
            contacts={contacts}
          />
        ))}
      </div>
      <div className="card-heading">
        <h3>Последние уведомления</h3>
        <div className="max-actions">
          <button className="btn small" onClick={refresh}>
            Обновить
          </button>
          <button
            className="btn small"
            onClick={async () => {
              try {
                await post('/settings/max/retry', {});
                refresh();
                notify('Повторная отправка запланирована');
              } catch (err: any) {
                notify(err.message);
              }
            }}
          >
            Повторить ошибки
          </button>
        </div>
      </div>
      {data.deliveries.length ? (
        <div className="max-deliveries">
          {data.deliveries.map((n: any) => (
            <div key={n.id}>
              <b>{n.title}</b>
              <small>
                {n.assignee_name} · {deliveryLabels[n.status]} ·{' '}
                {dateLabel(n.sent_at || n.created_at)}
              </small>
              {n.error && <p className="overdue">{n.error}</p>}
            </div>
          ))}
        </div>
      ) : (
        <Empty
          title="Уведомлений пока нет"
          text="После подключения получателей создайте или измените задачу."
        />
      )}
    </div>
  );
}
function MaxConfigForm({ data }: { data: any }) {
  const { refresh, notify } = useApp();
  const [enabled, setEnabled] = useState(data.enabled),
    [token, setToken] = useState(''),
    [minutes, setMinutes] = useState(String(data.reminder_minutes));
  const { busy, error, submit } = useSubmit();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit(async () => {
          await patch('/settings/max', {
            version: data.version,
            enabled,
            reminder_minutes: Number(minutes),
            ...(token.trim() ? { token: token.trim() } : {}),
          });
          setToken('');
          refresh();
          notify('Настройки MAX сохранены');
        });
      }}
    >
      <label>
        Токен бота
        <input
          type="password"
          value={token}
          autoComplete="new-password"
          placeholder={
            data.configured
              ? 'Токен сохранён. Оставьте пустым, чтобы сохранить его'
              : 'Вставьте токен бота MAX'
          }
          onChange={(e) => setToken(e.target.value)}
        />
      </label>
      <label>
        Напомнить за сколько минут до срока
        <input
          type="number"
          min="1"
          max="1440"
          required
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
        />
      </label>
      <label className="checkbox-label">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Отправлять уведомления о задачах
      </label>
      <FormFooter busy={busy} error={error} label="Сохранить MAX" />
    </form>
  );
}
function MaxRecipient({
  recipient: r,
  contacts,
}: {
  recipient: any;
  contacts: { id: string; name: string }[];
}) {
  const { refresh, notify } = useApp();
  const [id, setId] = useState(r.max_user_id || ''),
    [enabled, setEnabled] = useState(r.enabled ?? true);
  const { busy, error, submit } = useSubmit();
  return (
    <form
      className="max-recipient"
      onSubmit={(e) => {
        e.preventDefault();
        submit(async () => {
          await patch('/settings/max/recipients/' + r.id, {
            max_user_id: id.trim(),
            enabled,
            version: r.version,
          });
          refresh();
          notify('Получатель MAX сохранён');
        });
      }}
    >
      <div>
        <b>{r.name}</b>
        <small>
          {roleLabels[r.role as User['role']]}
          {!r.active && ' · отключён'}
        </small>
      </div>
      <label>
        ID в MAX
        <input
          inputMode="numeric"
          value={id}
          onChange={(e) => setId(e.target.value)}
          required
          aria-label={'ID MAX: ' + r.name}
          placeholder="Числовой ID"
        />
      </label>
      {contacts.length > 0 && (
        <label>
          Найденные пользователи
          <select value="" onChange={(e) => setId(e.target.value)}>
            <option value="">Выберите человека</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.id}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="checkbox-label">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Получать уведомления
      </label>
      <FormFooter busy={busy} error={error} label="Сохранить привязку" />
    </form>
  );
}
function CompanySettings({ initial }: { initial: any }) {
  const { refresh, notify } = useApp();
  const [v, setV] = useState({
    ...initial.data,
    version: initial.version,
    rate_text: String(initial.data.tax_rate_bps / 100),
    balance_text: decimal(initial.data.opening_balance),
    steps_text: initial.data.step_names.join('\n'),
  });
  const { error, busy, submit } = useSubmit();
  const set = (k: string, s: any) => setV((o: any) => ({ ...o, [k]: s }));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit(async () => {
          const balanceText = v.balance_text.trim().replace(',', '.');
          if (!/^-?\d+(\.\d{1,2})?$/.test(balanceText))
            throw new Error('Некорректный начальный остаток');
          const updated = await patch('/settings', {
            ...v,
            tax_rate_bps: Math.round(Number(v.rate_text.replace(',', '.')) * 100),
            opening_balance: Math.round(Number(balanceText) * 100),
            max_file_mb: Number(v.max_file_mb),
            storage_quota_mb: Number(v.storage_quota_mb),
            step_names: v.steps_text
              .split('\n')
              .map((s: string) => s.trim())
              .filter(Boolean),
          });
          set('version', updated.version);
          refresh();
          notify('Настройки сохранены');
        });
      }}
    >
      <h2>Компания и расчёты</h2>
      <p className="muted">Правила применяются ко всему рабочему пространству.</p>
      <div className="form-grid">
        <label>
          Название компании
          <input
            value={v.company_name}
            onChange={(e) => set('company_name', e.target.value)}
            required
          />
        </label>
        <label>
          Часовой пояс
          <input value={v.timezone} disabled />
        </label>
      </div>
      <label>
        Реквизиты компании
        <textarea
          value={v.legal_details}
          onChange={(e) => set('legal_details', e.target.value)}
          placeholder="Название, ИНН, адрес, банковские реквизиты"
        />
      </label>
      <DocumentPartyFields
        title="Реквизиты исполнителя для автозаполнения документов"
        value={v.document_company || {}}
        onChange={(value) => set('document_company', value)}
      />
      <h3>Налоговый резерв</h3>
      <div className="form-grid">
        <label>
          Режим (справочно)
          <input value={v.tax_regime} onChange={(e) => set('tax_regime', e.target.value)} />
        </label>
        <label>
          Правило резерва
          <select value={v.tax_base} onChange={(e) => set('tax_base', e.target.value)}>
            <option value="receipts">Процент от поступлений минус возвраты</option>
            <option value="management_profit">
              Процент от положительной управленческой прибыли
            </option>
          </select>
        </label>
        <label>
          Ставка резервирования, %
          <input
            inputMode="decimal"
            value={v.rate_text}
            onChange={(e) => set('rate_text', e.target.value)}
            required
          />
        </label>
        <label>
          Начальный остаток денег, ₽
          <input value={v.balance_text} onChange={(e) => set('balance_text', e.target.value)} />
        </label>
      </div>
      <p className="muted">
        Это внутренний резерв. Он не заменяет расчёт налога с учётом НДС, взносов и льгот.
      </p>
      <p className="inline-note">
        Менеджер имеет доступ ко всем рабочим разделам. Настройки доступны только владельцу.
      </p>
      <h3>Производственные этапы</h3>
      <label>
        По одному этапу на строку · для новых заказов
        <textarea
          rows={7}
          value={v.steps_text}
          onChange={(e) => set('steps_text', e.target.value)}
          required
        />
      </label>
      <h3>Документы</h3>
      <div className="form-grid">
        <label>
          Размер одного файла, МБ (до 25)
          <input
            type="number"
            min={1}
            max={25}
            value={v.max_file_mb}
            onChange={(e) => set('max_file_mb', e.target.value)}
          />
        </label>
        <label>
          Квота документов, МБ
          <input
            type="number"
            min={50}
            max={100000}
            value={v.storage_quota_mb}
            onChange={(e) => set('storage_quota_mb', e.target.value)}
          />
        </label>
      </div>
      <FormFooter busy={busy} error={error} />
    </form>
  );
}
function TeamSettings() {
  const { users, refresh, notify, user } = useApp();
  const [invite, setInvite] = useState({ name: '', email: '', role: 'manager' }),
    [link, setLink] = useState('');
  const { error, busy, submit } = useSubmit();
  return (
    <>
      <div className="card-heading">
        <h2>Сотрудники и роли</h2>
        <Users size={21} />
      </div>
      <div className="team-list">
        {users.map((u) => (
          <div className="team-row" key={u.id}>
            <span className="avatar">{u.name[0]}</span>
            <span>
              <b>{u.name}</b>
              <small>{u.email}</small>
            </span>
            {u.id === user.id ? (
              <span className="chip">Владелец · вы</span>
            ) : (
              <>
                <select
                  aria-label={'Роль ' + u.name}
                  value={u.role}
                  onChange={async (e) => {
                    try {
                      await patch('/users/' + u.id, { role: e.target.value, active: u.active });
                      refresh();
                      notify('Права сотрудника обновлены');
                    } catch (e: any) {
                      notify(e.message);
                    }
                  }}
                >
                  {Object.entries(roleLabels).map(([s, l]) => (
                    <option value={s} key={s}>
                      {l}
                    </option>
                  ))}
                </select>
                <button
                  className={'btn small ' + (!u.active ? 'success' : '')}
                  onClick={async () => {
                    try {
                      await patch('/users/' + u.id, { role: u.role, active: !u.active });
                      refresh();
                      notify('Доступ сотрудника изменён');
                    } catch (e: any) {
                      notify(e.message);
                    }
                  }}
                >
                  {u.active ? 'Отключить' : 'Включить'}
                </button>
              </>
            )}
          </div>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(async () => {
            const r = await post('/users/invite', invite);
            setLink(r.link);
          });
        }}
      >
        <h3 data-help="team-invite">Пригласить сотрудника</h3>
        <div className="form-grid">
          <label>
            Имя
            <input
              required
              value={invite.name}
              onChange={(e) => setInvite((o) => ({ ...o, name: e.target.value }))}
            />
          </label>
          <label>
            Email
            <input
              type="email"
              required
              value={invite.email}
              onChange={(e) => setInvite((o) => ({ ...o, email: e.target.value }))}
            />
          </label>
          <label>
            Роль
            <select
              value={invite.role}
              onChange={(e) => setInvite((o) => ({ ...o, role: e.target.value }))}
            >
              <option value="manager">Менеджер</option>
              <option value="accountant">Бухгалтер</option>
              <option value="master">Мастер</option>
            </select>
          </label>
        </div>
        <FormFooter busy={busy} error={error} label="Создать приглашение" />
      </form>
      {link && (
        <div className="invitation-result">
          <b>Приглашение готово · действует 48 часов</b>
          <p>
            Передайте ссылку сотруднику. Для доступа с другого компьютера в настройках сервера
            должен быть указан адрес, доступный в вашей сети.
          </p>
          <input readOnly value={link} onClick={(e) => e.currentTarget.select()} />
          <button
            className="btn"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(link);
                notify('Ссылка скопирована');
              } catch {
                notify('Выделите ссылку и скопируйте её');
              }
            }}
          >
            <Copy size={15} /> Копировать ссылку
          </button>
        </div>
      )}
    </>
  );
}
function TemplateSettings({ settings }: { settings: any }) {
  const { notify, refresh } = useApp();
  const [approved, setApproved] = useState(settings.data.contract_approved);
  const { error, busy, submit } = useSubmit();
  return (
    <>
      <h2>Шаблон договора</h2>
      <p className="muted">
        Загрузите свой DOCX и утвердите его. После загрузки новой версии утверждение сбрасывается.
      </p>
      <div className="template-state">
        <FileText size={32} />
        <div>
          <b>{settings.data.contract_template ? 'Шаблон загружен' : 'Шаблон ещё не выбран'}</b>
          <p>
            {settings.data.contract_approved
              ? 'Утверждён · доступен для формирования договоров'
              : 'Ожидает утверждения владельцем'}
          </p>
        </div>
        {settings.data.contract_template && (
          <a className="btn" href="/api/settings/contract-template">
            <Download size={16} /> Скачать
          </a>
        )}
      </div>
      <label className="drop-zone">
        <Upload size={25} />
        <b>Загрузить DOCX</b>
        <span>Редактируемый шаблон с полями подстановки</span>
        <input
          type="file"
          accept=".docx"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f)
              submit(async () => {
                await upload('/settings/contract-template', f);
                setApproved(false);
                refresh();
                notify('Шаблон загружен. Проверьте его и утвердите.');
              });
          }}
        />
      </label>
      <h3>Поля подстановки</h3>
      <div className="template-tags">
        {[
          'company_name',
          'legal_details',
          'client_name',
          'client_phone',
          'client_address',
          'client_details',
          'order_number',
          'contract_date',
          'order_title',
          'items',
          'total',
          'due_date',
          'payment_terms',
        ].map((s) => (
          <code key={s}>{'{' + s + '}'}</code>
        ))}
      </div>
      <p className="muted">
        Образец структуры файла: docs/contract-template.docx в проекте. Замените текст условий на
        утверждённый вами.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(async () => {
            const current = await api('/settings');
            await patch('/settings', {
              ...current.data,
              version: current.version,
              contract_approved: approved,
            });
            refresh();
            notify('Статус шаблона сохранён');
          });
        }}
      >
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={approved}
            onChange={(e) => setApproved(e.target.checked)}
          />{' '}
          Шаблон проверен и утверждён для использования
        </label>
        <FormFooter busy={busy} error={error} label="Сохранить утверждение" />
      </form>
    </>
  );
}
export function ImportPage({ onSaved }: { onSaved?: (s?: string) => void }) {
  const { notify, refresh } = useApp();
  const [kind, setKind] = useState('clients'),
    [job, setJob] = useState<any>(null),
    [preview, setPreview] = useState<any>(null),
    [result, setResult] = useState<any>(null);
  const { error, busy, submit } = useSubmit();
  return (
    <>
      <h2>Импорт из Excel</h2>
      <p className="muted">
        Выберите файл, сопоставьте колонки и проверьте строки до записи в базу.
      </p>
      <div className="import-steps">
        <span className={job ? 'done' : 'active'}>1. Файл</span>
        <i />
        <span className={preview ? 'done' : job ? 'active' : ''}>2. Сопоставление</span>
        <i />
        <span className={result ? 'done' : preview ? 'active' : ''}>3. Проверка</span>
      </div>
      {!job ? (
        <>
          <label>
            Что импортируем
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="clients">Клиенты</option>
              <option value="orders">Заказы и прямые затраты</option>
              <option value="expenses">Расходы</option>
            </select>
          </label>
          <label className="drop-zone">
            <Upload size={28} />
            <b>{busy ? 'Читаем таблицу…' : 'Выберите Excel .xlsx или .xls'}</b>
            <span>До 10 МБ и 10 000 строк. Заголовки — в первой строке.</span>
            <input
              type="file"
              accept=".xls,.xlsx"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) submit(async () => setJob(await upload('/imports/inspect?kind=' + kind, f)));
              }}
            />
          </label>
        </>
      ) : !result ? (
        <>
          <label>
            Лист
            <select
              value={job.sheet}
              onChange={async (e) => {
                const sheet = e.target.value;
                setPreview(null);
                submit(async () => {
                  const r = await api(
                    '/imports/' + job.id + '/sheet?sheet=' + encodeURIComponent(sheet),
                  );
                  setJob({ ...job, ...r });
                });
              }}
            >
              {job.sheets.map((s: string) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          {job.already_imported && (
            <div className="callout warning">
              Этот файл уже импортировался. Повторное подтверждение будет отклонено.
            </div>
          )}
          <div className="mapping-grid">
            {Object.entries(job.fields).map(([field, label]) => (
              <label key={field}>
                {String(label)}
                <select
                  value={job.mapping[field] || ''}
                  onChange={(e) => {
                    setJob({ ...job, mapping: { ...job.mapping, [field]: e.target.value } });
                    setPreview(null);
                  }}
                >
                  <option value="">Не импортировать</option>
                  {job.headers.map((h: string) => (
                    <option key={h}>{h}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <button
            className="btn primary"
            disabled={busy}
            onClick={() =>
              submit(async () =>
                setPreview(
                  await post('/imports/preview', {
                    id: job.id,
                    sheet: job.sheet,
                    mapping: job.mapping,
                  }),
                ),
              )
            }
          >
            {busy ? <Loader2 className="spin" size={16} /> : <Check size={16} />} Проверить строки
          </button>
          {preview && (
            <div className="import-preview">
              <h3>Результат проверки</h3>
              <div className="import-counts">
                <span>
                  <b>{preview.valid}</b> готово
                </span>
                <span>
                  <b>{preview.duplicates}</b> дубли
                </span>
                <span>
                  <b>{preview.errors}</b> ошибки
                </span>
              </div>
              <p className="muted">
                Будут записаны только корректные строки. Дубли и ошибки пропускаются. Ниже первые{' '}
                {preview.rows.length} строк.
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>СТРОКА</th>
                      <th>ДАННЫЕ</th>
                      <th>РЕЗУЛЬТАТ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((r: any) => (
                      <tr key={r.row}>
                        <td>{r.row}</td>
                        <td>
                          <span className="import-row-values">
                            {Object.entries(r.values)
                              .filter(([, v]) => v)
                              .map(([k, v]) => `${job.fields[k]}: ${v}`)
                              .join(' · ')}
                          </span>
                        </td>
                        <td>
                          <span
                            className={
                              'badge ' + (r.error ? 'cancelled' : r.duplicate ? 'paused' : 'done')
                            }
                          >
                            {r.error || r.duplicate || 'Готово'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="form-actions">
                <a className="btn" href={'/api/imports/' + job.id + '/errors'}>
                  <Download size={16} /> Журнал Excel
                </a>
                <button
                  className="btn dark"
                  disabled={busy || preview.valid === 0}
                  onClick={() =>
                    submit(async () => {
                      const r = await post('/imports/confirm', { id: job.id });
                      setResult(r);
                      refresh();
                      notify('Импорт завершён');
                    })
                  }
                >
                  Импортировать {preview.valid} строк <ArrowRight size={16} />
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="import-success">
          <Check size={35} />
          <h3>Импорт завершён</h3>
          <p>
            Создано: клиентов {result.clients || 0}, заказов {result.orders || 0}, расходов{' '}
            {result.expenses || 0}. Пропущено строк: {result.skipped || 0}.
          </p>
          <a className="btn" href={'/api/imports/' + job.id + '/errors'}>
            Скачать журнал
          </a>
          <button
            className="btn primary"
            onClick={() => {
              setJob(null);
              setPreview(null);
              setResult(null);
            }}
          >
            Новый импорт
          </button>
        </div>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {kind === 'orders' && (
        <div className="inline-note">
          Стоимость — цена за единицу изделия. Ткань, работа мастера и доставка, если сопоставлены
          как затраты, создаются как расходы без оплаты. Клиентские платежи при импорте не
          создаются.
        </div>
      )}
    </>
  );
}
function BackupInfo() {
  return (
    <>
      <h2>Резервное копирование</h2>
      <p className="muted">
        Резервная копия включает PostgreSQL, все документы и шаблон договора. Доступ к созданию и
        восстановлению есть у администратора компьютера.
      </p>
      <div className="backup-card">
        <Database size={30} />
        <h3>Создать копию</h3>
        <p>В папке проекта откройте терминал и выполните:</p>
        <code>npm run backup</code>
        <p>
          В Docker Compose отдельная служба создаёт ежедневные копии в папке backups. Скопируйте
          архив на другой диск или устройство.
        </p>
      </div>
      <div className="backup-card">
        <ShieldCheck size={30} />
        <h3>Восстановить копию</h3>
        <p>
          Выполняйте при остановленном приложении. Команда из README восстановит базу и документы в
          новый каталог. Перед заменой рабочей базы создайте свежую копию.
        </p>
        <code>npm run restore -- путь_к_копии</code>
      </div>
      <p className="muted">
        Рекомендуемая проверка — восстановление в отдельную тестовую базу хотя бы раз в месяц.
      </p>
    </>
  );
}
function AuditSettings() {
  const { data, error } = useLoad<any[]>('/audit');
  return (
    <>
      <h2>Журнал действий</h2>
      <p className="muted">
        Последние 200 событий. Существующие записи нельзя изменить через приложение.
      </p>
      {data ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ВРЕМЯ</th>
                <th>СОТРУДНИК</th>
                <th>ДЕЙСТВИЕ</th>
                <th>ОБЪЕКТ</th>
              </tr>
            </thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.id}>
                  <td>{new Date(a.created_at).toLocaleString('ru-RU')}</td>
                  <td>{a.author_name || 'Система'}</td>
                  <td>{auditActionLabel(a.action)}</td>
                  <td>{entityLabel(a.entity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <LoadState error={error} />
      )}
    </>
  );
}
