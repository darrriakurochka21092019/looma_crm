import type { FastifyInstance } from 'fastify';
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AppError, audit, hash, pool, transaction } from '../db.js';
import { requireRole, uuid } from '../security.js';
const cookieOptions = () => ({
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: process.env.COOKIE_SECURE === 'true',
  path: '/api',
  maxAge: 60 * 60 * 12,
});
export async function authRoutes(app: FastifyInstance) {
  const dummyHash = await argon2.hash(randomBytes(32), { type: argon2.argon2id });
  app.post(
    '/auth/login',
    { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const b = z
        .object({
          email: z
            .string()
            .email()
            .transform((s) => s.toLowerCase()),
          password: z.string().min(1).max(256),
        })
        .parse(req.body);
      const {
        rows: [u],
      } = await pool.query('SELECT * FROM users WHERE email=$1 AND active', [b.email]);
      const valid = await argon2.verify(u?.password_hash || dummyHash, b.password);
      if (!u || !valid) throw new AppError(401, 'Неверный email или пароль');
      const token = randomBytes(32).toString('hex');
      await transaction(async (db) => {
        await db.query('DELETE FROM sessions WHERE expires_at<now()');
        await db.query(
          "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '12 hours')",
          [hash(token), u.id],
        );
        await audit(db, u.id, 'user', u.id, 'login');
      });
      reply.setCookie('looma_session', token, cookieOptions());
      return { id: u.id, name: u.name, email: u.email, role: u.role, active: u.active };
    },
  );
  app.get('/auth/me', async (req) => req.user);
  app.post('/auth/logout', async (req, reply) => {
    await pool.query('DELETE FROM sessions WHERE token_hash=$1', [
      hash(req.cookies.looma_session || ''),
    ]);
    reply.clearCookie('looma_session', { path: '/api' });
    return { ok: true };
  });
  app.post('/auth/password', async (req, reply) => {
    const b = z
      .object({ current: z.string().max(256), password: z.string().min(12).max(128) })
      .parse(req.body);
    const {
      rows: [u],
    } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
    if (!(await argon2.verify(u.password_hash, b.current)))
      throw new AppError(400, 'Текущий пароль неверен');
    await transaction(async (db) => {
      await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [
        await argon2.hash(b.password, { type: argon2.argon2id }),
        req.user.id,
      ]);
      await db.query('DELETE FROM sessions WHERE user_id=$1', [req.user.id]);
      await audit(db, req.user.id, 'user', req.user.id, 'password_changed');
    });
    reply.clearCookie('looma_session', { path: '/api' });
    return { ok: true };
  });
  app.get('/users', async (req) => {
    const owner = req.user.role === 'owner';
    const { rows } = await pool.query(
      `SELECT id,name,role,active${owner ? ',email' : ''} FROM users ${owner ? '' : 'WHERE active'} ORDER BY name`,
    );
    return rows;
  });
  app.post('/users/invite', async (req) => {
    requireRole(req, 'owner');
    const b = z
      .object({
        email: z
          .string()
          .email()
          .transform((s) => s.toLowerCase()),
        name: z.string().trim().min(1).max(150),
        role: z.enum(['manager', 'accountant', 'master']),
      })
      .parse(req.body);
    const token = randomBytes(32).toString('hex');
    await transaction(async (db) => {
      if ((await db.query('SELECT 1 FROM users WHERE email=$1', [b.email])).rowCount)
        throw new AppError(409, 'Сотрудник с этим email уже существует');
      await db.query(
        "INSERT INTO invitations(email,name,role,token_hash,expires_at,created_by) VALUES($1,$2,$3,$4,now()+interval '2 days',$5)",
        [b.email, b.name, b.role, hash(token), req.user.id],
      );
      await audit(db, req.user.id, 'invitation', b.email, 'created', null, {
        name: b.name,
        role: b.role,
      });
    });
    return {
      link: `${process.env.APP_ORIGIN || 'http://localhost:5173'}/?invite=${token}`,
      expires_in: '48 часов',
    };
  });
  app.get('/auth/invite/:token', async (req) => {
    const { token } = req.params as { token: string };
    if (!/^[a-f0-9]{64}$/.test(token)) throw new AppError(404, 'Приглашение не найдено');
    const {
      rows: [i],
    } = await pool.query(
      'SELECT name,email,role FROM invitations WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now()',
      [hash(token)],
    );
    if (!i) throw new AppError(410, 'Срок приглашения истёк или оно уже использовано');
    return i;
  });
  app.post('/auth/accept-invite', async (req) => {
    const b = z
      .object({ token: z.string().regex(/^[a-f0-9]{64}$/), password: z.string().min(12).max(128) })
      .parse(req.body);
    const passwordHash = await argon2.hash(b.password, { type: argon2.argon2id });
    await transaction(async (db) => {
      const {
        rows: [i],
      } = await db.query(
        'SELECT * FROM invitations WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() FOR UPDATE',
        [hash(b.token)],
      );
      if (!i) throw new AppError(410, 'Приглашение недействительно');
      const {
        rows: [u],
      } = await db.query(
        'INSERT INTO users(name,email,role,password_hash) VALUES($1,$2,$3,$4) RETURNING id',
        [i.name, i.email, i.role, passwordHash],
      );
      await db.query('UPDATE invitations SET used_at=now() WHERE id=$1', [i.id]);
      await audit(db, u.id, 'user', u.id, 'invitation_accepted');
    });
    return { ok: true };
  });
  app.patch('/users/:id', async (req) => {
    requireRole(req, 'owner');
    const id = uuid.parse((req.params as any).id);
    const b = z
      .object({ role: z.enum(['owner', 'manager', 'accountant', 'master']), active: z.boolean() })
      .parse(req.body);
    if (id === req.user.id) throw new AppError(400, 'Свою роль и активность изменить нельзя');
    return transaction(async (db) => {
      const {
        rows: [old],
      } = await db.query('SELECT id,name,email,role,active FROM users WHERE id=$1 FOR UPDATE', [
        id,
      ]);
      if (!old) throw new AppError(404, 'Сотрудник не найден');
      await db.query('UPDATE users SET role=$2,active=$3 WHERE id=$1', [id, b.role, b.active]);
      await db.query('DELETE FROM sessions WHERE user_id=$1', [id]);
      await audit(db, req.user.id, 'user', id, 'permissions_changed', old, b);
      return { ok: true };
    });
  });
}
