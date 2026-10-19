import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import { AppError, audit, pool, transaction } from '../db.js';
import { accessibleOrder, requireRole, uuid } from '../security.js';
import { fileBytes, removeOrphan, storeFile, validateFile } from '../files.js';
import { canFinance, documentCategories } from '../../shared/domain.js';
import { imageSize } from '../office-xml.js';
const meta = z.object({
  order_id: uuid,
  category: z.enum(Object.keys(documentCategories) as [string, ...string[]]),
  visibility: z.enum(['commercial', 'financial', 'technical']),
  comment: z.string().max(3000).default(''),
  document_id: uuid.optional(),
  version: z.coerce.number().int().optional(),
  item_id: uuid.optional(),
  order_version: z.coerce.number().int().positive().optional(),
});
function allowed(role: string, visibility: string) {
  return (
    ['owner', 'manager'].includes(role) ||
    (role === 'accountant' && visibility === 'financial') ||
    (role === 'master' && visibility === 'technical')
  );
}
export async function documentRoutes(app: FastifyInstance) {
  app.get('/documents', async (req) => {
    const q = z
      .object({
        q: z.string().max(200).default(''),
        order_id: uuid.optional(),
        category: z.string().max(30).optional(),
      })
      .parse(req.query);
    const p: any[] = [`%${q.q}%`];
    let where = '(v.name ILIKE $1 OR o.number ILIKE $1 OR c.name ILIKE $1)';
    if (q.order_id) {
      await accessibleOrder(req.user, q.order_id);
      p.push(q.order_id);
      where += ` AND d.order_id=$${p.length}`;
    }
    if (!q.order_id) where += " AND NOT o.archived AND o.status NOT IN ('paused','cancelled')";
    if (q.category) {
      p.push(q.category);
      where += ` AND d.category=$${p.length}`;
    }
    if (req.user.role === 'accountant') where += " AND d.visibility='financial'";
    if (req.user.role === 'master') {
      p.push(req.user.id);
      where += ` AND d.visibility='technical' AND (o.master_id=$${p.length} OR EXISTS(SELECT 1 FROM production_steps ps WHERE ps.order_id=o.id AND ps.assignee_id=$${p.length}))`;
    }
    const rows = (
      await pool.query(
        `SELECT d.id,d.order_id,d.category,d.visibility,d.comment,d.created_at,v.name,v.version,v.size,v.mime,u.name author_name,o.number order_number,c.name client_name FROM documents d JOIN document_versions v ON v.document_id=d.id AND v.version=d.current_version JOIN users u ON u.id=v.author_id JOIN orders o ON o.id=d.order_id JOIN clients c ON c.id=o.client_id WHERE ${where} ORDER BY d.created_at DESC LIMIT 500`,
        p,
      )
    ).rows;
    if (['owner', 'manager'].includes(req.user.role)) {
      for (const d of rows)
        d.versions = (
          await pool.query(
            'SELECT version,name,size,created_at FROM document_versions WHERE document_id=$1 ORDER BY version DESC',
            [d.id],
          )
        ).rows;
    }
    return rows;
  });
  app.post('/documents', async (req) => {
    const b = meta.parse(req.query);
    await accessibleOrder(req.user, b.order_id);
    if (b.item_id) {
      requireRole(req, 'owner', 'manager');
      if (
        b.category !== 'photo' ||
        b.visibility !== 'technical' ||
        b.document_id ||
        !b.order_version
      )
        throw new AppError(
          400,
          'Для фото изделия выберите техническое фото и актуальную версию заказа',
        );
    }
    if (!allowed(req.user.role, b.visibility))
      throw new AppError(403, 'Нет доступа к этой категории документов');
    const files: { name: string; data: Buffer; mime: string }[] = [];
    let total = 0;
    for await (const part of req.files({
      limits: { files: b.document_id || b.item_id ? 1 : 10, parts: 10, fileSize: 25 * 1024 * 1024 },
    })) {
      const data = await part.toBuffer();
      total += data.length;
      if (total > 100 * 1024 * 1024) throw new AppError(400, 'Общий размер файлов — до 100 МБ');
      const name = part.filename.replace(/[\x00-\x1f/\\]/g, '_').slice(0, 200);
      if (b.item_id && !/\.(png|jpe?g)$/i.test(name))
        throw new AppError(400, 'Для фото изделия выберите JPG или PNG');
      const mime = validateFile(name, data, b.item_id ? ['.png', '.jpg', '.jpeg'] : undefined);
      if (b.item_id)
        try {
          imageSize(data, mime);
        } catch {
          throw new AppError(400, 'Не удалось прочитать фото. Выберите исправный JPG или PNG');
        }
      files.push({ name, data, mime });
    }
    if (!files.length) throw new AppError(400, 'Выберите файлы');
    const storedKeys: string[] = [];
    try {
      return await transaction(async (db) => {
        if (b.item_id) {
          const order = await accessibleOrder(req.user, b.order_id, db, true);
          if (order.version !== b.order_version)
            throw new AppError(409, 'Заказ изменён. Обновите карточку и загрузите фото ещё раз');
          if (
            !(
              await db.query('SELECT 1 FROM order_items WHERE id=$1 AND order_id=$2', [
                b.item_id,
                b.order_id,
              ])
            ).rowCount
          )
            throw new AppError(404, 'Изделие не найдено в этом заказе');
        }
        const documents = [];
        for (const { name, data, mime } of files) {
          let id = b.document_id;
          let version = 1;
          if (id) {
            const {
              rows: [d],
            } = await db.query('SELECT * FROM documents WHERE id=$1 FOR UPDATE', [id]);
            if (!d || d.order_id !== b.order_id) throw new AppError(404, 'Документ не найден');
            if (!allowed(req.user.role, d.visibility)) throw new AppError(403, 'Нет доступа');
            if (b.version !== d.current_version)
              throw new AppError(409, 'Документ уже обновлён другим сотрудником');
            if (d.visibility !== b.visibility || d.category !== b.category)
              throw new AppError(400, 'Категория и видимость новой версии должны совпадать');
            version = d.current_version + 1;
            await db.query('UPDATE documents SET current_version=$2 WHERE id=$1', [id, version]);
          } else {
            const {
              rows: [d],
            } = await db.query(
              'INSERT INTO documents(order_id,category,visibility,comment) VALUES($1,$2,$3,$4) RETURNING id',
              [b.order_id, b.category, b.visibility, b.comment],
            );
            id = d.id;
          }
          const f = await storeFile(db, name, data, mime);
          storedKeys.push(f.key);
          await db.query(
            'INSERT INTO document_versions(document_id,version,name,storage_key,mime,size,sha256,author_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
            [id, version, name, f.key, mime, f.size, f.sha256, req.user.id],
          );
          await audit(db, req.user.id, 'order', b.order_id, 'document_uploaded', null, {
            id,
            name,
            version,
            visibility: b.visibility,
          });
          documents.push({ id, name, version });
        }
        if (b.item_id) {
          await db.query(
            'UPDATE order_items SET photo_document_id=$2 WHERE id=$1 AND order_id=$3',
            [b.item_id, documents[0].id, b.order_id],
          );
          await db.query('UPDATE orders SET version=version+1,updated_at=now() WHERE id=$1', [
            b.order_id,
          ]);
          await audit(db, req.user.id, 'order', b.order_id, 'item_photo_updated', null, {
            item_id: b.item_id,
            document_id: documents[0].id,
          });
        }
        return files.length === 1 ? documents[0] : { documents };
      });
    } catch (e) {
      for (const key of storedKeys) await removeOrphan(key);
      throw e;
    }
  });
  app.get('/documents/:id/download', async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const q = z
      .object({
        version: z.coerce.number().int().positive().optional(),
        preview: z.enum(['1']).optional(),
      })
      .parse(req.query);
    const {
      rows: [d],
    } = await pool.query('SELECT * FROM documents WHERE id=$1', [id]);
    if (!d) throw new AppError(404, 'Документ не найден');
    await accessibleOrder(req.user, d.order_id);
    if (!allowed(req.user.role, d.visibility)) throw new AppError(403, 'Нет доступа к файлу');
    const version = q.version ?? d.current_version;
    if (version !== d.current_version) requireRole(req, 'owner', 'manager');
    const {
      rows: [v],
    } = await pool.query('SELECT * FROM document_versions WHERE document_id=$1 AND version=$2', [
      id,
      version,
    ]);
    if (!v) throw new AppError(404, 'Версия не найдена');
    const data = await fileBytes(v.storage_key);
    reply
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Type', v.mime)
      .header('Content-Security-Policy', "default-src 'none'; sandbox");
    const inline = q.preview && ['application/pdf', 'image/png', 'image/jpeg'].includes(v.mime);
    reply.header(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="document.${v.storage_key.split('.').pop()}"; filename*=UTF-8''${encodeURIComponent(v.name)}`,
    );
    return reply.send(data);
  });
  app.post('/orders/:id/contract', async (req) => {
    requireRole(req, 'owner', 'manager');
    const id = uuid.parse((req.params as any).id);
    await accessibleOrder(req.user, id);
    const b = z
      .object({ payment_terms: z.string().max(5000), contract_date: z.string().max(30) })
      .parse(req.body);
    let storedKey = '';
    try {
      return await transaction(async (db) => {
        const {
          rows: [s],
        } = await db.query('SELECT data FROM settings WHERE id=1');
        if (!s.data.contract_approved || !s.data.contract_template)
          throw new AppError(
            400,
            'Владелец должен загрузить и утвердить шаблон договора в настройках',
          );
        const {
          rows: [o],
        } = await db.query(
          'SELECT o.*,c.details client_details,c.email client_email FROM order_totals o JOIN clients c ON c.id=o.client_id WHERE o.id=$1',
          [id],
        );
        const items = (await db.query('SELECT * FROM order_items WHERE order_id=$1', [id])).rows;
        const template = await fileBytes(s.data.contract_template);
        const doc = new Docxtemplater(new PizZip(template), {
          paragraphLoop: true,
          linebreaks: true,
          nullGetter: () => '',
        });
        try {
          doc.render({
            company_name: s.data.company_name,
            legal_details: s.data.legal_details,
            client_name: o.client_name,
            client_phone: o.client_phone,
            client_address: o.client_address,
            client_details: o.client_details,
            order_number: o.number,
            contract_date: b.contract_date,
            order_title: o.title,
            items: items
              .map(
                (i) =>
                  `${i.model}, ${i.quantity} шт., ${i.dimensions}, ткань: ${i.fabric}, цвет: ${i.color}`,
              )
              .join('\n'),
            total: (o.total / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2 }),
            due_date: o.due_date,
            payment_terms: b.payment_terms,
          });
        } catch {
          throw new AppError(400, 'Ошибка тегов в шаблоне DOCX. Проверьте шаблон в настройках');
        }
        const data = doc.getZip().generate({ type: 'nodebuffer' });
        const name = `Договор_${o.number}.docx`;
        const f = await storeFile(db, name, data);
        storedKey = f.key;
        const {
          rows: [d],
        } = await db.query(
          "INSERT INTO documents(order_id,category,visibility,comment) VALUES($1,'contract','commercial','Сформирован по утверждённому шаблону') RETURNING id",
          [id],
        );
        await db.query(
          'INSERT INTO document_versions(document_id,version,name,storage_key,mime,size,sha256,author_id) VALUES($1,1,$2,$3,$4,$5,$6,$7)',
          [d.id, name, f.key, f.mime, f.size, f.sha256, req.user.id],
        );
        await audit(db, req.user.id, 'order', id, 'contract_generated', null, {
          document_id: d.id,
          name,
        });
        return d;
      });
    } catch (e) {
      if (storedKey) await removeOrphan(storedKey);
      throw e;
    }
  });
}
