import type { FastifyInstance } from 'fastify';
import PizZip from 'pizzip';
import { z } from 'zod';
import {
  documentFieldsSchema,
  documentGenerationSchema,
  documentPartySchema,
  generatedDocumentLabels,
  type DocumentFields,
} from '../../shared/document-generation.js';
import { AppError, audit, hash, idempotent, pool, transaction, type DB } from '../db.js';
import { accessibleOrder, requireRole, uuid } from '../security.js';
import { fileBytes, removeOrphan, storeFile } from '../files.js';
import { itemDescription, longDate } from '../document-data.js';
import { generateDocument } from '../document-engine.js';
import { imageSize, type OfficeImage } from '../office-xml.js';

async function context(db: DB, id: string) {
  const order = (await db.query('SELECT * FROM order_totals WHERE id=$1', [id])).rows[0];
  const client = (await db.query('SELECT * FROM clients WHERE id=$1', [order.client_id])).rows[0];
  const items = (
    await db.query('SELECT * FROM order_items WHERE order_id=$1 ORDER BY position,id', [id])
  ).rows;
  const settings = (await db.query('SELECT data,version FROM settings WHERE id=1')).rows[0];
  const plans = (
    await db.query('SELECT * FROM payment_plans WHERE order_id=$1 ORDER BY due_date,id', [id])
  ).rows;
  const images = (
    await db.query(
      "SELECT d.id,d.visibility,v.name,v.storage_key,v.mime,v.size,v.sha256,v.version FROM documents d JOIN document_versions v ON v.document_id=d.id AND v.version=d.current_version WHERE d.order_id=$1 AND v.mime IN ('image/png','image/jpeg') ORDER BY d.created_at,d.id",
      [id],
    )
  ).rows;
  const source = { order, client, items, settings, plans, images };
  return { ...source, token: hash(JSON.stringify(source)) };
}
function defaults(source: Awaited<ReturnType<typeof context>>) {
  const { order, client, settings, plans, items } = source;
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.COMPANY_TIMEZONE || 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const fromClient = documentPartySchema.parse(client.document_details || {}),
    fromCompany = documentPartySchema.parse(settings.data.document_company || {});
  const buyer = documentPartySchema.parse({
    ...fromClient,
    name: fromClient.name || client.name,
    address: fromClient.address || client.address,
    phone: fromClient.phone || client.phone,
    email: fromClient.email || client.email,
    details: fromClient.details || client.details,
  });
  const seller = documentPartySchema.parse({
    ...fromCompany,
    name: fromCompany.name || settings.data.company_name,
    details: fromCompany.details || settings.data.legal_details || '',
  });
  const advance =
    plans.find((p) => /аванс|предоплат/i.test(p.title))?.amount ?? plans[0]?.amount ?? 0;
  const fields = documentFieldsSchema.parse({
    contract_number: order.number,
    contract_date: today,
    document_number: order.number,
    document_date: today,
    delivery_address: client.address,
    production_terms: 'До ' + longDate(order.due_date),
    advance_amount: Math.min(order.total, advance),
    ...order.document_details,
  });
  return {
    buyer,
    seller,
    fields,
    item_images: Object.fromEntries(
      items
        .filter((i) => source.images.some((image) => image.id === i.photo_document_id))
        .map((i) => [i.id, i.photo_document_id]),
    ),
    item_descriptions: Object.fromEntries(items.map((i) => [i.id, itemDescription(i)])),
  };
}
function assertRoles(role: string, kinds: string[]) {
  if (role === 'master' || (role === 'accountant' && kinds.some((k) => k !== 'invoice')))
    throw new AppError(403, 'Нет доступа к этому виду документов');
}
function assertFields(fields: DocumentFields, kinds: string[]) {
  if (kinds.includes('contract')) {
    if (!fields.city) throw new AppError(400, 'Укажите город заключения договора');
    if (!fields.delivery_address) throw new AppError(400, 'Укажите адрес доставки для договора');
    if (!fields.production_terms) throw new AppError(400, 'Укажите срок изготовления');
    if (!fields.delivery_terms) throw new AppError(400, 'Укажите условия доставки и сборки');
  }
}
export async function documentGenerationRoutes(app: FastifyInstance) {
  app.get('/orders/:id/document-data', async (req) => {
    requireRole(req, 'owner', 'manager', 'accountant');
    const id = uuid.parse((req.params as any).id);
    await accessibleOrder(req.user, id);
    const data = await transaction(async (db) => {
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      return context(db, id);
    });
    const initial = defaults(data);
    if (req.user.role === 'accountant') initial.item_images = {};
    return {
      source_token: data.token,
      ...initial,
      order: {
        id,
        number: data.order.number,
        title: data.order.title,
        total: data.order.total,
        discount: data.order.discount,
      },
      items: data.items.map((i) => ({
        id: i.id,
        model: i.model,
        quantity: i.quantity,
        price: i.price,
        description: itemDescription(i),
      })),
      images:
        req.user.role === 'accountant'
          ? []
          : data.images.map(({ id, name, version }) => ({ id, name, version })),
      allowed_kinds:
        req.user.role === 'accountant'
          ? ['invoice']
          : ['contract', 'appendix', 'proposal', 'invoice'],
    };
  });
  app.post('/orders/:id/generate-documents', async (req) => {
    requireRole(req, 'owner', 'manager', 'accountant');
    const id = uuid.parse((req.params as any).id),
      body = documentGenerationSchema.parse(req.body);
    assertRoles(req.user.role, body.kinds);
    if (body.save_company && req.user.role !== 'owner')
      throw new AppError(403, 'Реквизиты компании сохраняет владелец');
    if (body.save_client && req.user.role === 'accountant')
      throw new AppError(403, 'Реквизиты клиента сохраняют владелец и менеджер');
    if (!body.buyer.name || !body.seller.name)
      throw new AppError(400, 'Укажите наименования заказчика и исполнителя');
    assertFields(body.fields, body.kinds);
    const stored: string[] = [];
    try {
      return await transaction(async (db) =>
        idempotent(
          db,
          body.idempotency_key,
          req.user.id,
          'generate-documents:' + id,
          body,
          async () => {
            const locked = await accessibleOrder(req.user, id, db, true);
            // Uploading a new version locks its document before taking the quota lock.
            await db.query(
              'SELECT id FROM documents WHERE order_id=$1 AND generated_kind IS NOT NULL ORDER BY id FOR UPDATE',
              [id],
            );
            await db.query('SELECT id FROM settings WHERE id=1 FOR UPDATE');
            await db.query('SELECT id FROM clients WHERE id=$1 FOR UPDATE', [locked.client_id]);
            const source = await context(db, id);
            if (source.token !== body.source_token)
              throw new AppError(
                409,
                'Карточка заказа, клиента или настройки изменились. Обновите данные формы',
              );
            if (body.fields.advance_amount > source.order.total)
              throw new AppError(400, 'Аванс больше стоимости заказа');
            const itemIds = new Set(source.items.map((i) => i.id)),
              photoIds = new Set(source.images.map((i) => i.id));
            for (const itemId of [
              ...Object.keys(body.item_images),
              ...Object.keys(body.item_descriptions),
            ])
              if (!itemIds.has(itemId))
                throw new AppError(400, 'Изделие отсутствует в этом заказе');
            for (const imageId of Object.values(body.item_images))
              if (!photoIds.has(imageId))
                throw new AppError(400, 'Выберите изображение из документов этого заказа');
            if (req.user.role === 'accountant' && Object.keys(body.item_images).length)
              throw new AppError(403, 'Бухгалтер формирует накладную без изображений');
            const images = new Map<string, OfficeImage>();
            const needsImages = body.kinds.some((k) => k === 'appendix' || k === 'proposal');
            const selected = source.images.filter((i) =>
              Object.values(body.item_images).includes(i.id),
            );
            if (needsImages && selected.reduce((sum, i) => sum + i.size, 0) > 20 * 1024 * 1024)
              throw new AppError(
                400,
                'Общий размер выбранных фотографий — до 20 МБ. Уменьшите фотографии или выберите меньше файлов',
              );
            if (needsImages)
              for (const imageId of new Set(Object.values(body.item_images))) {
                const info = source.images.find((i) => i.id === imageId)!,
                  data = await fileBytes(info.storage_key);
                try {
                  images.set(imageId, {
                    id: imageId,
                    data,
                    mime: info.mime,
                    ...imageSize(data, info.mime),
                  });
                } catch {
                  throw new AppError(
                    400,
                    `Не удалось прочитать фото «${info.name}». Выберите другой JPG или PNG`,
                  );
                }
              }
            const documents = [];
            for (const kind of body.kinds) {
              const generated = await generateDocument(kind, {
                order: source.order,
                items: source.items,
                buyer: body.buyer,
                seller: body.seller,
                fields: body.fields,
                item_images: body.item_images,
                item_descriptions: body.item_descriptions,
                images,
              });
              const visibility = kind === 'invoice' ? 'financial' : 'commercial';
              let document = (
                await db.query(
                  'SELECT * FROM documents WHERE order_id=$1 AND generated_kind=$2 FOR UPDATE',
                  [id, kind],
                )
              ).rows[0];
              if (document) {
                document = (
                  await db.query(
                    'UPDATE documents SET current_version=current_version+1 WHERE id=$1 RETURNING *',
                    [document.id],
                  )
                ).rows[0];
              } else
                document = (
                  await db.query(
                    'INSERT INTO documents(order_id,category,visibility,comment,generated_kind) VALUES($1,$2,$3,$4,$2) RETURNING *',
                    [id, kind, visibility, 'Сформирован из карточки заказа'],
                  )
                ).rows[0];
              const file = await storeFile(db, generated.name, generated.data);
              stored.push(file.key);
              await db.query(
                'INSERT INTO document_versions(document_id,version,name,storage_key,mime,size,sha256,author_id,generation_data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
                [
                  document.id,
                  document.current_version,
                  generated.name,
                  file.key,
                  file.mime,
                  file.size,
                  file.sha256,
                  req.user.id,
                  {
                    template: kind,
                    template_version: '1.2',
                    source_token: body.source_token,
                    buyer: body.buyer,
                    seller: body.seller,
                    fields: body.fields,
                    item_images: body.item_images,
                    item_descriptions: body.item_descriptions,
                    total: source.order.total,
                    discount: source.order.discount,
                    lines: generated.lines,
                  },
                ],
              );
              documents.push({
                id: document.id,
                name: generated.name,
                version: document.current_version,
                kind,
                label: generatedDocumentLabels[kind],
              });
              await audit(db, req.user.id, 'order', id, 'document_generated', null, {
                document_id: document.id,
                kind,
                version: document.current_version,
                name: generated.name,
              });
            }
            await db.query(
              'UPDATE orders SET document_details=$2,version=version+1,updated_at=now() WHERE id=$1',
              [id, body.fields],
            );
            if (req.user.role !== 'accountant')
              for (const item of source.items)
                await db.query('UPDATE order_items SET photo_document_id=$2 WHERE id=$1', [
                  item.id,
                  body.item_images[item.id] || null,
                ]);
            if (body.save_client) {
              await db.query(
                'UPDATE clients SET document_details=$2,version=version+1 WHERE id=$1',
                [source.client.id, body.buyer],
              );
              await audit(db, req.user.id, 'client', source.client.id, 'document_details_updated');
            }
            if (body.save_company) {
              await db.query(
                "UPDATE settings SET data=jsonb_set(data,'{document_company}',$1::jsonb),version=version+1 WHERE id=1",
                [JSON.stringify(body.seller)],
              );
              await audit(db, req.user.id, 'settings', '1', 'document_details_updated');
            }
            return { documents };
          },
        ),
      );
    } catch (e) {
      for (const key of stored) await removeOrphan(key);
      throw e;
    }
  });
  app.get('/orders/:id/document-bundle', async (req, reply) => {
    requireRole(req, 'owner', 'manager', 'accountant');
    const id = uuid.parse((req.params as any).id);
    await accessibleOrder(req.user, id);
    const q = z.object({ files: z.string().max(1000) }).parse(req.query);
    // Each entry pins a version, so a later regeneration cannot alter this download.
    const entries = q.files.split(',').map((s) => {
      const [docId, version] = s.split(':');
      return { id: uuid.parse(docId), version: z.coerce.number().int().positive().parse(version) };
    });
    if (
      !entries.length ||
      entries.length > 4 ||
      new Set(entries.map((e) => e.id)).size !== entries.length
    )
      throw new AppError(400, 'Выберите до четырёх документов');
    const archive = new PizZip();
    for (const entry of entries) {
      const row = (
        await pool.query(
          'SELECT d.generated_kind,d.visibility,v.name,v.storage_key FROM documents d JOIN document_versions v ON v.document_id=d.id WHERE d.id=$1 AND d.order_id=$2 AND v.version=$3',
          [entry.id, id, entry.version],
        )
      ).rows[0];
      if (!row?.generated_kind) throw new AppError(404, 'Документ не найден');
      assertRoles(req.user.role, [row.generated_kind]);
      if (req.user.role === 'accountant') {
        const current = (
          await pool.query('SELECT current_version FROM documents WHERE id=$1', [entry.id])
        ).rows[0];
        if (entry.version !== current.current_version)
          throw new AppError(403, 'История версий доступна владельцу и менеджеру');
      }
      archive.file(row.name, await fileBytes(row.storage_key));
    }
    return reply
      .header('Content-Type', 'application/zip')
      .header('Cache-Control', 'private, no-store')
      .header('Content-Disposition', `attachment; filename="LOOMA-documents.zip"`)
      .send(archive.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));
  });
}
