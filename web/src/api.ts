export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('X-Looma-Client', 'web');
  if (options.body && !(options.body instanceof FormData))
    headers.set('Content-Type', 'application/json');
  const r = await fetch('/api' + path, { ...options, headers, credentials: 'same-origin' });
  if (!r.ok) {
    const b = await r.json().catch(() => ({ message: 'Ошибка соединения' }));
    throw new ApiError(r.status, b.message || 'Не удалось выполнить запрос');
  }
  return r.json();
}
export const post = <T = any>(path: string, data: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(data) });
export const patch = <T = any>(path: string, data: unknown) =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(data) });
export const upload = (path: string, file: File | File[]) => {
  const b = new FormData();
  for (const entry of Array.isArray(file) ? file : [file]) b.append('file', entry);
  return api(path, { method: 'POST', body: b });
};
export const money = (cents?: number) =>
  cents === undefined
    ? '—'
    : new Intl.NumberFormat('ru-RU', {
        style: 'currency',
        currency: 'RUB',
        maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
      }).format(cents / 100);
export const decimal = (cents = 0) => (cents / 100).toFixed(2);
export const dateLabel = (value?: string | null) =>
  value
    ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(
        new Date(value.length === 10 ? value + 'T12:00:00' : value),
      )
    : 'Не указан';
export const day = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date());
export const key = () => crypto.randomUUID();
