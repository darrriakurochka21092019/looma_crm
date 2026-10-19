import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, audit, pool, transaction } from '../db.js';
import { requireRole } from '../security.js';
import { fileBytes, removeOrphan, storeFile, validateFile } from '../files.js';
import { documentPartySchema } from '../../shared/document-generation.js';
export async function settingsRoutes(app: FastifyInstance) {
  app.get('/company', async () => {
    const {
      rows: [s],
    } = await pool.query('SELECT data FROM settings WHERE id=1');
    return { company_name: s.data.company_name, timezone: s.data.timezone };
  });
  app.get('/settings', async (req) => {
    requireRole(req, 'owner');
    return (await pool.query('SELECT data,version FROM settings WHERE id=1')).rows[0];
  });
  app.patch('/settings', async (req) => {
    requireRole(req, 'owner');
    const b = z
      .object({
        version: z.number().int(),
        company_name: z.string().trim().min(1).max(200),
        legal_details: z.string().max(10000),
        document_company: documentPartySchema.optional(),
        timezone: z.literal(process.env.COMPANY_TIMEZONE || 'Europe/Moscow'),
        tax_regime: z.string().max(200),
        tax_base: z.enum(['receipts', 'management_profit']),
        tax_rate_bps: z.number().int().min(0).max(10000),
        opening_balance: z.number().int().min(-9e12).max(9e12),
        manager_can_close: z.boolean(),
        contract_approved: z.boolean(),
        max_file_mb: z.number().int().min(1).max(25),
        storage_quota_mb: z.number().int().min(50).max(100000),
        step_names: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
      })
      .parse(req.body);
    return transaction(async (db) => {
      const {
        rows: [old],
      } = await db.query('SELECT * FROM settings WHERE id=1 FOR UPDATE');
      if (old.version !== b.version)
        throw new AppError(409, 'Настройки изменились. Обновите страницу');
      if (b.contract_approved && !old.data.contract_template)
        throw new AppError(400, 'Сначала загрузите шаблон DOCX');
      const { version, ...values } = b;
      const n = { ...old.data, ...values };
      await db.query('UPDATE settings SET data=$1,version=version+1 WHERE id=1', [n]);
      await audit(db, req.user.id, 'settings', '1', 'updated', old.data, n);
      return { data: n, version: version + 1 };
    });
  });
  app.post('/settings/contract-template', async (req) => {
    requireRole(req, 'owner');
    const f = await req.file();
    if (!f) throw new AppError(400, 'Выберите DOCX');
    const data = await f.toBuffer();
    const mime = validateFile(f.filename, data, ['.docx']);
    let key = '';
    try {
      return await transaction(async (db) => {
        const stored = await storeFile(db, f.filename, data, mime);
        key = stored.key;
        await db.query(
          "UPDATE settings SET data=jsonb_set(jsonb_set(data,'{contract_template}',to_jsonb($1::text)),'{contract_approved}','false'),version=version+1 WHERE id=1",
          [key],
        );
        await audit(db, req.user.id, 'settings', '1', 'contract_template_uploaded', null, {
          name: f.filename,
        });
        return { ok: true };
      });
    } catch (e) {
      if (key) await removeOrphan(key);
      throw e;
    }
  });
  app.get('/settings/contract-template', async (req, reply) => {
    requireRole(req, 'owner');
    const {
      rows: [s],
    } = await pool.query('SELECT data FROM settings WHERE id=1');
    if (!s.data.contract_template) throw new AppError(404, 'Шаблон ещё не загружен');
    reply
      .header(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      )
      .header('Content-Disposition', 'attachment; filename="LOOMA-contract-template.docx"');
    return reply.send(await fileBytes(s.data.contract_template));
  });
  app.get('/audit', async (req) => {
    requireRole(req, 'owner');
    return (
      await pool.query(
        'SELECT a.*,u.name author_name FROM audit_events a LEFT JOIN users u ON u.id=a.author_id ORDER BY a.id DESC LIMIT 200',
      )
    ).rows;
  });
}
