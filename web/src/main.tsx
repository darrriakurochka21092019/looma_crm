import React, { useCallback, useEffect, useState, createContext, useContext } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowDown,
  ArrowDownLeft,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Bell,
  BriefcaseBusiness,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  ClipboardList,
  Clock3,
  Download,
  Ellipsis,
  FileText,
  FolderOpen,
  LayoutDashboard,
  Link,
  Loader2,
  LogOut,
  Menu,
  MessageCircle,
  Package,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sofa,
  Sparkles,
  TrendingUp,
  Upload,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { api, post, patch, upload, money, decimal, dateLabel, day, key, ApiError } from './api';
import {
  canFinance,
  roleLabels,
  statusLabels,
  statuses,
  taskStatuses,
  documentCategories,
  categories,
  rublesToCents,
  type User,
  type Order,
  type Client,
  type Item,
  type Task,
  type DocumentRecord,
  type Expense,
} from '../../shared/domain';
import '@fontsource/manrope/400.css';
import '@fontsource/manrope/500.css';
import '@fontsource/manrope/600.css';
import '@fontsource/manrope/700.css';
import './styles.css';
import { AuditValues, auditActionLabel } from './audit';
import {
  ClientForm,
  OrderForm,
  PaymentForm,
  ExpenseForm,
  TaskForm,
  DocumentForm,
  StatusForm,
  StepForm,
  ContractForm,
  PlanForm,
  TaxForm,
  CommentsForm,
} from './forms';
import { SettingsPage, ImportPage } from './settings';
import { DocumentGenerationForm } from './document-generation';
type Context = {
  user: User;
  users: User[];
  revision: number;
  refresh: () => void;
  notify: (s: string) => void;
  open: (type: string, data?: any) => void;
  navigate: (s: string) => void;
};
export const AppContext = createContext<Context>(null!);
export const useApp = () => useContext(AppContext);
const nav = [
  ['dashboard', 'Обзор', LayoutDashboard],
  ['orders', 'Заказы', Sofa],
  ['clients', 'Клиенты', Users],
  ['finance', 'Финансы', Wallet],
  ['tasks', 'Задачи', CheckCheck],
  ['documents', 'Документы', FolderOpen],
  ['reports', 'Отчёты', Activity],
  ['settings', 'Настройки', Settings2],
] as const;
export function Badge({ status }: { status: string }) {
  return (
    <span className={'badge ' + status}>
      {statusLabels[status as keyof typeof statusLabels] ||
        taskStatuses[status as keyof typeof taskStatuses] ||
        status}
    </span>
  );
}
export function Empty({
  title = 'Пока ничего нет',
  text = 'Добавьте первую запись, чтобы начать работу.',
  action,
}: {
  title?: string;
  text?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <FolderOpen size={24} />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}
export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', fn);
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', fn);
      document.body.style.overflow = before;
    };
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className={'modal ' + (wide ? 'wide' : '')}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-heading">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <X size={20} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
export function Stat({
  label,
  value,
  note,
  accent = false,
  icon: Icon = ArrowUpRight,
  onClick,
}: {
  label: string;
  value: string;
  note: string;
  accent?: boolean;
  icon?: any;
  onClick?: () => void;
}) {
  return (
    <div className={'stat ' + (accent ? 'accent' : '')}>
      <div className="stat-top">
        <span>{label}</span>
        <button className="round-arrow" onClick={onClick} aria-label={label} disabled={!onClick}>
          <Icon size={18} />
        </button>
      </div>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  );
}
function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [email, setEmail] = useState('owner@looma.local'),
    [password, setPassword] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [invite, setInvite] = useState<any>(null),
    [accepted, setAccepted] = useState(false);
  const token = new URLSearchParams(location.search).get('invite');
  useEffect(() => {
    if (token)
      api('/auth/invite/' + token)
        .then(setInvite)
        .catch((e) => setError(e.message));
  }, [token]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (token && !accepted) {
        await post('/auth/accept-invite', { token, password });
        setAccepted(true);
        setEmail(invite.email);
        setPassword('');
        history.replaceState({}, '', location.pathname);
        return;
      }
      onLogin(await post('/auth/login', { email, password }));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-page">
      <div className="login-art">
        <Logo />
        <div>
          <div className="eyebrow">МЕСТО, ГДЕ СОБИРАЕТСЯ ВАШ БИЗНЕС</div>
          <h1>
            Каждый заказ.
            <br />
            Всё на своих
            <br />
            <em>местах.</em>
          </h1>
          <p>
            Клиенты, производство и финансы —<br />в одном спокойном рабочем пространстве.
          </p>
        </div>
        <div className="login-pill">
          <ShieldCheck size={17} /> Ваши данные · ваш контроль
        </div>
        <div className="abstract-sofa">
          <div />
          <div />
          <div />
        </div>
      </div>
      <main className="login-main">
        <form onSubmit={submit}>
          <span className="mini-tag">LOOMA.CRM / РАБОЧЕЕ ПРОСТРАНСТВО</span>
          <h2>{invite && !accepted ? 'Рады знакомству, ' + invite.name : 'Добро пожаловать'}</h2>
          <p>
            {invite && !accepted
              ? 'Создайте пароль для своей учётной записи.'
              : 'Войдите, чтобы продолжить работу.'}
          </p>
          {!token || accepted ? (
            <label>
              Email
              <input
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
          ) : (
            <div className="callout">
              {invite?.email} · {invite && roleLabels[invite.role as keyof typeof roleLabels]}
            </div>
          )}
          <label>
            {token && !accepted ? 'Новый пароль · минимум 12 символов' : 'Пароль'}
            <input
              autoComplete={token && !accepted ? 'new-password' : 'current-password'}
              type="password"
              minLength={token && !accepted ? 12 : 1}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {accepted && <p className="success">Учётная запись создана. Теперь войдите.</p>}
          <button className="btn primary full" disabled={busy || (!!token && !invite && !accepted)}>
            {busy ? <Loader2 className="spin" size={18} /> : null}
            {token && !accepted ? 'Принять приглашение' : 'Войти в кабинет'}
            <ArrowRight size={18} />
          </button>
          <div className="login-foot">
            Первый запуск? Данные для входа созданы командой setup и записаны в локальном файле
            .env.
          </div>
        </form>
      </main>
    </div>
  );
}
function Logo() {
  return (
    <div className="logo">
      <span className="logo-mark">
        <span />
        <span />
        <span />
      </span>
      <b>
        looma<span>.crm</span>
      </b>
    </div>
  );
}
function App() {
  const [companyName, setCompanyName] = useState('Мебельная мастерская');
  const [user, setUser] = useState<User | null>(null),
    [loading, setLoading] = useState(true),
    [route, setRoute] = useState(location.hash.slice(1) || 'dashboard'),
    [users, setUsers] = useState<User[]>([]),
    [revision, setRevision] = useState(0),
    [modal, setModal] = useState<{ type: string; data: any } | null>(null),
    [toast, setToast] = useState(''),
    [mobile, setMobile] = useState(false),
    [createMenu, setCreateMenu] = useState(false),
    [notifications, setNotifications] = useState(false),
    [dashboard, setDashboard] = useState<any>(null),
    [dashboardError, setDashboardError] = useState(''),
    [search, setSearch] = useState('');
  const [period, setPeriod] = useState(day().slice(0, 7));
  const routeRoot = route.split('/')[0];
  const page = routeRoot.split('?')[0];
  useEffect(() => {
    api<User>('/auth/me')
      .then(setUser)
      .catch(() => {})
      .finally(() => setLoading(false));
    const fn = () => setRoute(location.hash.slice(1) || 'dashboard');
    window.addEventListener('hashchange', fn);
    return () => window.removeEventListener('hashchange', fn);
  }, []);
  const navigate = useCallback((r: string) => {
    location.hash = r;
    setRoute(r);
    setMobile(false);
    setCreateMenu(false);
    setNotifications(false);
  }, []);
  const refresh = useCallback(() => setRevision((v) => v + 1), []);
  const notify = useCallback((s: string) => {
    setToast(s);
    setTimeout(() => setToast(''), 5000);
  }, []);
  const open = useCallback((type: string, data: any = {}) => {
    setModal({ type, data });
    setCreateMenu(false);
  }, []);
  useEffect(() => {
    if (user) {
      api('/company')
        .then((c) => setCompanyName(c.company_name))
        .catch(() => {});
      api<User[]>('/users')
        .then(setUsers)
        .catch(() => {});
      api('/dashboard?period=' + period)
        .then((d) => {
          setDashboard(d);
          setDashboardError('');
        })
        .catch((e) => {
          if (e.status === 401) setUser(null);
          else {
            setDashboardError(e.message);
            notify(e.message);
          }
        });
    }
  }, [user, revision, period, notify]);
  const close = useCallback(() => setModal(null), []);
  const saved = useCallback(
    (message = 'Изменения сохранены') => {
      close();
      refresh();
      notify(message);
    },
    [close, refresh, notify],
  );
  const logout = async () => {
    try {
      await post('/auth/logout', {});
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
    }
    setUser(null);
    setDashboard(null);
  };
  if (loading)
    return (
      <div className="loading-screen">
        <Loader2 className="spin" /> Открываем LOOMA.CRM…
      </div>
    );
  if (!user)
    return (
      <Login
        onLogin={(u) => {
          setUser(u);
          navigate('dashboard');
        }}
      />
    );
  const financial = canFinance(user.role),
    commercial = ['owner', 'manager'].includes(user.role);
  const navigation = nav.filter(
    ([id]) =>
      !(id === 'settings' && user.role !== 'owner') &&
      !(['finance', 'reports'].includes(id) && !financial),
  );
  const title = nav.find((n) => n[0] === page)?.[1] || 'Обзор';
  const ctx = { user, users, revision, refresh, notify, open, navigate };
  return (
    <AppContext.Provider value={ctx}>
      <div className="app-shell">
        <aside className={'sidebar ' + (mobile ? 'is-open' : '')}>
          <Logo />
          <div className="workspace">
            <span className="workspace-icon">
              <BriefcaseBusiness size={18} />
            </span>
            <div>
              <b>{companyName}</b>
              <small>Рабочее пространство</small>
            </div>
            <ChevronDown size={14} />
          </div>
          <span className="nav-label">УПРАВЛЕНИЕ</span>
          <nav>
            {navigation.map(([id, label, Icon]) => (
              <button
                key={id}
                className={'nav-item ' + (page === id ? 'active' : '')}
                onClick={() => navigate(id)}
              >
                <Icon size={19} />
                <span>{label}</span>
                {id === 'orders' && (
                  <span className="nav-count">
                    {dashboard?.counts
                      ?.filter((v: any) => !['closed', 'paused', 'cancelled'].includes(v.status))
                      .reduce((n: number, v: any) => n + v.count, 0) || 0}
                  </span>
                )}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="workspace-note">
              <span className="green-dot" /> Локальное пространство
              <span className="version">v1.2</span>
            </div>
            <button className="profile" onClick={() => open('profile')}>
              <span className="avatar">{user.name.slice(0, 1)}</span>
              <span>
                <b>{user.name}</b>
                <small>{roleLabels[user.role]}</small>
              </span>
              <Ellipsis size={18} />
            </button>
          </div>
        </aside>
        {mobile && <div className="sidebar-scrim" onClick={() => setMobile(false)} />}
        <div className="main-shell">
          <header className="topbar">
            <button
              className="icon-btn mobile-toggle"
              onClick={() => setMobile(!mobile)}
              aria-label="Меню"
            >
              <Menu size={22} />
            </button>
            <div className="breadcrumbs">
              Рабочее пространство <span>/</span>
              <b>{title}</b>
            </div>
            <form
              className="global-search"
              onSubmit={(e) => {
                e.preventDefault();
                navigate('orders?' + encodeURIComponent(search));
              }}
            >
              <Search size={17} />
              <input
                aria-label="Поиск по заказам"
                placeholder="Найти заказ или клиента…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <kbd>↵</kbd>
            </form>
            <div className="topbar-actions">
              <button
                className="notification-btn icon-btn"
                aria-label="Уведомления"
                onClick={() => setNotifications(!notifications)}
              >
                <Bell size={19} />
                {dashboard?.warnings?.length > 0 && <i />}
              </button>
              <div className="create-wrap">
                <button className="btn dark" onClick={() => setCreateMenu(!createMenu)}>
                  <Plus size={17} />
                  <span>Создать</span>
                </button>
                {createMenu && (
                  <div className="dropdown create-dropdown">
                    {commercial && (
                      <>
                        <button onClick={() => open('order')}>
                          <Sofa size={17} /> Заказ
                        </button>
                        <button onClick={() => open('client')}>
                          <Users size={17} /> Клиента
                        </button>
                      </>
                    )}
                    {financial && (
                      <>
                        <button onClick={() => open('payment')}>
                          <Wallet size={17} /> Поступление / возврат
                        </button>
                        <button onClick={() => open('expense')}>
                          <ArrowDownLeft size={17} /> Расход
                        </button>
                      </>
                    )}
                    <button onClick={() => open('task')}>
                      <CheckCheck size={17} /> Задачу
                    </button>
                  </div>
                )}
              </div>
            </div>
          </header>
          <main className="page" key={user.id}>
            <div className="page-heading">
              <div>
                <div className="eyebrow">
                  LOOMA /{' '}
                  {new Intl.DateTimeFormat('ru-RU', {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                    timeZone: 'Europe/Moscow',
                  }).format(new Date())}
                </div>
                <h1>
                  {page === 'dashboard' ? (
                    <>
                      Всё под контролем <span className="heading-dot">✦</span>
                    </>
                  ) : route.includes('/') ? (
                    'Карточка заказа'
                  ) : (
                    title
                  )}
                </h1>
                <p>
                  {page === 'dashboard'
                    ? 'Хороший день начинается с ясной картины.'
                    : (
                        {
                          orders: 'От первого эскиза до счастливого клиента.',
                          clients: 'Люди, для которых вы создаёте.',
                          finance: 'Каждый рубль — на своём месте.',
                          tasks: 'Понятный план для всей команды.',
                          documents: 'Все важные файлы рядом.',
                          reports: 'Результаты бизнеса в понятных цифрах.',
                          settings: 'Настройте пространство под вашу мастерскую.',
                        } as any
                      )[page.split('?')[0]]}
                </p>
              </div>
              {['dashboard', 'finance', 'reports'].includes(page) && financial && (
                <label className="period-picker">
                  <CalendarDays size={16} />
                  <input
                    aria-label="Месяц отчёта"
                    type="month"
                    value={period}
                    onChange={(e) => e.target.value && setPeriod(e.target.value)}
                  />
                </label>
              )}
            </div>
            <div>
              {page === 'dashboard' &&
                (dashboard ? (
                  <Dashboard data={dashboard} period={period} />
                ) : (
                  <LoadState error={dashboardError} />
                ))}
              {(page === 'orders' || page.startsWith('orders?')) &&
                (route.includes('/') ? (
                  <OrderDetail id={route.split('/')[1]} />
                ) : (
                  <Orders
                    initialQuery={
                      routeRoot.startsWith('orders?') ? decodeURIComponent(routeRoot.slice(7)) : ''
                    }
                  />
                ))}
              {page === 'clients' && <Clients />}
              {page === 'finance' && financial && <Finance period={period} />}
              {page === 'tasks' && <Tasks />}
              {page === 'documents' && <Documents />}
              {page === 'reports' && financial && <Reports period={period} />}
              {page === 'settings' && user.role === 'owner' && <SettingsPage />}
            </div>
            <footer className="page-footer">
              <span>LOOMA.CRM</span>
              <span>Создавайте мебель. Остальное — по порядку.</span>
            </footer>
          </main>
        </div>
      </div>
      {notifications && (
        <div className="notifications-panel">
          <div className="panel-heading">
            <h3>Требуют внимания</h3>
            <button className="icon-btn" onClick={() => setNotifications(false)}>
              <X size={18} />
            </button>
          </div>
          {dashboard?.warnings?.length ? (
            dashboard.warnings.map((w: any, i: number) => (
              <button
                className="notification-item"
                key={i}
                onClick={() => navigate(w.type === 'order' ? 'orders/' + w.id : 'tasks')}
              >
                <span className="notice-dot" />
                <span>
                  <b>{w.title}</b>
                  <small>{w.description}</small>
                </span>
                <ArrowUpRight size={16} />
              </button>
            ))
          ) : (
            <Empty title="Всё в порядке" text="Новых напоминаний пока нет." />
          )}
        </div>
      )}
      {modal && (
        <Modal
          title={
            (
              {
                client: modal.data.id ? 'Редактировать клиента' : 'Новый клиент',
                order: modal.data.id ? 'Изменить заказ' : 'Новый заказ',
                payment: 'Поступление / возврат',
                expense: modal.data.id ? 'Изменить расход' : 'Новый расход',
                expensePay: 'Оплатить расход',
                task: modal.data.id ? 'Изменить задачу' : 'Новая задача',
                document: 'Прикрепить документ',
                status: 'Изменить статус',
                step: 'Производственный этап',
                contract: 'Сформировать договор',
                generate_documents: 'Создать документы из заказа',
                plan: 'Плановый платёж',
                tax: 'Налоговый резерв',
                comments: 'Обсуждение задачи',
                profile: 'Ваш профиль',
                import: 'Импорт из Excel',
              } as any
            )[modal.type] || 'LOOMA.CRM'
          }
          onClose={close}
          wide={['order', 'import', 'generate_documents'].includes(modal.type)}
        >
          {modal.type === 'client' && <ClientForm data={modal.data} onSaved={saved} />}
          {modal.type === 'order' && <OrderForm data={modal.data} onSaved={saved} />}
          {['payment', 'expensePay'].includes(modal.type) && (
            <PaymentForm data={modal.data} expense={modal.type === 'expensePay'} onSaved={saved} />
          )}
          {modal.type === 'expense' && <ExpenseForm data={modal.data} onSaved={saved} />}
          {modal.type === 'task' && <TaskForm data={modal.data} onSaved={saved} />}
          {modal.type === 'document' && <DocumentForm data={modal.data} onSaved={saved} />}
          {modal.type === 'status' && <StatusForm data={modal.data} onSaved={saved} />}
          {modal.type === 'step' && <StepForm data={modal.data} onSaved={saved} />}
          {modal.type === 'contract' && <ContractForm data={modal.data} onSaved={saved} />}
          {modal.type === 'generate_documents' && (
            <DocumentGenerationForm data={modal.data} onSaved={saved} />
          )}
          {modal.type === 'plan' && <PlanForm data={modal.data} onSaved={saved} />}
          {modal.type === 'tax' && <TaxForm data={modal.data} onSaved={saved} />}
          {modal.type === 'comments' && <CommentsForm data={modal.data} onSaved={saved} />}
          {modal.type === 'import' && <ImportPage onSaved={saved} />}
          {modal.type === 'profile' && <Profile logout={logout} onSaved={saved} />}
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={18} />
          {toast}
          <button onClick={() => setToast('')} aria-label="Скрыть">
            <X size={15} />
          </button>
        </div>
      )}
    </AppContext.Provider>
  );
}
export function useLoad<T>(path: string | null) {
  const { revision } = useApp();
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setData(null);
    setError('');
    if (!path) return;
    api<T>(path)
      .then((d) => active && setData(d))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [path, revision]);
  return { data, error, setData };
}
export function LoadState({ error }: { error: string }) {
  return error ? (
    <div className="callout error" role="alert">
      {error}
      <button className="text-btn" onClick={() => location.reload()}>
        Обновить
      </button>
    </div>
  ) : (
    <div className="skeleton-block">
      <Loader2 className="spin" size={22} /> Загружаем данные…
    </div>
  );
}
function Dashboard({ data, period }: { data: any; period: string }) {
  const { user, navigate, open } = useApp();
  const financial = canFinance(user.role),
    s = data.summary;
  const active = data.counts
    .filter((v: any) => !['closed', 'paused', 'cancelled'].includes(v.status))
    .reduce((n: number, v: any) => n + v.count, 0);
  const orders = data.orders;
  return (
    <>
      <div className="dashboard-top">
        <div className="stat-grid">
          {financial ? (
            <>
              <Stat
                label="Поступления"
                value={money(s.receipts)}
                note="Получено от клиентов за месяц"
                accent
                onClick={() => navigate('finance')}
              />
              <Stat
                label="Денежные выплаты"
                value={money(s.payouts)}
                note="Фактические оплаты расходов"
                onClick={() => navigate('finance')}
              />
              <Stat
                label="Прибыль до налогов"
                value={money(s.management_profit)}
                note="По закрытым заказам − общие расходы"
                onClick={() => navigate('reports')}
              />
              <Stat
                label="Налоговый резерв"
                value={money(s.tax_reserve)}
                note="Оценка по настроенному правилу"
                onClick={() => navigate('finance')}
              />
            </>
          ) : (
            <>
              <Stat
                label="Заказы в работе"
                value={String(active).padStart(2, '0')}
                note="Доступные вам заказы"
                accent
                onClick={() => navigate('orders')}
              />
              <Stat
                label="Мои задачи"
                value={String(data.tasks.length).padStart(2, '0')}
                note="Ближайшие активные задачи"
                onClick={() => navigate('tasks')}
              />
              <Stat
                label="Готовы к доставке"
                value={String(data.counts.find((c: any) => c.status === 'ready')?.count || 0)}
                note="Прошли контроль качества"
                onClick={() => navigate('orders')}
              />
              <Stat
                label="Требуют внимания"
                value={String(data.warnings.length)}
                note="Сроки и напоминания"
                onClick={() => navigate('tasks')}
              />
            </>
          )}
        </div>
        <section className="card chart-card">
          <div className="card-heading">
            <div>
              <h2>{financial ? 'Движение поступлений' : 'Заказы по этапам'}</h2>
              <p>
                {financial
                  ? 'Подтверждённые оплаты за выбранный месяц'
                  : 'Текущее состояние производства'}
              </p>
            </div>
            <span className="chip">
              <span className="purple-dot" />
              {financial ? 'Поступления' : 'Производство'}
            </span>
          </div>
          {financial ? (
            <CashChart data={data.chart} period={period} />
          ) : (
            <StatusBreakdown counts={data.counts} />
          )}
        </section>
      </div>
      <div className="dashboard-middle">
        <div className="overview-banner">
          <div>
            <span className="eyebrow">МАСТЕРСКАЯ В ДВИЖЕНИИ</span>
            <h2>
              {active}
              <span>заказов в работе</span>
            </h2>
            <p>Каждое изделие — от идеи до последнего шва.</p>
            <button className="text-btn" onClick={() => navigate('orders')}>
              Перейти к заказам <ArrowUpRight size={16} />
            </button>
          </div>
          <div className="sofa-illustration">
            <Sofa strokeWidth={1} size={112} />
            <span>made with care</span>
          </div>
        </div>
        <section className="card attention-card">
          <div className="card-heading">
            <h2>
              Требуют внимания <span className="count-bubble">{data.warnings.length}</span>
            </h2>
            <Clock3 size={19} />
          </div>
          {data.warnings.length ? (
            data.warnings.slice(0, 3).map((w: any, i: number) => (
              <button
                className="attention-row"
                key={i}
                onClick={() => navigate(w.type === 'order' ? 'orders/' + w.id : 'tasks')}
              >
                <span className={'attention-icon color-' + i}>
                  <Clock3 size={17} />
                </span>
                <span>
                  <b>{w.title}</b>
                  <small>{w.description}</small>
                </span>
                <ArrowUpRight size={16} />
              </button>
            ))
          ) : (
            <p className="quiet-state">
              <CheckCheck size={18} /> Все сроки под контролем
            </p>
          )}
        </section>
      </div>
      <div className="dashboard-bottom">
        <section className="card orders-card">
          <div className="card-heading">
            <div>
              <h2>Ближайшие заказы</h2>
              <p>По обещанной дате готовности</p>
            </div>
            <button className="text-btn" onClick={() => navigate('orders')}>
              Все заказы <ArrowUpRight size={16} />
            </button>
          </div>
          <OrderTable orders={orders} compact />
        </section>
        <section className="card my-tasks">
          <div className="card-heading">
            <h2>Мои задачи</h2>
            <button
              className="icon-btn soft"
              onClick={() => open('task')}
              aria-label="Добавить задачу"
            >
              <Plus size={18} />
            </button>
          </div>
          {data.tasks.length ? (
            data.tasks.map((t: Task) => <TaskRow key={t.id} task={t} />)
          ) : (
            <Empty title="Можно выдохнуть" text="Ближайших задач пока нет." />
          )}
          <button className="all-tasks text-btn" onClick={() => navigate('tasks')}>
            Открыть список задач <ArrowRight size={16} />
          </button>
        </section>
      </div>
    </>
  );
}
function CashChart({ data, period }: { data: any[]; period: string }) {
  const [y, m] = period.split('-').map(Number);
  const days = new Date(y, m, 0).getDate();
  const buckets = Array.from({ length: 8 }, (_, i) => ({
    label: `${Math.floor((i * days) / 8) + 1}`,
    value: 0,
  }));
  for (const d of data) {
    const idx = Math.min(7, Math.floor(((Number(d.day.slice(8)) - 1) / days) * 8));
    buckets[idx].value += d.amount;
  }
  const max = Math.max(...buckets.map((b) => Math.abs(b.value)), 100);
  return (
    <div className="cash-chart">
      <div className="chart-axis">
        {[1, 0.75, 0.5, 0.25, 0].map((n) => (
          <span key={n}>
            {new Intl.NumberFormat('ru-RU', {
              notation: 'compact',
              maximumFractionDigits: 0,
            }).format((max * n) / 100)}
          </span>
        ))}
      </div>
      <div className="chart-plot">
        <div className="chart-grid">
          {[0, 1, 2, 3, 4].map((i) => (
            <i key={i} />
          ))}
        </div>
        <div className="bars">
          {buckets.map((b, i) => (
            <div className="bar-column" key={i}>
              <div
                className={'bar ' + (b.value < 0 ? 'negative' : '')}
                style={{ height: `${Math.max(2, (Math.abs(b.value) / max) * 94)}%` }}
                tabIndex={0}
              >
                <span className="bar-tip">{money(b.value)}</span>
              </div>
              <small>{b.label}</small>
            </div>
          ))}
        </div>
      </div>
      <span className="chart-caption">Числа месяца · суммы сгруппированы по периодам</span>
    </div>
  );
}
function StatusBreakdown({ counts }: { counts: any[] }) {
  const total = counts.reduce((n, c) => n + c.count, 0);
  return (
    <div className="status-breakdown">
      {counts.map((c) => (
        <div key={c.status}>
          <span>{statusLabels[c.status as keyof typeof statusLabels]}</span>
          <div>
            <i style={{ width: `${(c.count / (total || 1)) * 100}%` }} />
          </div>
          <b>{c.count}</b>
        </div>
      ))}
    </div>
  );
}
export function OrderTable({ orders, compact = false }: { orders: Order[]; compact?: boolean }) {
  const { user, navigate } = useApp();
  return orders.length ? (
    <div className="table-wrap">
      <table className={'order-table ' + (compact ? 'compact' : '')}>
        <thead>
          <tr>
            <th>ЗАКАЗ / КЛИЕНТ</th>
            {!compact && <th>ИЗДЕЛИЕ</th>}
            {user.role !== 'master' && <th>СТОИМОСТЬ</th>}
            <th>СРОК</th>
            <th>СТАТУС</th>
            {!compact && <th>ОТВЕТСТВЕННЫЙ</th>}
            <th />
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr
              key={o.id}
              onClick={() => navigate('orders/' + o.id)}
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && navigate('orders/' + o.id)}
            >
              <td>
                <b className="order-number">{o.number}</b>
                <span className="cell-sub">{o.client_name}</span>
              </td>
              {!compact && (
                <td>
                  <b>{o.title}</b>
                </td>
              )}
              {user.role !== 'master' && <td className="nowrap">{money(o.total)}</td>}
              <td
                className={
                  o.due_date < day() && !['closed', 'paused', 'cancelled'].includes(o.status)
                    ? 'overdue'
                    : ''
                }
              >
                {dateLabel(o.due_date)}
              </td>
              <td>
                <Badge status={o.status} />
              </td>
              {!compact && (
                <td>
                  <span className="person-cell">
                    <span className="avatar tiny">{(o.manager_name || '—')[0]}</span>
                    {o.manager_name || 'Не назначен'}
                  </span>
                </td>
              )}
              <td>
                <ArrowUpRight size={16} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty title="Заказов пока нет" text="Добавьте заказ или измените условия поиска." />
  );
}
function Orders({ initialQuery }: { initialQuery: string }) {
  const { user, open } = useApp();
  const [q, setQ] = useState(initialQuery),
    [status, setStatus] = useState(''),
    [page, setPage] = useState(1),
    [sort, setSort] = useState('due'),
    [scope, setScope] = useState('work');
  const { data, error } = useLoad<any>(
    `/orders?q=${encodeURIComponent(q)}&page=${page}&sort=${sort}&scope=${scope}${status ? '&status=' + status : ''}`,
  );
  const { data: dash } = useLoad<any>('/dashboard');
  useEffect(() => {
    setQ(initialQuery);
    setPage(1);
  }, [initialQuery]);
  return (
    <>
      <div className="order-summary-grid">
        {[
          ['new', 'Новые заявки', 'blue'],
          ['production', 'В производстве', 'peach'],
          ['ready', 'Готовы к доставке', 'yellow'],
          ['closed', 'Завершённые', 'green'],
        ].map(([s, label, color]) => (
          <button
            key={s}
            className={'mini-stat ' + color + (status === s ? ' selected' : '')}
            onClick={() => {
              setStatus(status === s ? '' : s);
              setScope('work');
              setPage(1);
            }}
          >
            <span>
              {label}
              <ArrowUpRight size={15} />
            </span>
            <strong>
              {String(dash?.counts.find((c: any) => c.status === s)?.count || 0).padStart(2, '0')}
            </strong>
            <small>Заказов в этой категории</small>
          </button>
        ))}
      </div>
      <section className="card">
        <div className="list-toolbar">
          <div className="local-search">
            <Search size={17} />
            <input
              aria-label="Найти заказ"
              placeholder="Номер, клиент, изделие…"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="segmented">
            <button
              className={scope === 'work' ? 'active' : ''}
              onClick={() => {
                setScope('work');
                setStatus('');
                setPage(1);
              }}
            >
              В работе
            </button>
            <button
              className={scope === 'archive' ? 'active' : ''}
              onClick={() => {
                setScope('archive');
                setStatus('');
                setPage(1);
              }}
            >
              Архив
            </button>
          </div>
          <span className="results-count">{data?.total || 0} заказов</span>
          <div className="toolbar-spacer" />
          <select
            aria-label="Фильтр статуса"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              if (['paused', 'cancelled'].includes(e.target.value)) setScope('archive');
              setPage(1);
            }}
          >
            <option value="">Все статусы</option>
            {statuses
              .filter((s) =>
                scope === 'archive'
                  ? ['paused', 'cancelled'].includes(s)
                  : !['paused', 'cancelled'].includes(s),
              )
              .map((s) => (
                <option key={s} value={s}>
                  {statusLabels[s]}
                </option>
              ))}
          </select>
          <select aria-label="Сортировка" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="due">По сроку</option>
            <option value="newest">Сначала новые</option>
          </select>
          {['owner', 'manager'].includes(user.role) && (
            <button className="btn dark" onClick={() => open('order')}>
              <Plus size={16} /> Новый заказ
            </button>
          )}
        </div>
        {data ? <OrderTable orders={data.items} /> : <LoadState error={error} />}
        <div className="pagination">
          <span>
            Страница {page}
            {data ? ' из ' + Math.max(1, Math.ceil(data.total / 30)) : ''}
          </span>
          <button
            className="icon-btn"
            disabled={page === 1}
            onClick={() => setPage((p) => p - 1)}
            aria-label="Предыдущая страница"
          >
            <ChevronLeft size={17} />
          </button>
          <button
            className="icon-btn"
            disabled={!data || page * 30 >= data.total}
            onClick={() => setPage((p) => p + 1)}
            aria-label="Следующая страница"
          >
            <ChevronRight size={17} />
          </button>
        </div>
      </section>
    </>
  );
}
function OrderDetail({ id }: { id: string }) {
  const { user, open, navigate } = useApp();
  const [tab, setTab] = useState('overview');
  const { data: o, error } = useLoad<any>('/orders/' + id);
  const financial = canFinance(user.role);
  const commercial = ['owner', 'manager'].includes(user.role);
  if (!o) return <LoadState error={error} />;
  const tabs = [
    ['overview', 'Обзор'],
    ['items', 'Изделия'],
    ...(financial ? [['finance', 'Финансы']] : []),
    ['documents', 'Документы'],
    ['tasks', 'Задачи'],
    ...(financial ? [['history', 'История']] : []),
  ];
  return (
    <>
      <button className="back-link text-btn" onClick={() => navigate('orders')}>
        <ArrowLeft size={16} /> Все заказы
      </button>
      <section className="card detail-header">
        <div className="detail-title">
          <span className="order-code">{o.number}</span>
          <Badge status={o.status} />
          {o.status === 'closed' && o.debt > 0 && (
            <span className="badge paused">Остался долг</span>
          )}
        </div>
        <div className="detail-title">
          <div>
            <h2>{o.title}</h2>
            <p>
              {o.client_name} <span>·</span> +{o.client_phone} <span>·</span> до{' '}
              {dateLabel(o.due_date)}
            </p>
          </div>
          <div className="detail-actions">
            {financial && (
              <button className="btn dark" onClick={() => open('generate_documents', o)}>
                <FileText size={16} />
                Создать документы
              </button>
            )}
            {commercial && (
              <>
                <button className="btn" onClick={() => open('order', o)}>
                  Изменить
                </button>
                <button className="btn primary" onClick={() => open('status', o)}>
                  Статус <ChevronDown size={15} />
                </button>
              </>
            )}
            <button className="btn" onClick={() => open('document', { order_id: id })}>
              <Upload size={16} /> Документ
            </button>
          </div>
        </div>
        <div className="tabs">
          {tabs.map(([s, l]) => (
            <button key={s} className={tab === s ? 'active' : ''} onClick={() => setTab(s)}>
              {l}
            </button>
          ))}
        </div>
      </section>
      {['paused', 'cancelled'].includes(o.status) && (
        <div className="callout archive-note">
          Заказ в архиве и исключён из расчётов, задолженности и рабочих списков. Данные ниже
          сохранены для истории. {o.status_reason && <b>Причина: {o.status_reason}</b>}
        </div>
      )}
      {tab === 'overview' && (
        <div className="detail-grid">
          <section className="card">
            <div className="card-heading">
              <div>
                <h2>Производство</h2>
                <p>От материалов до передачи клиенту</p>
              </div>
              <span className="chip">
                {o.steps.filter((s: any) => s.status === 'done' || s.status === 'skipped').length} /{' '}
                {o.steps.length}
              </span>
            </div>
            <div className="production-timeline">
              {o.steps.map((s: any, i: number) => (
                <button
                  className={'production-step ' + s.status}
                  key={s.id}
                  onClick={() => open('step', s)}
                >
                  <span className="step-dot">
                    {s.status === 'done' ? (
                      <Check size={15} />
                    ) : s.status === 'skipped' ? (
                      '–'
                    ) : (
                      String(i + 1).padStart(2, '0')
                    )}
                  </span>
                  <span>
                    <b>{s.name}</b>
                    <small>
                      {s.assignee_name || 'Не назначен'} · {dateLabel(s.due_date)}
                      {s.comment ? ' · ' + s.comment : ''}
                    </small>
                  </span>
                  <span className="step-state">
                    {
                      (
                        {
                          new: 'Ожидает',
                          doing: 'В работе',
                          done: 'Готово',
                          skipped: 'Пропущен',
                        } as any
                      )[s.status]
                    }
                  </span>
                  <ChevronRight size={16} />
                </button>
              ))}
            </div>
          </section>
          <div className="detail-side">
            <section className="card">
              <div className="card-heading">
                <h2>О заказе</h2>
                <Sofa size={19} />
              </div>
              <dl className="info-list">
                <dt>Клиент</dt>
                <dd>{o.client_name}</dd>
                <dt>Менеджер</dt>
                <dd>{o.manager_name || 'Не назначен'}</dd>
                <dt>Мастер</dt>
                <dd>{o.master_name || 'Не назначен'}</dd>
                <dt>Дата готовности</dt>
                <dd className={o.due_date < day() && o.status !== 'closed' ? 'overdue' : ''}>
                  {dateLabel(o.due_date)}
                </dd>
                <dt>Адрес</dt>
                <dd>{o.client_address || 'Не указан'}</dd>
                {user.role !== 'master' && (
                  <>
                    <dt>Стоимость</dt>
                    <dd>{money(o.total)}</dd>
                  </>
                )}
              </dl>
              {o.notes && (
                <div className="order-note">
                  <b>Примечание</b>
                  <p>{o.notes}</p>
                </div>
              )}
              {o.status_reason && <div className="callout">{o.status_reason}</div>}
            </section>
            {user.role !== 'master' && (
              <section className="card">
                <div className="card-heading">
                  <h2>План платежей</h2>
                  <button
                    className="icon-btn soft"
                    onClick={() => open('plan', o)}
                    aria-label="Добавить план платежа"
                  >
                    <Plus size={16} />
                  </button>
                </div>
                {o.payment_plans.length ? (
                  o.payment_plans.map((p: any) => (
                    <div className="plan-row" key={p.id}>
                      <span>
                        {p.title}
                        <small>{dateLabel(p.due_date)}</small>
                      </span>
                      <b>{money(p.amount)}</b>
                    </div>
                  ))
                ) : (
                  <p className="muted">Платежи ещё не запланированы.</p>
                )}
                {commercial && (
                  <button className="btn full" onClick={() => open('contract', o)}>
                    <FileText size={16} /> Договор по своему шаблону
                  </button>
                )}
              </section>
            )}
          </div>
        </div>
      )}
      {tab === 'items' && (
        <section className="card">
          <div className="card-heading">
            <h2>Спецификация · {o.items.length} изделия</h2>
            {commercial && (
              <button className="btn" onClick={() => open('order', o)}>
                Редактировать
              </button>
            )}
          </div>
          <div className="item-cards">
            {o.items.map((i: Item, index: number) => (
              <article className="product-card" key={i.id}>
                <div className="product-icon">
                  <Sofa size={40} strokeWidth={1.2} />
                  <span>{String(index + 1).padStart(2, '0')}</span>
                </div>
                <div>
                  <span className="eyebrow">
                    {i.kind} · {i.quantity} шт.
                  </span>
                  <h3>{i.model}</h3>
                  <dl className="info-list">
                    <dt>Размеры, см</dt>
                    <dd>{i.dimensions || '—'}</dd>
                    <dt>Ткань / артикул</dt>
                    <dd>{i.fabric || '—'}</dd>
                    <dt>Цвет</dt>
                    <dd>{i.color || '—'}</dd>
                    <dt>Наполнение</dt>
                    <dd>{i.filling || '—'}</dd>
                    <dt>Механизм</dt>
                    <dd>{i.mechanism || '—'}</dd>
                    {i.price !== undefined && (
                      <>
                        <dt>Цена за единицу</dt>
                        <dd>{money(i.price)}</dd>
                      </>
                    )}
                    {i.planned_cost !== undefined && (
                      <>
                        <dt>Плановая себестоимость</dt>
                        <dd>{money(i.planned_cost)}</dd>
                      </>
                    )}
                  </dl>
                  <p className="muted">{i.notes}</p>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
      {tab === 'finance' && (
        <>
          <div className="stat-grid six">
            <Stat label="Цена заказа" value={money(o.total)} note="За вычетом скидки" />
            <Stat label="План затрат" value={money(o.planned_cost)} note="По спецификации" />
            <Stat label="Факт затрат" value={money(o.actual_cost)} note="Независимо от оплаты" />
            <Stat
              label="Валовая прибыль"
              value={money(o.gross_profit)}
              note={
                (o.status === 'closed' ? 'Заказ закрыт' : 'Предварительно') +
                ' · маржа ' +
                (o.margin ?? 0).toLocaleString('ru-RU') +
                '%'
              }
              accent
            />
            <Stat
              label="Получено от клиента"
              value={money(o.paid)}
              note={o.overpayment ? 'Переплата: ' + money(o.overpayment) : 'За вычетом возвратов'}
            />
            <Stat label="Долг клиента" value={money(o.debt)} note="Сохраняется и после закрытия" />
          </div>
          <Finance period={day().slice(0, 7)} order={o} />
        </>
      )}
      {tab === 'documents' && <Documents orderId={id} />}
      {tab === 'tasks' && <Tasks orderId={id} />}
      {tab === 'history' && <History orderId={id} />}
    </>
  );
}
function Clients() {
  const { user, open, navigate } = useApp();
  const [q, setQ] = useState(''),
    [selected, setSelected] = useState<Client | null>(null),
    [page, setPage] = useState(1);
  const { data, error } = useLoad<Client[]>(
    '/clients?limit=30&page=' + page + '&q=' + encodeURIComponent(q),
  );
  const history = useLoad<any>(selected ? '/orders?client_id=' + selected.id : '/orders?limit=1');
  return (
    <>
      <section className="card">
        <div className="list-toolbar">
          <div className="local-search">
            <Search size={17} />
            <input
              placeholder="Имя, телефон, email…"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
              aria-label="Поиск клиента"
            />
          </div>
          <span className="results-count">{(data?.[0] as any)?.total_count || 0} клиентов</span>
          <div className="toolbar-spacer" />
          {['owner', 'manager'].includes(user.role) && (
            <button className="btn dark" onClick={() => open('client')}>
              <Plus size={16} /> Добавить клиента
            </button>
          )}
        </div>
        {data ? (
          data.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>КЛИЕНТ</th>
                    <th>ТЕЛЕФОН</th>
                    <th>EMAIL</th>
                    <th>АДРЕС</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.map((c) => (
                    <tr key={c.id} onClick={() => setSelected(c)}>
                      <td>
                        <span className="person-cell">
                          <span className="avatar client-avatar">{c.name[0]}</span>
                          <span>
                            <b>{c.name}</b>
                            <small className="cell-sub">
                              {c.type === 'company' ? 'Организация' : 'Частный клиент'}
                            </small>
                          </span>
                        </span>
                      </td>
                      <td>+{c.phone}</td>
                      <td>{c.email || '—'}</td>
                      <td>{c.address || 'Не указан'}</td>
                      <td>
                        <ArrowUpRight size={16} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="Клиенты не найдены" />
          )
        ) : (
          <LoadState error={error} />
        )}
        <div className="pagination">
          <span>Страница {page}</span>
          <button className="icon-btn" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
            <ChevronLeft size={16} />
          </button>
          <button
            className="icon-btn"
            disabled={!data || data.length < 30}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </section>
      {selected && (
        <Modal title={selected.name} onClose={() => setSelected(null)} wide>
          <dl className="info-list">
            <dt>Телефон</dt>
            <dd>+{selected.phone}</dd>
            <dt>Email</dt>
            <dd>{selected.email || '—'}</dd>
            <dt>Адрес</dt>
            <dd>{selected.address || '—'}</dd>
            <dt>Примечание</dt>
            <dd>{selected.notes || '—'}</dd>
            <dt>Реквизиты</dt>
            <dd>{selected.details || '—'}</dd>
          </dl>
          <div className="form-actions">
            {['owner', 'manager'].includes(user.role) && (
              <button
                className="btn"
                onClick={() => {
                  setSelected(null);
                  open('client', selected);
                }}
              >
                Редактировать
              </button>
            )}
            <button
              className="btn primary"
              onClick={() => {
                setSelected(null);
                navigate('orders?' + encodeURIComponent(selected.name));
              }}
            >
              Все заказы клиента <ArrowRight size={16} />
            </button>
          </div>
          <h3>Последние заказы</h3>
          {history.data && <OrderTable orders={history.data.items} compact />}
        </Modal>
      )}
    </>
  );
}
export function TaskRow({ task: t }: { task: Task }) {
  const { refresh, notify, open } = useApp();
  return (
    <div className={'task-row ' + (t.status === 'done' ? 'completed' : '')}>
      <button
        className={'task-check ' + (t.status === 'done' ? 'checked' : '')}
        aria-label={t.status === 'done' ? 'Вернуть задачу' : 'Завершить задачу'}
        onClick={async () => {
          try {
            await patch('/tasks/' + t.id, {
              status: t.status === 'done' ? 'new' : 'done',
              version: t.version,
            });
            refresh();
          } catch (e: any) {
            notify(e.message);
          }
        }}
      >
        {t.status === 'done' && <Check size={14} />}
      </button>
      <button className="task-body" onClick={() => open('comments', t)}>
        <b>{t.title}</b>
        <small className={new Date(t.due_at) < new Date() && t.status !== 'done' ? 'overdue' : ''}>
          {dateLabel(t.due_at)}
          {t.order_number ? ' · ' + t.order_number : ''}
        </small>
      </button>
      {t.priority === 'high' && <span className="priority-dot" title="Высокий приоритет" />}
    </div>
  );
}
export function Tasks({ orderId }: { orderId?: string }) {
  const { user, open, refresh, notify } = useApp();
  const [scope, setScope] = useState(['owner', 'manager'].includes(user.role) ? 'team' : 'mine'),
    [view, setView] = useState('board'),
    [kind, setKind] = useState('all');
  const { data, error } = useLoad<Task[]>(
    `/tasks?scope=${scope}&kind=${orderId ? 'all' : kind}${orderId ? '&order_id=' + orderId : ''}`,
  );
  return (
    <section className="card task-board-card">
      <div className="list-toolbar">
        <div className="segmented">
          {[
            ['mine', 'Мои задачи'],
            ...(['owner', 'manager'].includes(user.role) ? [['team', 'Команда']] : []),
            ['overdue', 'Просроченные'],
          ].map(([s, l]) => (
            <button className={scope === s ? 'active' : ''} key={s} onClick={() => setScope(s)}>
              {l}
            </button>
          ))}
        </div>
        <div className="toolbar-spacer" />
        {!orderId && (
          <select aria-label="Тип задач" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="all">Все задачи</option>
            <option value="order">По заказам</option>
            <option value="standalone">Отдельные задачи</option>
          </select>
        )}
        <button className="btn" onClick={() => setView(view === 'board' ? 'list' : 'board')}>
          {view === 'board' ? 'Списком' : 'Канбан'}
        </button>
        <button className="btn dark" onClick={() => open('task', { order_id: orderId })}>
          <Plus size={16} /> Задача
        </button>
      </div>
      {data ? (
        data.length ? (
          view === 'board' ? (
            <div className="kanban">
              {Object.entries(taskStatuses).map(([s, l]) => (
                <div className="kanban-column" key={s}>
                  <div className="kanban-heading">
                    <span className={'kanban-dot ' + s} />
                    <b>{l}</b>
                    <span>{data.filter((t) => t.status === s).length}</span>
                  </div>
                  {data
                    .filter((t) => t.status === s)
                    .map((t) => (
                      <article className="kanban-card" key={t.id}>
                        <span className="eyebrow">{t.order_number || 'ОТДЕЛЬНАЯ ЗАДАЧА'}</span>
                        <h3>{t.title}</h3>
                        <p>{t.description}</p>
                        <div className="kanban-meta">
                          <span
                            className={
                              new Date(t.due_at) < new Date() && s !== 'done' ? 'overdue' : ''
                            }
                          >
                            <CalendarDays size={13} />
                            {dateLabel(t.due_at)}
                          </span>
                          <span className="avatar tiny" title={t.assignee_name}>
                            {t.assignee_name[0]}
                          </span>
                        </div>
                        <div className="kanban-actions">
                          <select
                            aria-label="Статус задачи"
                            value={s}
                            onChange={async (e) => {
                              try {
                                await patch('/tasks/' + t.id, {
                                  version: t.version,
                                  status: e.target.value,
                                });
                                refresh();
                              } catch (err: any) {
                                notify(err.message);
                              }
                            }}
                          >
                            {Object.entries(taskStatuses).map(([v, l]) => (
                              <option key={v} value={v}>
                                {l}
                              </option>
                            ))}
                          </select>
                          <button
                            className="icon-btn"
                            onClick={() => open('comments', t)}
                            aria-label="Комментарии"
                          >
                            <MessageCircle size={16} />
                          </button>
                        </div>
                      </article>
                    ))}
                </div>
              ))}
            </div>
          ) : (
            <div className="task-list">
              {data.map((t) => (
                <TaskRow key={t.id} task={t} />
              ))}
            </div>
          )
        ) : (
          <Empty title="Задач пока нет" text="Создайте первую задачу для себя или сотрудника." />
        )
      ) : (
        <LoadState error={error} />
      )}
    </section>
  );
}
export function Documents({ orderId }: { orderId?: string }) {
  const { user, open } = useApp();
  const [q, setQ] = useState(''),
    [category, setCategory] = useState('');
  const { data, error } = useLoad<DocumentRecord[]>(
    `/documents?q=${encodeURIComponent(q)}${orderId ? '&order_id=' + orderId : ''}${category ? '&category=' + category : ''}`,
  );
  const [preview, setPreview] = useState<DocumentRecord | null>(null);
  return (
    <>
      <section className="card">
        <div className="list-toolbar">
          <div className="local-search">
            <Search size={17} />
            <input
              placeholder="Файл, клиент или заказ…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Найти документ"
            />
          </div>
          <select
            aria-label="Категория документа"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="">Все категории</option>
            {Object.entries(documentCategories).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <div className="toolbar-spacer" />
          {orderId && user.role !== 'master' && (
            <button className="btn" onClick={() => open('generate_documents', { id: orderId })}>
              <FileText size={16} />
              Создать документы
            </button>
          )}
          <button className="btn dark" onClick={() => open('document', { order_id: orderId })}>
            <Upload size={16} /> Прикрепить
          </button>
        </div>
        {data ? (
          data.length ? (
            <div className="document-grid">
              {data.map((d) => (
                <article className="document-card" key={d.id}>
                  <div className={'file-icon ' + d.category}>
                    <FileText size={25} />
                  </div>
                  <div className="doc-info">
                    <span className="eyebrow">
                      {documentCategories[d.category]} · V{d.version}
                    </span>
                    <h3 title={d.name}>{d.name}</h3>
                    <p>
                      {d.order_number} · {d.client_name}
                    </p>
                    <small>
                      {(d.size / 1024).toFixed(0)} КБ · {dateLabel(d.created_at)} · {d.author_name}
                    </small>
                  </div>
                  <div className="document-actions">
                    {/\.(pdf|png|jpe?g)$/i.test(d.name) && (
                      <button className="text-btn" onClick={() => setPreview(d)}>
                        Открыть
                      </button>
                    )}
                    <a
                      className="icon-btn"
                      href={'/api/documents/' + d.id + '/download'}
                      aria-label="Скачать"
                    >
                      <Download size={17} />
                    </a>
                    <button
                      className="icon-btn"
                      onClick={() => open('document', { ...d, document_id: d.id })}
                      aria-label="Загрузить новую версию"
                    >
                      <Upload size={16} />
                    </button>
                  </div>
                  {['owner', 'manager'].includes(user.role) &&
                    d.versions &&
                    d.versions.length > 1 && (
                      <details className="document-versions">
                        <summary>История версий ({d.versions.length})</summary>
                        {d.versions.map((v) => (
                          <a
                            key={v.version}
                            href={`/api/documents/${d.id}/download?version=${v.version}`}
                          >
                            Версия {v.version} · {dateLabel(v.created_at)} <Download size={13} />
                          </a>
                        ))}
                      </details>
                    )}
                </article>
              ))}
            </div>
          ) : (
            <Empty
              title="Документов пока нет"
              text="Загрузите договор, эскиз, фотографию или чек."
            />
          )
        ) : (
          <LoadState error={error} />
        )}
      </section>
      {preview && (
        <Modal title={preview.name} onClose={() => setPreview(null)} wide>
          {/\.(png|jpe?g)$/i.test(preview.name) ? (
            <img
              className="document-preview"
              src={`/api/documents/${preview.id}/download?preview=1`}
              alt={preview.name}
            />
          ) : (
            <iframe
              className="pdf-preview"
              title={preview.name}
              src={`/api/documents/${preview.id}/download?preview=1`}
            />
          )}
          <a className="btn" href={`/api/documents/${preview.id}/download`}>
            Скачать оригинал
          </a>
        </Modal>
      )}
    </>
  );
}
export function Finance({ period, order }: { period: string; order?: Order }) {
  const { open, refresh, notify, navigate } = useApp();
  const [tab, setTab] = useState('movements');
  const { data, error } = useLoad<any>(
    `/finance?period=${period}${order ? '&order_id=' + order.id : ''}`,
  );
  if (!data) return <LoadState error={error} />;
  const s = data.summary;
  return (
    <>
      {!order && (
        <div className="stat-grid four">
          <Stat
            label="Поступления"
            value={money(s.receipts)}
            note="Подтверждённые оплаты − возвраты"
            accent
          />
          <Stat label="Выплаты" value={money(s.payouts)} note="Оплаты ранее учтённых расходов" />
          <Stat label="Денежный поток" value={money(s.cashflow)} note="Поступления минус выплаты" />
          <Stat
            label="Доступно денег"
            value={money(s.available)}
            note="Баланс на конец месяца − резервы"
          />
        </div>
      )}
      <section className="card">
        <div className="list-toolbar">
          <div className="tabs compact-tabs">
            {[
              ['movements', 'Деньги'],
              ['expenses', 'Расходы'],
              ...(!order
                ? [
                    ['debts', 'Долги клиентов'],
                    ['taxes', 'Налоговый резерв'],
                  ]
                : []),
            ].map(([v, l]) => (
              <button className={tab === v ? 'active' : ''} key={v} onClick={() => setTab(v)}>
                {l}
              </button>
            ))}
          </div>
          <div className="toolbar-spacer" />
          <button className="btn" onClick={() => open('expense', { order_id: order?.id })}>
            <Plus size={16} /> Расход
          </button>
          <button
            className="btn dark"
            onClick={() => open('payment', order ? { order_id: order.id, order } : {})}
          >
            <Plus size={16} /> Поступление
          </button>
        </div>
        {tab === 'movements' && (
          <>
            {data.movements.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>ОПЕРАЦИЯ</th>
                      <th>ЗАКАЗ / СТАТЬЯ</th>
                      <th>ДАТА</th>
                      <th>СПОСОБ / СЧЁТ</th>
                      <th>СУММА</th>
                      <th>СТАТУС</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.movements.map((m: any) => (
                      <tr key={m.id}>
                        <td>
                          <span className="person-cell">
                            <span className={'movement-icon ' + m.kind}>
                              {m.kind === 'receipt' ? (
                                <ArrowDownLeft size={17} />
                              ) : (
                                <ArrowUpRight size={17} />
                              )}
                            </span>
                            <span>
                              <b>
                                {
                                  (
                                    {
                                      receipt: 'Поступление',
                                      refund: 'Возврат клиенту',
                                      expense_payment: 'Оплата расхода',
                                    } as any
                                  )[m.kind]
                                }
                              </b>
                              <small className="cell-sub">{m.note || m.author_name}</small>
                            </span>
                          </span>
                        </td>
                        <td>{m.order_number || m.expense_category || 'Общий расход'}</td>
                        <td>{dateLabel(m.occurred_on)}</td>
                        <td>
                          {m.method}
                          <small className="cell-sub">{m.account}</small>
                        </td>
                        <td className={m.kind === 'receipt' ? 'positive' : 'negative'}>
                          {m.kind === 'receipt' ? '+' : '−'}
                          {money(m.amount)}
                        </td>
                        <td>
                          {m.status === 'confirmed' ? (
                            <span className="badge done">Подтверждён</span>
                          ) : (
                            <button
                              className="btn small"
                              onClick={async () => {
                                try {
                                  await post('/movements/' + m.id + '/confirm', {});
                                  refresh();
                                } catch (e: any) {
                                  notify(e.message);
                                }
                              }}
                            >
                              Провести черновик
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty
                title="Денежных операций нет"
                text={
                  order
                    ? 'Добавьте оплату клиента или оплатите расход.'
                    : 'За выбранный месяц поступлений и выплат пока нет.'
                }
              />
            )}
            <div className="inline-note">
              <CircleHelp size={16} /> Расход учитывается отдельно. В этом журнале — только движение
              денег.
            </div>
          </>
        )}
        {tab === 'expenses' && (
          <>
            {data.expenses.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>РАСХОД / ПОСТАВЩИК</th>
                      <th>ЗАКАЗ</th>
                      <th>ДАТА</th>
                      <th>ФАКТ ЗАТРАТ</th>
                      <th>ОПЛАЧЕНО</th>
                      <th>ОСТАЛОСЬ</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.expenses.map((e: Expense) => (
                      <tr key={e.id}>
                        <td>
                          <b>
                            {e.category}
                            {e.tax_payment ? ' · налог' : ''}
                          </b>
                          <small className="cell-sub">{e.supplier || e.notes || '—'}</small>
                        </td>
                        <td>{e.order_number || 'Общий расход'}</td>
                        <td>{dateLabel(e.incurred_on)}</td>
                        <td>{money(e.amount)}</td>
                        <td>{money(e.paid)}</td>
                        <td className={e.outstanding ? 'overdue' : ''}>{money(e.outstanding)}</td>
                        <td>
                          <div className="expense-actions">
                            <button className="text-btn" onClick={() => open('expense', e)}>
                              Изменить
                            </button>
                            {e.outstanding > 0 && (
                              <button className="btn small" onClick={() => open('expensePay', e)}>
                                Оплатить
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title="Расходов пока нет" />
            )}
            <div className="inline-note">
              <CircleHelp size={16} /> Все расходы компании на текущий момент. Неоплаченный расход
              уже включён в затраты.
            </div>
          </>
        )}
        {tab === 'debts' && <OrderTable orders={data.debts} />}{' '}
        {tab === 'taxes' && (
          <div className="tax-panel">
            <div className="tax-overview">
              <div>
                <span className="eyebrow">ОЦЕНОЧНЫЙ РЕЗЕРВ / {period}</span>
                <h2>{money(s.tax_reserve)}</h2>
                <p>
                  База {money(s.tax_base)} · ставка {(s.tax_rate_bps / 100).toLocaleString('ru-RU')}
                  %
                </p>
                <p className="muted">
                  Резерв помогает отложить деньги. Итоговую сумму налога определяет бухгалтер.
                </p>
              </div>
              <button
                className="btn primary"
                onClick={() =>
                  open('tax', {
                    period,
                    summary: s,
                    movements: data.movements,
                    expenses: data.expenses,
                  })
                }
              >
                Зафиксировать / изменить
              </button>
            </div>
            <h3>Журнал резервов</h3>
            {data.taxes.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>ПЕРИОД</th>
                      <th>БАЗА</th>
                      <th>РЕЗЕРВ</th>
                      <th>КОРРЕКТИРОВКА</th>
                      <th>СТАТУС</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.taxes.map((t: any) => (
                      <tr key={t.id}>
                        <td>{t.period}</td>
                        <td>{money(t.base_amount)}</td>
                        <td>{money(Math.max(0, t.calculated_amount + t.adjustment))}</td>
                        <td>
                          {money(t.adjustment)}
                          <small className="cell-sub">{t.reason}</small>
                        </td>
                        <td>
                          <span className={'badge ' + (t.status === 'paid' ? 'done' : 'waiting')}>
                            {t.status === 'paid' ? 'Фактически оплачен' : 'Отложено'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">Зафиксированных резервов ещё нет.</p>
            )}
          </div>
        )}
      </section>
    </>
  );
}
function Reports({ period }: { period: string }) {
  const { data, error } = useLoad<any>('/finance?period=' + period);
  if (!data) return <LoadState error={error} />;
  const s = data.summary;
  return (
    <>
      <div className="report-actions">
        <a className="btn dark" href={'/api/reports/export?period=' + period}>
          <Download size={16} /> Скачать Excel
        </a>
        <button className="btn" onClick={() => window.print()}>
          <FileText size={16} /> Сохранить PDF
        </button>
      </div>
      <div className="report-grid">
        <section className="card">
          <div className="card-heading">
            <h2>Прибыльность за {period}</h2>
            <span className="chip">Закрыто {s.closed_count} заказов</span>
          </div>
          <div className="report-lines">
            {[
              ['Выручка закрытых заказов', s.revenue],
              ['Прямые затраты этих заказов', -s.direct_cost],
              ['Валовая прибыль', s.gross_profit],
              ['Общие расходы периода', -s.overhead],
            ].map(([l, v]) => (
              <div key={l}>
                <span>{l}</span>
                <b>{money(v as number)}</b>
              </div>
            ))}
            <div className="report-total">
              <span>Управленческая прибыль до налогов</span>
              <b>{money(s.management_profit)}</b>
            </div>
          </div>
          <p className="muted">
            Прямые затраты пересчитываются по актуальным данным заказов. Общие расходы по заказам
            автоматически не распределяются.
          </p>
        </section>
        <section className="card">
          <div className="card-heading">
            <h2>Движение денег</h2>
            <Wallet size={20} />
          </div>
          <div className="report-lines">
            {[
              ['Поступления за вычетом возвратов', s.receipts],
              ['Денежные выплаты', -s.payouts],
              ['Чистый денежный поток', s.cashflow],
              ['Баланс на конец периода', s.balance],
              ['Зарезервировано', s.reserved_total],
            ].map(([l, v]) => (
              <div key={l}>
                <span>{l}</span>
                <b>{money(v as number)}</b>
              </div>
            ))}
            <div className="report-total">
              <span>Доступно после резервов</span>
              <b>{money(s.available)}</b>
            </div>
          </div>
          <p className="muted">
            Денежный поток и прибыль отвечают на разные вопросы. Налоговый резерв пока не является
            выплатой.
          </p>
        </section>
      </div>
      <section className="card">
        <div className="card-heading">
          <h2>Задолженность клиентов</h2>
          <strong>{money(s.debt)}</strong>
        </div>
        <OrderTable orders={data.debts} />
        <div className="inline-note">
          Долги показаны на текущий момент, включая закрытые заказы.
        </div>
      </section>
    </>
  );
}
function History({ orderId }: { orderId: string }) {
  const { data, error } = useLoad<any[]>('/orders/' + orderId + '/history');
  return (
    <section className="card">
      <div className="card-heading">
        <h2>История изменений</h2>
        <ShieldCheck size={20} />
      </div>
      {data ? (
        data.map((a) => (
          <details className="audit-item" key={a.id}>
            <summary>
              <span className="audit-dot" />
              <span>
                <b>{auditActionLabel(a.action)}</b>
                <small>
                  {a.author_name} · {new Date(a.created_at).toLocaleString('ru-RU')}
                </small>
              </span>
              <ChevronDown size={16} />
            </summary>
            <div className="audit-data">
              <div>
                <b>До изменения</b>
                <AuditValues value={a.before_data} />
              </div>
              <div>
                <b>После изменения</b>
                <AuditValues value={a.after_data} />
              </div>
            </div>
          </details>
        ))
      ) : (
        <LoadState error={error} />
      )}
    </section>
  );
}
function Profile({
  logout,
  onSaved,
}: {
  logout: () => Promise<void>;
  onSaved: (s?: string) => void;
}) {
  const { user } = useApp();
  const [current, setCurrent] = useState(''),
    [password, setPassword] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <>
      <div className="profile-summary">
        <span className="avatar large">{user.name[0]}</span>
        <div>
          <h3>{user.name}</h3>
          <p>
            {user.email} · {roleLabels[user.role]}
          </p>
        </div>
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await post('/auth/password', { current, password });
            onSaved('Пароль изменён. Войдите заново.');
            await logout();
          } catch (e: any) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <h3>Изменить пароль</h3>
        <label>
          Текущий пароль
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
            autoComplete="current-password"
          />
        </label>
        <label>
          Новый пароль · минимум 12 символов
          <input
            type="password"
            minLength={12}
            maxLength={128}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="new-password"
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="form-actions">
          <button
            type="button"
            className="btn"
            onClick={async () => {
              onSaved();
              await logout();
            }}
          >
            <LogOut size={16} /> Выйти
          </button>
          <button className="btn primary" disabled={busy}>
            Изменить пароль
          </button>
        </div>
      </form>
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
