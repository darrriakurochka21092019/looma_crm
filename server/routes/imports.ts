import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as XLSX from '@e965/xlsx';
import { AppError, audit, hash, pool, transaction, type DB } from '../db.js';
import { requireRole, uuid } from '../security.js';
import { fileBytes, storeFile, validateFile } from '../files.js';
import { clientSchema, insertOrder, orderSchema } from './orders.js';
import { rublesToCents } from '../../shared/domain.js';
const fields = {
  clients: {
    name: 'ФИО / название',
    phone: 'Телефон',
    email: 'Email',
    address: 'Адрес',
    notes: 'Примечание',
  },
  orders: {
    client_name: 'ФИО клиента',
    phone: 'Телефон',
    title: 'Название заказа',
    external_number: 'Номер договора',
    model: 'Модель',
    quantity: 'Количество',
    price: 'Цена за изделие, ₽',
    due_date: 'Дата готовности',
    fabric: 'Ткань / артикул',
    fabric_cost: 'Затраты на ткань, ₽',
    labor_cost: 'Работа мастера, ₽',
    delivery_cost: 'Доставка, ₽',
  },
  expenses: {
    order_number: 'Номер заказа CRM',
    category: 'Категория',
    supplier: 'Поставщик',
    amount: 'Сумма, ₽',
    incurred_on: 'Дата расхода',
    notes: 'Примечание',
  },
};
type Kind = keyof typeof fields;
const synonyms: Record<string, string[]> = {
  name: ['фио', 'клиент', 'заказчик', 'наименование', 'название'],
  client_name: ['фио', 'клиент', 'заказчик'],
  phone: ['телефон', 'номер телефона', 'тел'],
  email: ['email', 'почта'],
  address: ['адрес', 'адрес доставки'],
  notes: ['примечание', 'комментарий'],
  title: ['заказ', 'название заказа', 'изделие'],
  external_number: ['договор', 'номер договора'],
  model: ['модель', 'изделие'],
  quantity: ['количество', 'колво'],
  price: ['стоимость', 'цена', 'сумма заказа'],
  due_date: ['дата готовности', 'срок', 'дата'],
  fabric: ['ткань', 'материал'],
  fabric_cost: ['затраты на ткань', 'стоимость ткани'],
  labor_cost: ['работа мастера', 'работа'],
  delivery_cost: ['доставка'],
  order_number: ['номер заказа', 'заказ crm'],
  category: ['категория', 'статья'],
  supplier: ['поставщик', 'контрагент'],
  amount: ['сумма', 'расход', 'стоимость'],
  incurred_on: ['дата', 'дата расхода'],
};
function norm(s: string) {
  return s.toLowerCase().replace(/[\s.()₽_-]/g, '');
}
function workbook(data: Buffer) {
  try {
    return XLSX.read(data, { type: 'buffer', cellDates: true, sheetRows: 10002 });
  } catch {
    throw new AppError(400, 'Не удалось прочитать Excel');
  }
}
function sheetRows(w: XLSX.WorkBook, name: string) {
  const sheet = w.Sheets[name];
  if (!sheet) throw new AppError(400, 'Лист не найден');
  const all = XLSX.utils.sheet_to_json<any[]>(sheet, {
    header: 1,
    defval: '',
    raw: true,
    blankrows: false,
  });
  if (all.length > 10001) throw new AppError(400, 'В одном импорте допускается до 10 000 строк');
  const headers = (all[0] || []).map((v: any, i: number) => String(v || `Колонка ${i + 1}`).trim());
  if (new Set(headers).size !== headers.length)
    throw new AppError(400, 'Названия колонок должны быть уникальными');
  return { headers, rows: all.slice(1) };
}
function cell(v: any) {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').trim();
}
function mapped(row: any[], headers: string[], mapping: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(mapping)
      .filter(([, v]) => v)
      .map(([k, v]) => [k, cell(row[headers.indexOf(v)])]),
  );
}
function dateValue(v: string) {
  if (/^\d{2}[./]\d{2}[./]\d{4}$/.test(v)) {
    const [d, m, y] = v.split(/[./]/);
    return `${y}-${m}-${d}`;
  }
  return v;
}
function parseRow(kind: Kind, d: Record<string, string>) {
  if (kind === 'clients') return clientSchema.parse({ ...d, type: 'person' });
  if (kind === 'orders') {
    const c = clientSchema.parse({ name: d.client_name, phone: d.phone });
    const due = dateValue(d.due_date || '');
    const o = orderSchema.omit({ client_id: true }).parse({
      title: d.title || d.model || 'Заказ из Excel',
      due_date: due,
      manager_id: null,
      master_id: null,
      discount: 0,
      notes: d.external_number ? `Исходный договор: ${d.external_number}` : '',
      items: [
        {
          kind: 'Иное',
          model: d.model || d.title || 'Изделие',
          quantity: Number(d.quantity || 1),
          price: rublesToCents(d.price || ''),
          fabric: d.fabric || '',
        },
      ],
    });
    const costs = [
      ['Ткань', d.fabric_cost],
      ['Работа мастера', d.labor_cost],
      ['Доставка', d.delivery_cost],
    ]
      .filter(([, v]) => v)
      .map(([category, v]) => ({ category, amount: rublesToCents(v!) }))
      .filter((c) => c.amount > 0);
    return { client: c, order: o, costs, external_number: d.external_number || '' };
  }
  const amount = rublesToCents(d.amount || '');
  if (amount <= 0) throw new Error('Сумма расхода должна быть положительной');
  const v = dateValue(d.incurred_on || '');
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
    Number.isNaN(Date.parse(v)) ||
    new Date(v).toISOString().slice(0, 10) !== v
  )
    throw new Error('Некорректная дата расхода');
  if (!d.category) throw new Error('Не указана категория');
  return {
    order_number: d.order_number || '',
    category: d.category,
    supplier: d.supplier || '',
    amount,
    incurred_on: v,
    notes: d.notes || '',
  };
}
async function duplicate(db: DB, kind: Kind, parsed: any, fingerprint: string) {
  if (
    (
      await db.query('SELECT 1 FROM import_fingerprints WHERE kind=$1 AND fingerprint=$2', [
        kind,
        fingerprint,
      ])
    ).rowCount
  )
    return 'Строка уже импортировалась';
  if (
    kind === 'clients' &&
    (await db.query('SELECT 1 FROM clients WHERE phone=$1', [parsed.phone])).rowCount
  )
    return 'Клиент с этим телефоном уже существует';
  if (kind === 'orders') {
    if (
      parsed.external_number &&
      (await db.query('SELECT 1 FROM orders WHERE external_ref=$1', [parsed.external_number]))
        .rowCount
    )
      return 'Договор с этим номером уже существует';
    if (
      (
        await db.query(
          'SELECT 1 FROM orders o JOIN clients c ON c.id=o.client_id WHERE c.phone=$1 AND o.title=$2 AND o.due_date=$3',
          [parsed.client.phone, parsed.order.title, parsed.order.due_date],
        )
      ).rowCount
    )
      return 'Похожий заказ уже существует';
  }
  if (
    kind === 'expenses' &&
    parsed.order_number &&
    !(await db.query('SELECT 1 FROM orders WHERE number=$1', [parsed.order_number])).rowCount
  )
    throw new Error('Заказ CRM с таким номером не найден');
  return null;
}
export async function importRoutes(app: FastifyInstance) {
  app.get('/imports', async (req) => {
    requireRole(req, 'owner');
    return (
      await pool.query(
        'SELECT id,file_name,kind,sheet,status,created_at,confirmed_at FROM import_jobs ORDER BY created_at DESC LIMIT 50',
      )
    ).rows;
  });
  app.post('/imports/inspect', async (req) => {
    requireRole(req, 'owner');
    const { kind } = z.object({ kind: z.enum(['clients', 'orders', 'expenses']) }).parse(req.query);
    const f = await req.file();
    if (!f) throw new AppError(400, 'Выберите файл Excel');
    const data = await f.toBuffer();
    validateFile(f.filename, data, ['.xls', '.xlsx']);
    if (data.length > 10 * 1024 * 1024)
      throw new AppError(400, 'Для импорта выберите файл до 10 МБ');
    const w = workbook(data);
    const sheet = w.SheetNames[0];
    const r = sheetRows(w, sheet);
    const mapping: Record<string, string> = {};
    for (const field of Object.keys(fields[kind]))
      mapping[field] =
        r.headers.find((h) => (synonyms[field] || []).some((s) => norm(s) === norm(h))) || '';
    return transaction(async (db) => {
      const stored = await storeFile(db, f.filename, data);
      const {
        rows: [job],
      } = await db.query(
        'INSERT INTO import_jobs(file_hash,file_name,kind,sheet,mapping,author_id,source_key) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [hash(data), f.filename, kind, sheet, mapping, req.user.id, stored.key],
      );
      const {
        rows: [dupe],
      } = await db.query(
        "SELECT id FROM import_jobs WHERE file_hash=$1 AND kind=$2 AND status='confirmed'",
        [hash(data), kind],
      );
      return {
        id: job.id,
        sheets: w.SheetNames,
        sheet,
        headers: r.headers,
        sample: r.rows.slice(0, 20).map((row) => row.map(cell)),
        mapping,
        fields: fields[kind],
        total: r.rows.length,
        already_imported: !!dupe,
      };
    });
  });
  app.get('/imports/:id/sheet', async (req) => {
    requireRole(req, 'owner');
    const id = uuid.parse((req.params as any).id);
    const { sheet } = z.object({ sheet: z.string().min(1).max(100) }).parse(req.query);
    const {
      rows: [j],
    } = await pool.query('SELECT * FROM import_jobs WHERE id=$1 AND author_id=$2', [
      id,
      req.user.id,
    ]);
    if (!j) throw new AppError(404, 'Импорт не найден');
    const w = workbook(await fileBytes(j.source_key));
    const r = sheetRows(w, sheet);
    const mapping: Record<string, string> = {};
    for (const field of Object.keys(fields[j.kind as Kind]))
      mapping[field] =
        r.headers.find((h) => (synonyms[field] || []).some((s) => norm(s) === norm(h))) || '';
    return {
      sheet,
      headers: r.headers,
      sample: r.rows.slice(0, 20).map((row) => row.map(cell)),
      mapping,
      total: r.rows.length,
    };
  });
  app.post('/imports/preview', async (req) => {
    requireRole(req, 'owner');
    const b = z
      .object({
        id: uuid,
        sheet: z.string().min(1).max(100),
        mapping: z.record(z.string(), z.string()),
      })
      .parse(req.body);
    return transaction(async (db) => {
      const {
        rows: [j],
      } = await db.query('SELECT * FROM import_jobs WHERE id=$1 FOR UPDATE', [b.id]);
      if (!j || j.author_id !== req.user.id) throw new AppError(404, 'Импорт не найден');
      if (j.status === 'confirmed') throw new AppError(409, 'Импорт уже выполнен');
      const data = await fileBytes(j.source_key);
      const w = workbook(data);
      const { headers, rows } = sheetRows(w, b.sheet);
      for (const [key, column] of Object.entries(b.mapping)) {
        if (
          !Object.keys(fields[j.kind as Kind]).includes(key) ||
          (column && !headers.includes(column))
        )
          throw new AppError(400, 'Неверное сопоставление полей');
      }
      await db.query('DELETE FROM import_rows WHERE job_id=$1', [j.id]);
      let valid = 0,
        duplicates = 0,
        errors = 0;
      const preview: any[] = [];
      const seen = new Set<string>();
      for (const [idx, row] of rows.entries()) {
        const values = mapped(row, headers, b.mapping);
        let parsed: any = null,
          error: string | null = null,
          duplicateReason: string | null = null;
        try {
          parsed = parseRow(j.kind, values);
          const fingerprint = hash(JSON.stringify(parsed));
          duplicateReason = seen.has(fingerprint)
            ? 'Повтор внутри файла'
            : await duplicate(db, j.kind, parsed, fingerprint);
          seen.add(fingerprint);
        } catch (e: any) {
          error =
            e instanceof z.ZodError
              ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
              : e.message;
        }
        if (error) errors++;
        else if (duplicateReason) duplicates++;
        else valid++;
        const result = { row: idx + 2, values, parsed, error, duplicate: duplicateReason };
        await db.query(
          'INSERT INTO import_rows(job_id,row_number,data,error) VALUES($1,$2,$3,$4)',
          [j.id, idx + 2, result, error || duplicateReason],
        );
        if (preview.length < 100) preview.push(result);
      }
      await db.query('UPDATE import_jobs SET sheet=$2,mapping=$3 WHERE id=$1', [
        j.id,
        b.sheet,
        b.mapping,
      ]);
      return { id: j.id, valid, duplicates, errors, total: rows.length, rows: preview };
    });
  });
  app.post('/imports/confirm', async (req) => {
    requireRole(req, 'owner');
    const b = z.object({ id: uuid }).parse(req.body);
    return transaction(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(71630923)');
      const {
        rows: [j],
      } = await db.query('SELECT * FROM import_jobs WHERE id=$1 FOR UPDATE', [b.id]);
      if (!j || j.author_id !== req.user.id) throw new AppError(404, 'Импорт не найден');
      if (j.status === 'confirmed') return { id: j.id, already_confirmed: true };
      if (
        (
          await db.query(
            "SELECT 1 FROM import_jobs WHERE file_hash=$1 AND kind=$2 AND sheet=$3 AND status='confirmed'",
            [j.file_hash, j.kind, j.sheet],
          )
        ).rowCount
      )
        throw new AppError(409, 'Этот файл уже импортирован. Дубли не созданы');
      const rows = (
        await db.query('SELECT * FROM import_rows WHERE job_id=$1 ORDER BY row_number', [j.id])
      ).rows;
      if (!rows.length) throw new AppError(400, 'Сначала выполните предпросмотр');
      let created = 0,
        skipped = 0,
        clients = 0,
        orders = 0,
        expenses = 0;
      for (const row of rows) {
        if (row.error) {
          skipped++;
          continue;
        }
        const p = row.data.parsed;
        const fingerprint = hash(JSON.stringify(p));
        if (await duplicate(db, j.kind, p, fingerprint)) {
          skipped++;
          continue;
        }
        let resultId = '';
        if (j.kind === 'clients') {
          const {
            rows: [c],
          } = await db.query(
            'INSERT INTO clients(name,phone,email,address,notes) VALUES($1,$2,$3,$4,$5) RETURNING id',
            [p.name, p.phone, p.email, p.address, p.notes],
          );
          resultId = c.id;
          clients++;
        }
        if (j.kind === 'orders') {
          let c = (await db.query('SELECT id FROM clients WHERE phone=$1', [p.client.phone]))
            .rows[0];
          if (!c) {
            c = (
              await db.query('INSERT INTO clients(name,phone) VALUES($1,$2) RETURNING id', [
                p.client.name,
                p.client.phone,
              ])
            ).rows[0];
            clients++;
          }
          const o = await insertOrder(db, { ...p.order, client_id: c.id }, req.user);
          if (p.external_number)
            await db.query('UPDATE orders SET external_ref=$2 WHERE id=$1', [
              o.id,
              p.external_number,
            ]);
          resultId = o.id;
          orders++;
          for (const cost of p.costs) {
            await db.query(
              'INSERT INTO expenses(order_id,category,amount,incurred_on,author_id) VALUES($1,$2,$3,$4,$5)',
              [o.id, cost.category, cost.amount, p.order.due_date, req.user.id],
            );
            expenses++;
          }
        }
        if (j.kind === 'expenses') {
          const order = p.order_number
            ? (await db.query('SELECT id FROM orders WHERE number=$1', [p.order_number])).rows[0]
            : null;
          const {
            rows: [e],
          } = await db.query(
            'INSERT INTO expenses(order_id,category,supplier,amount,incurred_on,notes,author_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
            [
              order?.id || null,
              p.category,
              p.supplier,
              p.amount,
              p.incurred_on,
              p.notes,
              req.user.id,
            ],
          );
          resultId = e.id;
          expenses++;
        }
        await db.query(
          'INSERT INTO import_fingerprints(kind,fingerprint,job_id) VALUES($1,$2,$3)',
          [j.kind, fingerprint, j.id],
        );
        await db.query('UPDATE import_rows SET result_id=$2 WHERE id=$1', [row.id, resultId]);
        created++;
      }
      await db.query("UPDATE import_jobs SET status='confirmed',confirmed_at=now() WHERE id=$1", [
        j.id,
      ]);
      await audit(db, req.user.id, 'import', j.id, 'confirmed', null, {
        created,
        skipped,
        clients,
        orders,
        expenses,
      });
      return { id: j.id, created, skipped, clients, orders, expenses };
    });
  });
  app.get('/imports/:id/errors', async (req, reply) => {
    requireRole(req, 'owner');
    const id = uuid.parse((req.params as any).id);
    const rows = (
      await pool.query(
        'SELECT row_number,data,error,result_id FROM import_rows WHERE job_id=$1 ORDER BY row_number',
        [id],
      )
    ).rows;
    const w = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      w,
      XLSX.utils.json_to_sheet(
        rows.map((r) => ({
          Строка: r.row_number,
          Данные: JSON.stringify(r.data.values),
          'Ошибка или дубль': r.error || '',
          'Созданная запись': r.result_id || '',
        })),
      ),
      'Журнал импорта',
    );
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', 'attachment; filename="LOOMA-import-log.xlsx"');
    return reply.send(XLSX.write(w, { type: 'buffer', bookType: 'xlsx' }));
  });
}
