import { Worker } from 'node:worker_threads';

export type PasswordJob =
  | { kind: 'hash'; password: string | Uint8Array }
  | { kind: 'verify'; password: string; hash: string };

// Keep expensive password work off the HTTP thread and bound its memory usage.
const queue: Array<{
  job: PasswordJob;
  resolve: (value: string | boolean) => void;
  reject: (error: Error) => void;
}> = [];
let running = 0;
function pump() {
  while (running < 2 && queue.length) {
    const task = queue.shift()!;
    running++;
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    let worker: Worker;
    try {
      worker = new Worker(new URL(`./password-worker.${extension}`, import.meta.url), {
        workerData: task.job,
        execArgv: extension === 'ts' ? ['--import', 'tsx'] : [],
      });
    } catch {
      running--;
      task.reject(new Error('Не удалось запустить проверку пароля'));
      continue;
    }
    let result: string | boolean | undefined;
    let error: Error | undefined;
    const timeout = setTimeout(() => {
      error = new Error('Проверка пароля заняла слишком много времени');
      void worker.terminate();
    }, 30000);
    worker.once('message', (value: unknown) => {
      if (
        (task.job.kind === 'hash' && typeof value === 'string') ||
        (task.job.kind === 'verify' && typeof value === 'boolean')
      )
        result = value as string | boolean;
    });
    worker.once('error', (cause: Error & { code?: string }) => {
      error = new Error(
        'Не удалось выполнить проверку пароля (' + (cause.code || 'WORKER_ERROR') + ')',
      );
    });
    worker.once('exit', (code) => {
      clearTimeout(timeout);
      running--;
      if (error || code !== 0 || result === undefined)
        task.reject(error || new Error(`Модуль паролей завершился с кодом ${code}`));
      else task.resolve(result);
      pump();
    });
  }
}
function run(job: PasswordJob): Promise<string | boolean> {
  if (queue.length >= 64)
    return Promise.reject(new Error('Проверка паролей занята. Повторите позже'));
  return new Promise((resolve, reject) => {
    queue.push({ job, resolve, reject });
    pump();
  });
}
export async function hashPassword(password: string | Uint8Array): Promise<string> {
  return (await run({ kind: 'hash', password })) as string;
}
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return (await run({ kind: 'verify', hash, password })) as boolean;
}
