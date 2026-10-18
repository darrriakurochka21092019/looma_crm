import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, audit, pool, transaction, type DB } from './db.js';
import { storage } from './files.js';
import { taskStatuses } from '../shared/domain.js';

export const MAX_API = 'https://platform-api2.max.ru';
type MaxConfig = {
  version: number;
  enabled: boolean;
  token: string;
  reminder_minutes: number;
};
const configPath = join(storage, 'max-integration.json');
export async function readMaxConfig(): Promise<MaxConfig> {
  let saved: Partial<MaxConfig> = {};
  try {
    saved = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw new AppError(500, 'Не удалось прочитать настройки MAX');
  }
  return {
    version: saved.version || 0,
    enabled: saved.enabled === true,
    token: saved.token || process.env.MAX_BOT_TOKEN || '',
    reminder_minutes: saved.reminder_minutes || 60,
  };
}
export async function saveMaxConfig(
  actor: string,
  input: Omit<MaxConfig, 'token'> & { token?: string },
) {
  return transaction(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(71630923)');
    const old = await readMaxConfig();
    if (old.version !== input.version)
      throw new AppError(409, 'Настройки MAX уже изменены. Обновите страницу');
    const next = { ...old, ...input, token: input.token || old.token, version: old.version + 1 };
    if (next.enabled && !next.token) throw new AppError(400, 'Сначала укажите токен бота MAX');
    await audit(db, actor, 'integration', 'max', 'max_configured', null, {
      enabled: next.enabled,
      reminder_minutes: next.reminder_minutes,
      token_changed: !!input.token,
    });
    await mkdir(storage, { recursive: true });
    const temp = configPath + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temp, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
      await rename(temp, configPath);
    } finally {
      await unlink(temp).catch(() => {});
    }
    return publicMaxConfig(next);
  });
}
export function publicMaxConfig(config: MaxConfig) {
  return {
    version: config.version,
    enabled: config.enabled,
    configured: !!config.token,
    reminder_minutes: config.reminder_minutes,
  };
}
type Fetch = typeof fetch;
export class MaxError extends Error {
  constructor(
    message: string,
    public retryAfter = 0,
    public permanent = false,
  ) {
    super(message);
  }
}
export async function maxRequest(
  path: string,
  token: string,
  init: RequestInit = {},
  send: Fetch = fetch,
) {
  let response: Response;
  try {
    response = await send(MAX_API + path, {
      ...init,
      headers: {
        Authorization: token,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new MaxError(
      'Нет связи с MAX. Проверьте интернет и доверенный сертификат Минцифры для Node.js.',
    );
  }
  if (!response.ok) {
    // Upstream bodies can contain personal data. Do not store them or the token.
    const delay = Math.min(3600, Math.max(1, Number(response.headers.get('Retry-After')) || 60));
    if (response.status === 401)
      throw new MaxError('MAX: токен бота недействителен. Обновите его в настройках.', 0, true);
    if (response.status === 403 || response.status === 404)
      throw new MaxError(
        'MAX: получатель недоступен. Сотруднику нужно открыть бота и нажать «Начать». Проверьте ID.',
        0,
        true,
      );
    if (response.status === 429)
      throw new MaxError('MAX ограничил частоту сообщений. Отправка будет повторена.', delay);
    throw new MaxError(
      'MAX временно не принял сообщение (код ' + response.status + ').',
      0,
      response.status < 500,
    );
  }
  // Keep int64 identifiers exact, including JSON numbers beyond Number.MAX_SAFE_INTEGER.
  return JSON.parse(await response.text(), ((key: string, value: any, context: any) =>
    typeof value === 'number' && !Number.isSafeInteger(value) ? context.source : value) as any);
}
export async function enqueueTaskNotification(
  db: DB,
  task: any,
  kind: 'assigned' | 'updated' | 'completed',
) {
  await db.query(
    `INSERT INTO task_notifications(task_id,task_version,user_id,kind)
     SELECT $1,$2,$3,$4 FROM max_recipients r JOIN users u ON u.id=r.user_id
     WHERE r.user_id=$3 AND r.enabled AND u.active ON CONFLICT DO NOTHING`,
    [task.id, task.version, task.assignee_id, kind],
  );
}
export async function scheduleTaskReminders(db: DB, minutes: number) {
  await db.query(
    `INSERT INTO task_notifications(task_id,task_version,user_id,kind)
     SELECT t.id,t.version,t.assignee_id,CASE WHEN t.due_at<=now() THEN 'overdue' ELSE 'due' END
     FROM tasks t JOIN max_recipients r ON r.user_id=t.assignee_id AND r.enabled
     JOIN users u ON u.id=t.assignee_id AND u.active LEFT JOIN orders o ON o.id=t.order_id
     WHERE t.status<>'done' AND t.due_at<=now()+($1::int * interval '1 minute')
       AND (o.id IS NULL OR (NOT o.archived AND o.status NOT IN ('paused','cancelled')))
     ON CONFLICT DO NOTHING`,
    [minutes],
  );
}
const eventNames: Record<string, string> = {
  assigned: 'Вам назначена задача',
  updated: 'Задача изменена',
  completed: 'Задача выполнена',
  due: 'Скоро срок задачи',
  overdue: 'Срок задачи прошёл',
};
export function taskMessage(task: any, kind: string) {
  const due = new Intl.DateTimeFormat('ru-RU', {
    timeZone: task.timezone || 'Europe/Moscow',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(task.due_at));
  return [
    'LOOMA.CRM · ' + eventNames[kind],
    task.title,
    task.order_number
      ? 'Заказ: ' + task.order_number + ' · ' + task.order_title
      : 'Отдельная задача',
    'Срок: ' + due + ' (' + (task.timezone || 'Europe/Moscow') + ')',
    'Статус: ' + taskStatuses[task.status as keyof typeof taskStatuses],
    task.priority === 'high' ? 'Высокий приоритет' : '',
    task.description ? task.description.slice(0, 1500) : '',
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 3900);
}
export async function deliverTaskNotifications(config: MaxConfig, send: Fetch = fetch, limit = 10) {
  if (!config.enabled || !config.token) return;
  for (let i = 0; i < limit; i++) {
    const notification = await transaction(async (db) => {
      const {
        rows: [n],
      } = await db.query(
        `SELECT n.*,r.max_user_id FROM task_notifications n
         JOIN max_recipients r ON r.user_id=n.user_id AND r.enabled
         JOIN users u ON u.id=n.user_id AND u.active
         WHERE ((n.status='pending' AND n.next_attempt_at<=now()) OR (n.status='sending' AND n.locked_until<now()))
           AND r.next_send_at<=now()
         ORDER BY n.created_at,n.id LIMIT 1 FOR UPDATE OF n,r SKIP LOCKED`,
      );
      if (!n) return null;
      const {
        rows: [t],
      } = await db.query(
        `SELECT t.*,o.number order_number,o.title order_title,o.status order_status,o.archived,
          s.data->>'timezone' timezone FROM tasks t LEFT JOIN orders o ON o.id=t.order_id CROSS JOIN settings s
         WHERE t.id=$1 AND s.id=1`,
        [n.task_id],
      );
      const stale =
        !t ||
        t.assignee_id !== n.user_id ||
        t.version !== n.task_version ||
        (t.order_id && (t.archived || ['paused', 'cancelled'].includes(t.order_status))) ||
        (n.kind === 'completed' ? t.status !== 'done' : t.status === 'done') ||
        (n.kind === 'overdue' && new Date(t.due_at).getTime() > Date.now()) ||
        (n.kind === 'due' &&
          (new Date(t.due_at).getTime() <= Date.now() ||
            new Date(t.due_at).getTime() > Date.now() + config.reminder_minutes * 60000));
      if (stale) {
        await db.query(
          "UPDATE task_notifications SET status='cancelled',locked_until=NULL WHERE id=$1",
          [n.id],
        );
        return { skipped: true };
      }
      await db.query(
        "UPDATE task_notifications SET status='sending',attempts=attempts+1,locked_until=now()+interval '2 minutes' WHERE id=$1",
        [n.id],
      );
      // Persisted rate limit also covers concurrent workers and server restarts.
      await db.query(
        "UPDATE max_recipients SET next_send_at=now()+interval '1 second' WHERE user_id=$1",
        [n.user_id],
      );
      return { ...n, attempts: n.attempts + 1, text: taskMessage(t, n.kind), skipped: false };
    });
    if (!notification) break;
    if (notification.skipped) continue;
    try {
      await maxRequest(
        '/messages?user_id=' + encodeURIComponent(notification.max_user_id),
        config.token,
        {
          method: 'POST',
          body: JSON.stringify({ text: notification.text, notify: true }),
        },
        send,
      );
      await pool.query(
        "UPDATE task_notifications SET status='sent',sent_at=now(),error=NULL,locked_until=NULL WHERE id=$1 AND status='sending'",
        [notification.id],
      );
    } catch (err) {
      const error =
        err instanceof MaxError
          ? err
          : new MaxError('Не удалось завершить отправку. Проверьте подключение.');
      const failed = error.permanent || notification.attempts >= 8;
      const delay = Math.max(
        error.retryAfter,
        Math.min(3600, 30 * 2 ** (notification.attempts - 1)),
      );
      await pool.query(
        `UPDATE task_notifications SET status=$2,error=$3,next_attempt_at=now()+($4::int * interval '1 second'),locked_until=NULL WHERE id=$1 AND status='sending'`,
        [notification.id, failed ? 'failed' : 'pending', error.message, delay],
      );
    }
  }
}
export function startMaxWorker(log: { warn: (...args: any[]) => void }) {
  let running: Promise<void> | null = null,
    stopped = false,
    lastSchedule = 0;
  const tick = () => {
    if (running || stopped) return;
    running = (async () => {
      try {
        const config = await readMaxConfig();
        if (!config.enabled || !config.token) return;
        if (Date.now() - lastSchedule >= 60000) {
          await scheduleTaskReminders(pool, config.reminder_minutes);
          lastSchedule = Date.now();
        }
        await deliverTaskNotifications(config);
      } catch {
        log.warn('Уведомления MAX временно недоступны. Следующая попытка — автоматически.');
      } finally {
        running = null;
      }
    })();
  };
  const timer = setInterval(tick, 5000);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
