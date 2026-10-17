import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import PizZip from 'pizzip';
import { AppError, pool, type DB, hash } from './db.js';
export const storage = resolve(process.env.STORAGE_DIR || 'storage');
export const mimes: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
};
export function validateFile(name: string, data: Buffer, extensions = Object.keys(mimes)) {
  const ext = extname(name).toLowerCase();
  if (!extensions.includes(ext) || !mimes[ext])
    throw new AppError(400, 'Допустимы PDF, PNG, JPG, DOCX, XLSX и XLS');
  if (!data.length) throw new AppError(400, 'Файл пуст');
  let valid = false;
  if (ext === '.pdf') valid = data.subarray(0, 5).toString() === '%PDF-';
  if (ext === '.png') valid = data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  if (['.jpg', '.jpeg'].includes(ext)) valid = data.subarray(0, 3).toString('hex') === 'ffd8ff';
  if (ext === '.xls') valid = data.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1';
  if (ext === '.docx' || ext === '.xlsx') {
    try {
      const zip = new PizZip(data);
      const names = Object.keys(zip.files);
      if (names.length > 20000) throw new Error('Too many entries');
      let expanded = 0;
      for (const f of Object.values(zip.files)) {
        const size = (f as any)._data?.uncompressedSize || 0;
        expanded += size;
        if (expanded > 100 * 1024 * 1024) throw new Error('Expanded limit');
      }
      if (names.some((n) => /vbaProject|\.exe$/i.test(n))) throw new Error('Macros or executables');
      valid =
        !!zip.file('[Content_Types].xml') &&
        !!zip.file(ext === '.docx' ? 'word/document.xml' : 'xl/workbook.xml');
    } catch {
      valid = false;
    }
  }
  if (!valid)
    throw new AppError(400, 'Содержимое файла не соответствует расширению или файл повреждён');
  return mimes[ext];
}
export async function storeFile(db: DB, name: string, data: Buffer, mime?: string) {
  const {
    rows: [s],
  } = await db.query('SELECT data FROM settings WHERE id=1 FOR UPDATE');
  const settings = s.data;
  if (data.length > settings.max_file_mb * 1024 * 1024)
    throw new AppError(400, `Максимальный размер — ${settings.max_file_mb} МБ`);
  const {
    rows: [used],
  } = await db.query('SELECT COALESCE(sum(size),0)::bigint size FROM file_blobs');
  if (used.size + data.length > settings.storage_quota_mb * 1024 * 1024)
    throw new AppError(400, 'Достигнута квота документов');
  const key = randomUUID() + extname(name).toLowerCase();
  await mkdir(storage, { recursive: true });
  await writeFile(resolve(storage, key), data, { flag: 'wx', mode: 0o600 });
  await db.query('INSERT INTO file_blobs(storage_key,size,mime,sha256) VALUES($1,$2,$3,$4)', [
    key,
    data.length,
    mime || validateFile(name, data),
    hash(data),
  ]);
  return { key, size: data.length, mime: mime || validateFile(name, data), sha256: hash(data) };
}
export async function removeOrphan(key: string) {
  if (!/^[\w.-]+$/.test(key)) return;
  await unlink(resolve(storage, key)).catch(() => {});
}
export async function fileBytes(key: string) {
  if (!/^[\w.-]+$/.test(key)) throw new AppError(400, 'Некорректный файл');
  try {
    return await readFile(resolve(storage, key));
  } catch {
    throw new AppError(404, 'Файл не найден. Проверьте восстановление каталога документов');
  }
}
