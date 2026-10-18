import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import argon2 from 'argon2';
import * as XLSX from '@e965/xlsx';
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.includes('test'))
  throw new Error(
    'Set TEST_DATABASE_URL to a dedicated database with "test" in its name. This suite clears that database.',
  );
process.env.DATABASE_URL = testUrl;
process.env.COOKIE_SECURE = 'false';
process.env.APP_ORIGIN = 'http://localhost:3001';
const dir = await mkdtemp(join(tmpdir(), 'looma-api-test-'));
process.env.STORAGE_DIR = dir;
const { pool } = await import('../server/db.js');
const { migrate } = await import('../server/migrate.js');
const { buildApp } = await import('../server/app.js');
let app: Awaited<ReturnType<typeof buildApp>>;
const sessions: Record<string, string> = {},
  users: Record<string, any> = {};
let client: any, order: any, expense: any, doc: any, secondVersion: any;
const today = '2026-10-17',
  password = 'Test-Password-2026-Local';
async function call(
  method: any,
  url: string,
  body: any = undefined,
  role = 'owner',
  expected = 200,
) {
  const response = await app.inject({
    method,
    url: '/api' + url,
    headers: {
      'x-looma-client': 'web',
      origin: 'http://localhost:3001',
      ...(sessions[role] ? { cookie: sessions[role] } : {}),
    },
    ...(body === undefined ? {} : { payload: body }),
  });
  assert.equal(response.statusCode, expected, `${method} ${url}: ${response.body}`);
  return response.headers['content-type']?.includes('json') ? response.json() : response;
}
function multi(filename: string, data: Buffer) {
  const boundary = 'looma-test-' + randomUUID();
  return {
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'x-looma-client': 'web',
      origin: 'http://localhost:3001',
      cookie: sessions.owner,
    },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}
async function file(url: string, name: string, bytes: Buffer, role = 'owner', expected = 200) {
  const form = multi(name, bytes);
  form.headers.cookie = sessions[role];
  const r = await app.inject({ method: 'POST', url: '/api' + url, ...form });
  assert.equal(r.statusCode, expected, r.body);
  return r.json();
}
const item = (model: string, price: number, quantity = 1) => ({
  kind: 'Диван',
  model,
  quantity,
  price,
  planned_cost: 0,
  dimensions: '200 × 100 × 90',
  fabric: 'Велюр',
  color: 'Бежевый',
  filling: 'ППУ',
  mechanism: 'Еврокнижка',
  notes: '',
});
before(
  async () => {
    await migrate();
    await pool.query(
      'TRUNCATE users,clients,orders,settings,import_jobs,audit_events,mutation_keys CASCADE',
    );
    await pool.query('INSERT INTO settings(id,data) VALUES(1,$1)', [
      {
        company_name: 'LOOMA Test',
        legal_details: '',
        timezone: 'Europe/Moscow',
        tax_regime: 'Не указан',
        tax_base: 'receipts',
        tax_rate_bps: 600,
        opening_balance: 0,
        manager_can_close: false,
        contract_approved: false,
        contract_template: null,
        max_file_mb: 25,
        storage_quota_mb: 1000,
        step_names: ['Каркас', 'Контроль качества', 'Доставка'],
      },
    ]);
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    for (const role of ['owner', 'manager', 'accountant', 'master']) {
      users[role] = (
        await pool.query(
          'INSERT INTO users(name,email,role,password_hash) VALUES($1,$2,$3,$4) RETURNING *',
          [role, `${role}@test.local`, role, hash],
        )
      ).rows[0];
    }
    app = await buildApp();
    for (const role of Object.keys(users)) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-looma-client': 'web', origin: 'http://localhost:3001' },
        payload: { email: `${role}@test.local`, password },
      });
      assert.equal(r.statusCode, 200, r.body);
      sessions[role] = String(r.headers['set-cookie']).split(';')[0];
    }
  },
  { timeout: 30000 },
);
after(async () => {
  await app?.close();
  await pool.end();
  await rm(dir, { recursive: true, force: true });
});
test('Авторизация, cookie и защита источника запроса', async () => {
  const a = await app.inject({ url: '/api/orders' });
  assert.equal(a.statusCode, 401);
  await call('POST', '/auth/login', { email: 'owner@test.local', password: 'wrong' }, 'none', 401);
  const b = await app.inject({
    method: 'POST',
    url: '/api/clients',
    headers: { cookie: sessions.owner, origin: 'https://example.invalid', 'x-looma-client': 'web' },
    payload: {},
  });
  assert.equal(b.statusCode, 403);
  const c = await app.inject({
    method: 'POST',
    url: '/api/clients',
    headers: { cookie: sessions.owner },
    payload: {},
  });
  assert.equal(c.statusCode, 403);
  assert.match(sessions.owner, /looma_session=/);
});
test('AC-02: клиент, два изделия, скидка и уникальный номер', async () => {
  client = await call('POST', '/clients', {
    name: 'Тестовый клиент',
    phone: '+7 (999) 100-20-30',
    address: 'Москва',
  });
  const k = randomUUID(),
    body = {
      client_id: client.id,
      title: 'Тестовый заказ',
      due_date: today,
      manager_id: users.manager.id,
      master_id: users.master.id,
      discount: 100000,
      items: [item('Луна', 6000000), item('Облако', 3100000, 2)],
      idempotency_key: k,
    };
  const a = await call('POST', '/orders', body);
  const repeat = await call('POST', '/orders', body);
  assert.equal(a.id, repeat.id);
  order = await call('GET', '/orders/' + a.id);
  assert.equal(order.total, 12100000);
  assert.equal(order.items.length, 2);
  assert.equal(order.paid, 0);
  assert.equal(order.debt, 12100000);
  await call('POST', '/clients', { name: 'Дубль', phone: '79991002030' }, 'owner', 409);
});
test('AC-01: финансы скрыты у мастера, менеджер получает полный рабочий доступ', async () => {
  await call('GET', '/finance', undefined, 'master', 403);
  const o = await call('GET', '/orders/' + order.id, undefined, 'master');
  for (const k of [
    'total',
    'paid',
    'debt',
    'gross_profit',
    'actual_cost',
    'planned_cost',
    'discount',
  ])
    assert.equal(o[k], undefined, k);
  for (const i of o.items) {
    assert.equal(i.price, undefined);
    assert.equal(i.planned_cost, undefined);
  }
  const list = await call('GET', '/orders', undefined, 'master');
  assert.equal(list.items[0].gross_profit, undefined);
  const d = await call('GET', '/dashboard', undefined, 'master');
  assert.equal(d.summary, null);
  assert.deepEqual(d.chart, []);
  const m = await call('GET', '/orders/' + order.id, undefined, 'manager');
  assert.equal(m.total, 12100000);
  assert.equal(m.actual_cost, 0);
  assert.equal(m.items[0].planned_cost, 0);
  await call('GET', '/finance', undefined, 'manager');
  await call('GET', '/orders/' + order.id + '/history', undefined, 'manager');
  await call('GET', '/settings', undefined, 'manager', 403);
  await call('GET', '/settings/max', undefined, 'manager', 403);
});
test('AC-03: аванс уменьшает долг и не изменяет валовую прибыль', async () => {
  const b = { amount: 6000000, occurred_on: today, idempotency_key: randomUUID() };
  const p = await call('POST', '/orders/' + order.id + '/payments', b);
  const repeat = await call('POST', '/orders/' + order.id + '/payments', b);
  assert.equal(p.id, repeat.id);
  const o = await call('GET', '/orders/' + order.id);
  assert.equal(o.paid, 6000000);
  assert.equal(o.debt, 6100000);
  assert.equal(o.gross_profit, 12100000);
  await call('POST', '/orders/' + order.id + '/payments', { ...b, amount: 1 }, 'owner', 409);
});
test('AC-04 и AC-05: расход уменьшает прибыль один раз, оплата меняет только денежный поток', async () => {
  expense = await call('POST', '/expenses', {
    order_id: order.id,
    category: 'Ткань',
    supplier: 'Фабрика',
    amount: 1000000,
    incurred_on: today,
    idempotency_key: randomUUID(),
  });
  let o = await call('GET', '/orders/' + order.id);
  assert.equal(o.actual_cost, 1000000);
  assert.equal(o.gross_profit, 11100000);
  let fin = await call('GET', '/finance?period=2026-10');
  assert.equal(fin.summary.cashflow, 6000000);
  await call('POST', '/expenses/' + expense.id + '/payments', {
    amount: 400000,
    occurred_on: today,
    idempotency_key: randomUUID(),
  });
  o = await call('GET', '/orders/' + order.id);
  assert.equal(o.actual_cost, 1000000);
  fin = await call('GET', '/finance?period=2026-10');
  assert.equal(fin.summary.cashflow, 5600000);
  assert.equal(fin.expenses[0].outstanding, 600000);
  await call(
    'POST',
    '/expenses/' + expense.id + '/payments',
    { amount: 700000, occurred_on: today, idempotency_key: randomUUID() },
    'owner',
    400,
  );
});
test('AC-06: возврат, защита от избыточного возврата и черновик', async () => {
  await call('POST', '/orders/' + order.id + '/payments', {
    kind: 'refund',
    amount: 500000,
    occurred_on: today,
    idempotency_key: randomUUID(),
  });
  let o = await call('GET', '/orders/' + order.id);
  assert.equal(o.paid, 5500000);
  assert.equal(o.debt, 6600000);
  assert.equal(o.gross_profit, 11100000);
  await call(
    'POST',
    '/orders/' + order.id + '/payments',
    { kind: 'refund', amount: 6000000, occurred_on: today, idempotency_key: randomUUID() },
    'owner',
    400,
  );
  const draft = await call('POST', '/orders/' + order.id + '/payments', {
    amount: 100000,
    status: 'draft',
    occurred_on: today,
    idempotency_key: randomUUID(),
  });
  o = await call('GET', '/orders/' + order.id);
  assert.equal(o.paid, 5500000);
  await call('POST', '/movements/' + draft.id + '/confirm', {});
  o = await call('GET', '/orders/' + order.id);
  assert.equal(o.paid, 5600000);
});
test('AC-07: защищённые документы и сохранение предыдущей версии', async () => {
  const pdf = Buffer.from('%PDF-1.4\nLOOMA test v1\n%%EOF');
  doc = await file(
    `/documents?order_id=${order.id}&category=contract&visibility=commercial`,
    'contract.pdf',
    pdf,
  );
  const rows = await call('GET', '/documents?order_id=' + order.id);
  assert.equal(rows[0].versions.length, 1);
  await call('GET', '/documents/' + doc.id + '/download', undefined, 'master', 403);
  const unauth = await app.inject({ url: '/api/documents/' + doc.id + '/download' });
  assert.equal(unauth.statusCode, 401);
  secondVersion = await file(
    `/documents?order_id=${order.id}&category=contract&visibility=commercial&document_id=${doc.id}&version=1`,
    'contract-v2.pdf',
    Buffer.from('%PDF-1.4\nLOOMA test v2\n%%EOF'),
  );
  assert.equal(secondVersion.version, 2);
  const old = await call('GET', '/documents/' + doc.id + '/download?version=1');
  assert.equal(old.rawPayload.toString(), pdf.toString());
  await call('GET', '/documents/' + doc.id + '/download?version=1', undefined, 'manager');
  await file(
    `/documents?order_id=${order.id}&category=contract&visibility=commercial`,
    'fake.pdf',
    Buffer.from('<script>alert(1)</script>'),
    'owner',
    400,
  );
});
test('Мастер видит только назначенные заказы, задачи и технические файлы', async () => {
  const other = await call('POST', '/orders', {
    client_id: client.id,
    title: 'Чужой заказ',
    due_date: today,
    manager_id: users.owner.id,
    master_id: null,
    items: [item('Иное', 100000)],
    idempotency_key: randomUUID(),
  });
  await call('GET', '/orders/' + other.id, undefined, 'master', 403);
  const t = await call('POST', '/tasks', {
    title: 'Собрать каркас',
    order_id: order.id,
    assignee_id: users.master.id,
    due_at: today + 'T18:00:00+03:00',
  });
  const ts = await call('GET', '/tasks?scope=team', undefined, 'master');
  assert.ok(ts.some((x: any) => x.id === t.id));
  await call('PATCH', '/tasks/' + t.id, { status: 'doing', version: t.version }, 'master');
  await call('POST', '/tasks/' + t.id + '/comments', { text: 'Готовлю материалы' }, 'master');
  await file(
    `/documents?order_id=${order.id}&category=sketch&visibility=technical`,
    'sketch.pdf',
    Buffer.from('%PDF-1.4\nSketch\n%%EOF'),
    'master',
  );
  const docs = await call('GET', '/documents', undefined, 'master');
  assert.ok(docs.every((d: any) => d.visibility === 'technical'));
  await call(
    'POST',
    '/tasks',
    {
      title: 'Чужая задача',
      order_id: other.id,
      assignee_id: users.master.id,
      due_at: today + 'T18:00:00+03:00',
    },
    'owner',
    400,
  );
});
test('AC-10: закрытие с долгом и AC-11: аудит цены, конфликт версии', async () => {
  order = await call('GET', '/orders/' + order.id);
  await call(
    'PATCH',
    '/orders/' + order.id,
    { version: order.version, status: 'closed', handed_over: true },
    'manager',
  );
  let o = await call('GET', '/orders/' + order.id);
  assert.equal(o.status, 'closed');
  assert.equal(o.debt, 6500000);
  await call(
    'PATCH',
    '/orders/' + order.id,
    { version: order.version, title: 'Устаревшая правка' },
    'owner',
    409,
  );
  await call('PATCH', '/orders/' + order.id, { version: o.version, discount: 200000 });
  o = await call('GET', '/orders/' + order.id);
  assert.equal(o.total, 12000000);
  const audit = await call('GET', '/orders/' + order.id + '/history');
  assert.ok(
    audit.some(
      (a: any) =>
        a.action === 'updated' &&
        a.before_data.discount === 100000 &&
        a.after_data.discount === 200000,
    ),
  );
  const r = await call('GET', '/finance?period=' + new Date().toISOString().slice(0, 7));
  assert.equal(r.summary.management_profit, 11000000);
});
test('Резерв не является выплатой, общие затраты не удваиваются', async () => {
  await call('POST', '/expenses', {
    category: 'Аренда',
    amount: 1000000,
    incurred_on: today,
    idempotency_key: randomUUID(),
  });
  const a = await call('GET', '/finance?period=2026-10');
  assert.equal(a.summary.receipts, 5600000);
  assert.equal(a.summary.payouts, 400000);
  assert.equal(a.summary.tax_reserve, 336000);
  await call('POST', '/tax-reservations', {
    period: '2026-10',
    adjustment: 10000,
    reason: 'Запас',
  });
  const b = await call('GET', '/finance?period=2026-10');
  assert.equal(b.summary.tax_reserve, 346000);
  assert.equal(b.summary.payouts, a.summary.payouts);
  assert.equal(b.summary.available, b.summary.balance - 346000);
  await call(
    'POST',
    '/tax-reservations',
    { period: '2026-10', adjustment: 1, reason: '' },
    'owner',
    400,
  );
  await call('POST', '/tax-reservations', { period: '2026-10', status: 'paid' }, 'owner', 400);
});
test('AC-09: XLSX, сопоставление, ошибки и запрет повторного импорта', async () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['ФИО', 'Телефон'],
      ['Первый импорт', '79998887766'],
      ['Ошибка', 'abc'],
      ['Тестовый клиент', '79991002030'],
    ]),
    'Клиенты',
  );
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const j = await file('/imports/inspect?kind=clients', 'clients.xlsx', buf);
  const p = await call('POST', '/imports/preview', {
    id: j.id,
    sheet: 'Клиенты',
    mapping: { name: 'ФИО', phone: 'Телефон' },
  });
  assert.equal(p.valid, 1);
  assert.equal(p.duplicates, 1);
  assert.equal(p.errors, 1);
  const r = await call('POST', '/imports/confirm', { id: j.id });
  assert.equal(r.clients, 1);
  const again = await call('POST', '/imports/confirm', { id: j.id });
  assert.equal(again.already_confirmed, true);
  const j2 = await file('/imports/inspect?kind=clients', 'clients.xlsx', buf);
  assert.equal(j2.already_imported, true);
  await call('POST', '/imports/preview', {
    id: j2.id,
    sheet: 'Клиенты',
    mapping: { name: 'ФИО', phone: 'Телефон' },
  });
  await call('POST', '/imports/confirm', { id: j2.id }, 'owner', 409);
});
test('Старый XLS, импорт заказов с несколькими статьями затрат', async () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['ФИО', 'Телефон', 'Изделие', 'Стоимость', 'Дата', 'Ткань', 'Работа'],
      ['Новый клиент XLS', '79998887755', 'Диван XLS', 120000, today, 10000, 5000],
    ]),
    'Заказы',
  );
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'biff8' });
  const j = await file('/imports/inspect?kind=orders', 'orders.xls', buf);
  const p = await call('POST', '/imports/preview', {
    id: j.id,
    sheet: 'Заказы',
    mapping: {
      client_name: 'ФИО',
      phone: 'Телефон',
      title: 'Изделие',
      price: 'Стоимость',
      due_date: 'Дата',
      fabric_cost: 'Ткань',
      labor_cost: 'Работа',
    },
  });
  assert.equal(p.valid, 1, JSON.stringify(p));
  const r = await call('POST', '/imports/confirm', { id: j.id });
  assert.equal(r.orders, 1);
  assert.equal(r.clients, 1);
  assert.equal(r.expenses, 2);
  const o = (await call('GET', '/orders?q=Диван%20XLS')).items[0];
  assert.equal(o.total, 12000000);
  assert.equal(o.actual_cost, 1500000);
  assert.equal(o.paid, 0);
});
test('Шаблон DOCX требует утверждения, договор сохраняется в заказе', async () => {
  await call(
    'POST',
    '/orders/' + order.id + '/contract',
    { payment_terms: '50% / 50%', contract_date: today },
    'owner',
    400,
  );
  const bytes = await readFile('docs/contract-template.docx');
  await file('/settings/contract-template', 'template.docx', bytes);
  const s = await call('GET', '/settings');
  await call('PATCH', '/settings', { ...s.data, version: s.version, contract_approved: true });
  const c = await call(
    'POST',
    '/orders/' + order.id + '/contract',
    { payment_terms: '50% / 50%', contract_date: today },
    'manager',
  );
  const download = await call('GET', '/documents/' + c.id + '/download', undefined, 'manager');
  assert.ok(download.rawPayload.length > 1000);
});
test('Приглашение, роли, смена пароля и отзыв сессий', async () => {
  const i = await call('POST', '/users/invite', {
    email: 'new@test.local',
    name: 'Новый мастер',
    role: 'master',
  });
  const token = new URL(i.link).searchParams.get('invite');
  await call('POST', '/auth/accept-invite', { token, password: 'New-user-password-2026' }, 'none');
  await call(
    'POST',
    '/auth/accept-invite',
    { token, password: 'New-user-password-2026' },
    'none',
    410,
  );
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'x-looma-client': 'web' },
    payload: { email: 'new@test.local', password: 'New-user-password-2026' },
  });
  assert.equal(login.statusCode, 200);
  sessions.new = String(login.headers['set-cookie']).split(';')[0];
  const u = login.json();
  await call('PATCH', '/users/' + u.id, { role: 'master', active: false });
  await call('GET', '/auth/me', undefined, 'new', 401);
  await call(
    'POST',
    '/auth/password',
    { current: password, password: 'Changed-password-2026' },
    'accountant',
  );
  await call('GET', '/auth/me', undefined, 'accountant', 401);
});
test('Отчёт Excel доступен только финансовым ролям; аудит неизменяем', async () => {
  const r = await call('GET', '/reports/export?period=2026-10');
  const wb = XLSX.read(r.rawPayload, { type: 'buffer' });
  assert.equal(wb.SheetNames.length, 3);
  await call('GET', '/reports/export?period=2026-10', undefined, 'master', 403);
  await assert.rejects(pool.query("UPDATE audit_events SET action='changed'"), /append-only/);
});
test('Уточнение расхода сохраняет оплаченный остаток и проверяет версию', async () => {
  const rows = await call('GET', '/finance?period=2026-10');
  const e = rows.expenses.find((x: any) => x.id === expense.id);
  const updated = await call('PATCH', '/expenses/' + e.id, {
    version: e.version,
    category: e.category,
    supplier: 'Уточнённый поставщик',
    amount: 1100000,
    incurred_on: today,
    notes: 'Уточнён счёт',
  });
  assert.equal(updated.amount, 1100000);
  await call(
    'PATCH',
    '/expenses/' + e.id,
    {
      version: e.version,
      category: e.category,
      supplier: 'Конфликт',
      amount: 1000000,
      incurred_on: today,
      notes: '',
    },
    'owner',
    409,
  );
  await call(
    'PATCH',
    '/expenses/' + e.id,
    {
      version: updated.version,
      category: e.category,
      supplier: 'Ошибка',
      amount: 100,
      incurred_on: today,
      notes: '',
    },
    'owner',
    400,
  );
});
test('Одновременные повторы платежа не создают дубли', async () => {
  const b = { amount: 10000, occurred_on: today, idempotency_key: randomUUID() };
  const a = await Promise.all([
    call('POST', '/orders/' + order.id + '/payments', b),
    call('POST', '/orders/' + order.id + '/payments', b),
  ]);
  assert.equal(a[0].id, a[1].id);
  const p = await pool.query(
    'SELECT count(*)::int n FROM money_movements WHERE idempotency_key=$1',
    [b.idempotency_key],
  );
  assert.equal(p.rows[0].n, 1);
});
test('Менеджер меняет цену закрытого заказа; старые суммы остаются в аудите', async () => {
  const o = await call('GET', '/orders/' + order.id);
  await call('PATCH', '/orders/' + o.id, { version: o.version, discount: 300000 }, 'manager');
  assert.equal((await call('GET', '/orders/' + o.id)).discount, 300000);
  const history = await call('GET', '/orders/' + o.id + '/history');
  assert.ok(
    history.some(
      (a: any) =>
        a.action === 'updated' &&
        a.before_data.total === 12100000 &&
        a.after_data.total === 12000000,
    ),
  );
});
test('Редактирование задачи, смена срока и защита мастера', async () => {
  const tasks = await call('GET', '/tasks?scope=team');
  const t = tasks.find((v: any) => v.assignee_id === users.master.id);
  await call('PATCH', '/tasks/' + t.id, {
    version: t.version,
    title: 'Новое название',
    due_at: '2026-10-20T15:00:00+03:00',
  });
  const current = (await call('GET', '/tasks?scope=mine', undefined, 'master')).find(
    (v: any) => v.id === t.id,
  );
  assert.equal(current.title, 'Новое название');
  await call(
    'PATCH',
    '/tasks/' + t.id,
    { version: current.version, title: 'Не согласовано' },
    'master',
    403,
  );
});
test('Импорт переключает лист и возвращает его собственные заголовки', async () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['ФИО', 'Телефон'],
      ['Один', '79994443322'],
    ]),
    'Первый',
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['Заказчик', 'Номер телефона'],
      ['Два', '79994443311'],
    ]),
    'Второй',
  );
  const j = await file(
    '/imports/inspect?kind=clients',
    'two-sheets.xlsx',
    XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }),
  );
  const s = await call('GET', '/imports/' + j.id + '/sheet?sheet=' + encodeURIComponent('Второй'));
  assert.deepEqual(s.headers, ['Заказчик', 'Номер телефона']);
  const p = await call('POST', '/imports/preview', {
    id: j.id,
    sheet: 'Второй',
    mapping: s.mapping,
  });
  assert.equal(p.valid, 1);
});
test('Главная владельца возвращает финансовую сводку и реальные точки графика', async () => {
  const d = await call('GET', '/dashboard?period=2026-10');
  assert.equal(d.summary.period, '2026-10');
  assert.ok(d.chart.length > 0);
  assert.equal(d.chart[0].day, '2026-10-17');
  assert.equal(typeof d.chart[0].amount, 'number');
  assert.ok(d.orders.length > 0);
});
test('Приостановка и отмена исключают заказ, выплаты, долги, документы и задачи из общего учёта', async () => {
  const o = await call(
    'POST',
    '/orders',
    {
      client_id: client.id,
      title: 'Остановленный заказ',
      due_date: '2030-04-20',
      manager_id: users.manager.id,
      items: [item('Архив', 1000000)],
      idempotency_key: randomUUID(),
    },
    'manager',
  );
  await call(
    'POST',
    '/orders/' + o.id + '/payments',
    { amount: 400000, occurred_on: '2030-04-01', idempotency_key: randomUUID() },
    'manager',
  );
  await call(
    'POST',
    '/orders/' + o.id + '/payments',
    { kind: 'refund', amount: 50000, occurred_on: '2030-04-02', idempotency_key: randomUUID() },
    'manager',
  );
  const e = await call(
    'POST',
    '/expenses',
    {
      order_id: o.id,
      amount: 100000,
      category: 'Ткань',
      incurred_on: '2030-04-01',
      idempotency_key: randomUUID(),
    },
    'manager',
  );
  await call(
    'POST',
    '/expenses/' + e.id + '/payments',
    { amount: 50000, occurred_on: '2030-04-01', idempotency_key: randomUUID() },
    'manager',
  );
  const d = await file(
    `/documents?order_id=${o.id}&category=receipt&visibility=financial`,
    'archive.pdf',
    Buffer.from('%PDF-1.4\nArchive\n%%EOF'),
    'manager',
  );
  const t = await call(
    'POST',
    '/tasks',
    {
      title: 'Задача остановленного заказа',
      order_id: o.id,
      assignee_id: users.owner.id,
      due_at: '2030-04-19T12:00:00Z',
    },
    'manager',
  );
  await call('POST', '/tax-reservations', { period: '2030-04' }, 'manager');
  const before = await call('GET', '/finance?period=2030-04');
  assert.equal(before.summary.receipts, 350000);
  assert.equal(before.summary.payouts, 50000);
  assert.equal(before.summary.tax_reserve, 21000);
  let current = await call('GET', '/orders/' + o.id);
  await call(
    'PATCH',
    '/orders/' + o.id,
    { version: current.version, status: 'paused' },
    'manager',
    400,
  );
  for (const status of ['paused', 'cancelled']) {
    await call(
      'PATCH',
      '/orders/' + o.id,
      { version: current.version, status, reason: 'Клиент отложил' },
      'manager',
    );
    current = await call('GET', '/orders/' + o.id);
    const after = await call('GET', '/finance?period=2030-04');
    assert.equal(after.summary.receipts, 0);
    assert.equal(after.summary.payouts, 0);
    assert.equal(after.summary.tax_reserve, 0);
    assert.equal(after.summary.debt, before.summary.debt - 650000);
    assert.equal(after.summary.balance, before.summary.balance - 300000);
    assert.equal(after.summary.reserved_total, before.summary.reserved_total - 21000);
    assert.ok(!after.debts.some((x: any) => x.id === o.id));
    assert.ok(!after.expenses.some((x: any) => x.id === e.id));
    assert.ok(!after.movements.some((x: any) => x.order_number === o.number));
    assert.ok(!(await call('GET', '/orders')).items.some((x: any) => x.id === o.id));
    assert.ok((await call('GET', '/orders?scope=archive')).items.some((x: any) => x.id === o.id));
    assert.ok(!(await call('GET', '/documents')).some((x: any) => x.id === d.id));
    assert.ok(!(await call('GET', '/tasks?scope=team')).some((x: any) => x.id === t.id));
    assert.ok(
      (await call('GET', '/tasks?scope=team&order_id=' + o.id)).some((x: any) => x.id === t.id),
    );
    const dashboard = await call('GET', '/dashboard?period=2030-04');
    assert.ok(dashboard.counts.every((x: any) => !['paused', 'cancelled'].includes(x.status)));
    assert.deepEqual(dashboard.chart, []);
    assert.ok(!dashboard.orders.some((x: any) => x.id === o.id));
    const history = await call('GET', '/finance?period=2030-04&order_id=' + o.id);
    assert.equal(history.movements.length, 3);
    assert.equal(history.expenses[0].paid, 50000);
    await call('GET', '/documents/' + d.id + '/download', undefined, 'manager');
    const book = XLSX.read(
      (await call('GET', '/reports/export?period=2030-04', undefined, 'manager')).rawPayload,
    );
    assert.ok(
      !XLSX.utils
        .sheet_to_json<any>(book.Sheets['Заказы на текущую дату'])
        .some((x) => x.Номер === o.number),
    );
    assert.equal(XLSX.utils.sheet_to_json(book.Sheets['Движение денег']).length, 0);
  }
  await call('PATCH', '/orders/' + o.id, { version: current.version, status: 'new' }, 'manager');
  const restored = await call('GET', '/finance?period=2030-04');
  assert.equal(restored.summary.receipts, 350000);
  assert.equal(restored.summary.tax_reserve, 21000);
  assert.equal(restored.summary.debt, before.summary.debt);
});
function batchForm(entries: { name: string; data: Buffer }[], role = 'manager') {
  const boundary = 'looma-batch-' + randomUUID();
  return {
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'x-looma-client': 'web',
      origin: 'http://localhost:3001',
      cookie: sessions[role],
    },
    payload: Buffer.concat([
      ...entries.flatMap(({ name, data }) => [
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        ),
        data,
        Buffer.from('\r\n'),
      ]),
      Buffer.from(`--${boundary}--\r\n`),
    ]),
  };
}
test('Пакетная загрузка документов: оба файла доступны, ошибка и квота откатывают всю партию', async () => {
  const url = `/api/documents?order_id=${order.id}&category=receipt&visibility=financial`;
  const pdf = Buffer.from('%PDF-1.4\nBatch\n%%EOF');
  const entries = [
    { name: 'one.pdf', data: pdf },
    { name: 'two.pdf', data: pdf },
  ];
  const r = await app.inject({ method: 'POST', url, ...batchForm(entries) });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().documents.length, 2);
  for (const d of r.json().documents)
    assert.equal(
      (
        await call('GET', '/documents/' + d.id + '/download', undefined, 'manager')
      ).rawPayload.toString(),
      pdf.toString(),
    );
  const count = () =>
    pool.query(
      'SELECT (SELECT count(*)::int FROM documents) docs,(SELECT count(*)::int FROM file_blobs) blobs',
    );
  const before = (await count()).rows[0];
  const invalid = await app.inject({
    method: 'POST',
    url,
    ...batchForm([entries[0], { name: 'bad.pdf', data: Buffer.from('invalid') }]),
  });
  assert.equal(invalid.statusCode, 400, invalid.body);
  assert.deepEqual((await count()).rows[0], before);
  const tooMany = await app.inject({
    method: 'POST',
    url,
    ...batchForm(Array.from({ length: 11 }, (_, i) => ({ name: i + '.pdf', data: pdf }))),
  });
  assert.equal(tooMany.statusCode, 413, tooMany.body);
  assert.deepEqual((await count()).rows[0], before);
  const version = await app.inject({
    method: 'POST',
    url: url + `&document_id=${r.json().documents[0].id}&version=1`,
    ...batchForm(entries),
  });
  assert.equal(version.statusCode, 413, version.body);
  const used = (await pool.query('SELECT COALESCE(sum(size),0)::bigint n FROM file_blobs')).rows[0]
    .n;
  const old = (await pool.query('SELECT data FROM settings WHERE id=1')).rows[0].data;
  await pool.query(
    "UPDATE settings SET data=jsonb_set(data,'{storage_quota_mb}',$1::jsonb) WHERE id=1",
    [JSON.stringify((used + pdf.length + 1) / 1024 / 1024)],
  );
  try {
    const failed = await app.inject({ method: 'POST', url, ...batchForm(entries) });
    assert.equal(failed.statusCode, 400, failed.body);
    assert.deepEqual((await count()).rows[0], before);
  } finally {
    await pool.query('UPDATE settings SET data=$1 WHERE id=1', [old]);
  }
});
test('Менеджер видит все задачи команды, назначает бухгалтеру и создаёт отдельные задачи', async () => {
  const t = await call('POST', '/tasks', {
    title: 'Отдельная задача бухгалтеру',
    assignee_id: users.accountant.id,
    due_at: '2030-04-10T12:00:00Z',
  });
  const team = await call('GET', '/tasks?scope=team&kind=standalone', undefined, 'manager');
  assert.ok(team.some((x: any) => x.id === t.id));
  assert.ok(team.every((x: any) => x.order_id === null));
  await call(
    'PATCH',
    '/tasks/' + t.id,
    { version: t.version, title: 'Проверка менеджером', assignee_id: users.owner.id },
    'manager',
  );
  await call('POST', '/tasks/' + t.id + '/comments', { text: 'Согласовано' }, 'manager');
  const linked = await call('GET', '/tasks?scope=team&kind=order', undefined, 'manager');
  assert.ok(linked.every((x: any) => x.order_id !== null));
  await call(
    'POST',
    '/users/invite',
    { name: 'Test', email: 'new@test.local', role: 'manager' },
    'manager',
    403,
  );
  await call('PATCH', '/settings', {}, 'manager', 403);
  await call('PATCH', '/settings/max', {}, 'manager', 403);
  await call('POST', '/settings/max/discover', {}, 'manager', 403);
});
test('MAX: секрет не возвращается, очередь переживает ошибки и исключает устаревшие задачи', async () => {
  const max = await import('../server/max.js');
  const config = await call('GET', '/settings/max');
  const saved = await call('PATCH', '/settings/max', {
    version: config.version,
    enabled: true,
    token: 'test-max-token-never-real',
    reminder_minutes: 60,
  });
  assert.equal(saved.configured, true);
  assert.equal(saved.token, undefined);
  const recipient = await call('PATCH', '/settings/max/recipients/' + users.manager.id, {
    version: 0,
    enabled: true,
    max_user_id: '9223372036854775806',
  });
  assert.equal(recipient.max_user_id, '9223372036854775806');
  const create = (title: string, order_id: string | null = null) =>
    call('POST', '/tasks', {
      title,
      order_id,
      assignee_id: users.manager.id,
      due_at: new Date(Date.now() + 30 * 60000).toISOString(),
    });
  const t = await create('Отправить задачу в MAX');
  const c = await max.readMaxConfig();
  let sends: any[] = [];
  const ok: typeof fetch = async (input, init) => {
    sends.push({
      url: String(input),
      body: JSON.parse(String(init?.body)),
      headers: init?.headers,
    });
    return new Response('{"message":{"body":{"mid":"mock"}}}', { status: 200 });
  };
  await max.deliverTaskNotifications(c, ok);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].url, 'https://platform-api2.max.ru/messages?user_id=9223372036854775806');
  assert.equal(sends[0].headers.Authorization, 'test-max-token-never-real');
  assert.match(sends[0].body.text, /Отправить задачу в MAX/);
  assert.match(sends[0].body.text, /Отдельная задача/);
  await max.deliverTaskNotifications(c, ok);
  assert.equal(sends.length, 1);
  const stale = await create('Устарела до отправки');
  await call('PATCH', '/tasks/' + stale.id, { version: stale.version, title: 'Новая редакция' });
  await pool.query("UPDATE max_recipients SET next_send_at=now()-interval '1 second'");
  await max.deliverTaskNotifications(c, ok);
  assert.equal(sends.length, 2);
  assert.match(sends[1].body.text, /Новая редакция/);
  assert.equal(
    (
      await pool.query(
        'SELECT status FROM task_notifications WHERE task_id=$1 AND task_version=1',
        [stale.id],
      )
    ).rows[0].status,
    'cancelled',
  );
  const retry = await create('Повторить после обрыва');
  await pool.query("UPDATE max_recipients SET next_send_at=now()-interval '1 second'");
  await max.deliverTaskNotifications(c, async () => {
    throw new Error('network reset');
  });
  let n = (await pool.query('SELECT * FROM task_notifications WHERE task_id=$1', [retry.id]))
    .rows[0];
  assert.equal(n.status, 'pending');
  assert.equal(n.attempts, 1);
  assert.ok(n.error);
  await pool.query(
    "UPDATE task_notifications SET next_attempt_at=now()-interval '1 second' WHERE id=$1",
    [n.id],
  );
  await pool.query("UPDATE max_recipients SET next_send_at=now()-interval '1 second'");
  await max.deliverTaskNotifications(c, ok);
  assert.equal(
    (await pool.query('SELECT status FROM task_notifications WHERE id=$1', [n.id])).rows[0].status,
    'sent',
  );
  const linked = await create('Не отправлять для архива', order.id);
  const o = await call('GET', '/orders/' + order.id);
  await call('PATCH', '/orders/' + order.id, {
    version: o.version,
    status: 'paused',
    reason: 'Тест уведомлений',
  });
  await pool.query("UPDATE max_recipients SET next_send_at=now()-interval '1 second'");
  const count = sends.length;
  await max.deliverTaskNotifications(c, ok);
  assert.equal(sends.length, count);
  assert.equal(
    (await pool.query('SELECT status FROM task_notifications WHERE task_id=$1', [linked.id]))
      .rows[0].status,
    'cancelled',
  );
  await max.scheduleTaskReminders(pool, 60);
  await max.scheduleTaskReminders(pool, 60);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM task_notifications WHERE task_id=$1 AND kind='due'",
        [t.id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM task_notifications WHERE task_id=$1 AND kind IN ('due','overdue')",
        [linked.id],
      )
    ).rows[0].n,
    0,
  );
  const data = await call('GET', '/settings/max');
  assert.ok(!JSON.stringify(data).includes('test-max-token-never-real'));
  const audit = await call('GET', '/audit');
  assert.ok(!JSON.stringify(audit).includes('test-max-token-never-real'));
  const exact = await max.maxRequest(
    '/updates',
    c.token,
    {},
    async () => new Response('{"user_id":9223372036854775806}'),
  );
  assert.equal(exact.user_id, '9223372036854775806');
  await assert.rejects(
    max.maxRequest(
      '/messages',
      c.token,
      {},
      async () => new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }),
    ),
    (err: any) => err.retryAfter === 120 && !err.permanent,
  );
  await pool.query("UPDATE task_notifications SET status='cancelled' WHERE status='pending'");
  const denied = await create('Неверный токен не зацикливает отправку');
  await pool.query("UPDATE max_recipients SET next_send_at=now()-interval '1 second'");
  await max.deliverTaskNotifications(c, async () => new Response('{}', { status: 401 }));
  const failed = (
    await pool.query('SELECT * FROM task_notifications WHERE task_id=$1', [denied.id])
  ).rows[0];
  assert.equal(failed.status, 'failed');
  assert.equal(failed.attempts, 1);
  await max.deliverTaskNotifications(c, ok);
  assert.equal(
    (await pool.query('SELECT attempts FROM task_notifications WHERE id=$1', [failed.id])).rows[0]
      .attempts,
    1,
  );
});
test('Временный сбой базы возвращает 503, последующий запрос работает; loopback адреса равнозначны', async () => {
  const original = pool.query;
  try {
    (pool as any).query = () =>
      Promise.reject(Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }));
    await call('GET', '/health', undefined, 'none', 503);
  } finally {
    pool.query = original;
  }
  await call('GET', '/health', undefined, 'none');
  const r = await app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: { 'x-looma-client': 'web', origin: 'http://127.0.0.1:3001', cookie: sessions.owner },
  });
  assert.equal(r.statusCode, 200, r.body);
});
test(
  'Обрыв настоящего idle-соединения PostgreSQL не завершает сервер',
  { skip: process.env.TEST_NATIVE_PG !== '1', timeout: 15000 },
  async () => {
    const pg = (await import('pg')).default;
    const admin = new pg.Client({ connectionString: testUrl });
    await admin.connect();
    try {
      const db = await pool.connect();
      const pid = (await db.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      db.release();
      const error = new Promise<any>((resolve) => pool.once('error', resolve));
      await admin.query('SELECT pg_terminate_backend($1)', [pid]);
      assert.equal((await error).code, '57P01');
      await call('GET', '/health', undefined, 'none');
      await call('GET', '/orders', undefined, 'manager');
    } finally {
      await admin.end();
    }
  },
);
