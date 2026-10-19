import 'dotenv/config';
import { hashPassword } from './passwords.js';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { pool, transaction, audit } from './db.js';
import { migrate } from './migrate.js';
import { insertOrder } from './routes/orders.js';
import { localDay } from './routes/finance.js';
import type { User } from '../shared/domain.js';
export async function seed(demo = process.argv.includes('--demo')) {
  let passwordHash: string | undefined;
  const initialPasswordHash = async () => {
    const password = process.env.SEED_PASSWORD;
    if (!password || password === 'CHANGE_ME' || password.length < 12)
      throw new Error('Установите SEED_PASSWORD длиной от 12 символов (npm run setup)');
    return (passwordHash ??= await hashPassword(password));
  };
  await transaction(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(71630924)');
    const {
      rows: [existing],
    } = await db.query("SELECT * FROM users WHERE role='owner' LIMIT 1");
    let owner: User = existing;
    if (!owner) {
      owner = (
        await db.query(
          "INSERT INTO users(name,email,role,password_hash) VALUES('Владелец','owner@looma.local','owner',$1) RETURNING id,name,email,role,active",
          [await initialPasswordHash()],
        )
      ).rows[0];
      await audit(db, owner.id, 'user', owner.id, 'owner_initialized');
    }
    if (!demo) return;
    if ((await db.query('SELECT 1 FROM orders LIMIT 1')).rowCount) {
      console.log('Демо-заказы уже есть. Повторное заполнение пропущено');
      return;
    }
    const demoUsers: any = { owner };
    for (const [role, name] of [
      ['manager', 'Анна Смирнова'],
      ['accountant', 'Мария Иванова'],
      ['master', 'Алексей Волков'],
    ])
      demoUsers[role] = (
        await db.query(
          'INSERT INTO users(name,email,role,password_hash) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO UPDATE SET name=EXCLUDED.name RETURNING id,name,email,role,active',
          [name, `${role}@looma.local`, role, await initialPasswordHash()],
        )
      ).rows[0];
    const today = localDay();
    const offset = (n: number) =>
      new Date(Date.parse(today) + n * 86400000).toISOString().slice(0, 10);
    const day = (n: number) =>
      today.slice(0, 8) + String(Math.max(1, Math.min(Number(today.slice(8)), n))).padStart(2, '0');
    const samples = [
      [
        'Полина Соколова',
        '79010010001',
        'Диван «Луна»',
        'Диван',
        'Луна',
        'production',
        2,
        148000,
        82000,
        74000,
        'Букле • молочный',
      ],
      [
        'Артём Лебедев',
        '79010010002',
        'Кровать «Соната»',
        'Кровать',
        'Соната',
        'contract',
        6,
        126000,
        69000,
        63000,
        'Велюр • песочный',
      ],
      [
        'Ольга Мельникова',
        '79010010003',
        'Два кресла «Облако»',
        'Кресло',
        'Облако',
        'ready',
        1,
        48000,
        26000,
        96000,
        'Шенилл • оливковый',
      ],
      [
        'Дмитрий Кузнецов',
        '79010010004',
        'Угловой диван «Модуль»',
        'Диван',
        'Модуль',
        'approval',
        10,
        215000,
        121000,
        0,
        'Рогожка • графит',
      ],
      [
        'Ксения Орлова',
        '79010010005',
        'Диван «Софт»',
        'Диван',
        'Софт',
        'closed',
        -3,
        132000,
        74000,
        132000,
        'Велюр • сливочный',
      ],
      [
        'Студия «Тихо»',
        '79010010006',
        'Комплект для гостиной',
        'Диван',
        'Арка',
        'production',
        -1,
        184000,
        103000,
        92000,
        'Букле • светло-серый',
      ],
    ] as const;
    for (const [idx, s] of samples.entries()) {
      const [name, phone, title, kind, model, status, days, price, cost, paid, fabric] = s;
      const client = (
        await db.query(
          'INSERT INTO clients(name,phone,address,source,consent_basis,type) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
          [
            name,
            phone,
            'Москва, адрес уточняется',
            'Рекомендация',
            'Демонстрационные данные',
            idx === 5 ? 'company' : 'person',
          ],
        )
      ).rows[0];
      const o = await insertOrder(
        db,
        {
          client_id: client.id,
          title,
          due_date: offset(days),
          manager_id: demoUsers.manager.id,
          master_id: demoUsers.master.id,
          discount: 0,
          notes:
            idx === 5
              ? 'Согласовать время доставки и доступ на объект.'
              : 'Уточнить удобное время доставки перед отгрузкой.',
          items: [
            {
              kind,
              model,
              quantity: idx === 2 ? 2 : 1,
              dimensions: kind === 'Кресло' ? '90 × 90 × 85' : '220 × 100 × 90',
              fabric,
              color: fabric.split('•')[1].trim(),
              filling: 'ППУ повышенной плотности',
              mechanism: kind === 'Диван' ? 'Еврокнижка' : 'Без механизма',
              notes: 'Съёмные чехлы подушек',
              price: price * 100,
              planned_cost: cost * 100,
            },
          ],
        },
        owner,
      );
      await db.query('UPDATE orders SET status=$2,closed_at=$3,handed_over_at=$3 WHERE id=$1', [
        o.id,
        status,
        status === 'closed' ? `${offset(-3)}T12:00:00+03:00` : null,
      ]);
      if (['production', 'ready', 'closed'].includes(status)) {
        const totalCost = cost * (idx === 2 ? 2 : 1) * 100;
        const e = (
          await db.query(
            'INSERT INTO expenses(order_id,category,supplier,amount,incurred_on,author_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
            [o.id, 'Материалы', 'Демо-поставщик', totalCost, day(idx * 2 + 1), owner.id],
          )
        ).rows[0];
        await db.query(
          "INSERT INTO money_movements(kind,expense_id,amount,occurred_on,author_id,idempotency_key) VALUES('expense_payment',$1,$2,$3,$4,$5)",
          [e.id, Math.round(totalCost * 0.8), day(idx * 2 + 2), owner.id, randomUUID()],
        );
      }
      if (paid)
        await db.query(
          "INSERT INTO money_movements(kind,order_id,amount,occurred_on,author_id,idempotency_key) VALUES('receipt',$1,$2,$3,$4,$5)",
          [o.id, paid * 100, day(idx * 3 + 2), owner.id, randomUUID()],
        );
      const steps = (
        await db.query('SELECT * FROM production_steps WHERE order_id=$1 ORDER BY position', [o.id])
      ).rows;
      for (const [p, step] of steps.entries())
        await db.query('UPDATE production_steps SET status=$2 WHERE id=$1', [
          step.id,
          status === 'closed' || (status === 'ready' && p < 6) || (status === 'production' && p < 3)
            ? 'done'
            : status === 'production' && p === 3
              ? 'doing'
              : 'new',
        ]);
      if (idx < 4)
        await db.query(
          'INSERT INTO tasks(title,description,order_id,author_id,assignee_id,due_at,priority,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            [
              'Согласовать оттенок ткани',
              'Подтвердить чертёж кровати',
              'Назначить доставку кресел',
              'Подготовить расчёт стоимости',
            ][idx],
            'Связаться с клиентом и зафиксировать результат в комментариях',
            o.id,
            owner.id,
            idx === 2 ? demoUsers.manager.id : owner.id,
            `${offset(idx - 1)}T15:00:00+03:00`,
            idx === 2 ? 'high' : 'normal',
            idx === 0 ? 'doing' : 'new',
          ],
        );
    }
    await db.query(
      "INSERT INTO expenses(category,supplier,amount,incurred_on,author_id) VALUES('Аренда','Демонстрационная аренда',2500000,$1,$2)",
      [today.slice(0, 8) + '01', owner.id],
    );
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log('Проверяется структура базы PostgreSQL…');
    await migrate();
    console.log('Проверяется учётная запись владельца…');
    await seed();
    console.log('База и учётная запись владельца готовы. Существующий пароль сохранён.');
  } finally {
    await pool.end();
  }
}
