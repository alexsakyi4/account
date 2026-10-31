import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { newId } from '../db/driver.js';
import { chartTemplate, INDUSTRIES, normalBalanceFor, SYSTEM_ACCOUNTS } from '../domain/accounts.js';
import { conflict, notFound, unprocessable } from '../lib/errors.js';
import { parse, paginationSchema, paging, paginated } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.js';

const accountSchema = z.object({
  code: z.string().min(1).max(20).regex(/^[A-Za-z0-9.-]+$/, 'Use letters, numbers, dots or dashes'),
  name: z.string().min(1).max(120),
  type: z.enum(['asset', 'liability', 'equity', 'income', 'expense']),
  subtype: z.string().max(50).optional(),
  parentId: z.string().uuid().nullable().optional(),
  description: z.string().max(500).optional(),
  isActive: z.boolean().optional(),
  currency: z.string().length(3).optional(),
});

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.get('/accounts', { preHandler: requireAuth() }, async (req) => {
    const ctx = req.ctx!;
    const query = parse(
      paginationSchema.extend({
        type: z.string().optional(),
        includeInactive: z.coerce.boolean().optional(),
        withBalances: z.coerce.boolean().optional(),
      }),
      req.query,
    );
    const where = ['a.tenant_id = ?'];
    const params: Array<string | number> = [ctx.tenantId];
    if (query.type) {
      where.push('a.type = ?');
      params.push(query.type);
    }
    if (!query.includeInactive) where.push('a.is_active = 1');
    if (query.q) {
      where.push('(LOWER(a.name) LIKE ? OR a.code LIKE ?)');
      params.push(`%${query.q.toLowerCase()}%`, `%${query.q}%`);
    }
    const rows = await req.db.all<Record<string, unknown>>(
      `SELECT a.*,
        (SELECT COUNT(*) FROM accounts c WHERE c.parent_id = a.id) AS child_count,
        COALESCE((SELECT SUM(jl.debit - jl.credit) FROM journal_lines jl
          JOIN journal_entries je ON je.id = jl.entry_id AND je.status = 'posted'
          WHERE jl.account_id = a.id), 0) AS raw_balance
       FROM accounts a WHERE ${where.join(' AND ')}
       ORDER BY a.code`,
      params,
    );
    const data = rows.map((row) => {
      const raw = Number(row.raw_balance ?? 0);
      const debitNormal = normalBalanceFor(String(row.type)) === 'debit';
      return {
        id: row.id,
        code: row.code,
        name: row.name,
        type: row.type,
        subtype: row.subtype,
        parentId: row.parent_id,
        description: row.description,
        isSystem: Number(row.is_system) === 1,
        systemKey: row.system_key,
        isActive: Number(row.is_active) === 1,
        childCount: Number(row.child_count ?? 0),
        balance: debitNormal ? raw : -raw,
      };
    });
    return { data, pagination: { total: data.length, page: 1, pageSize: data.length } };
  });

  app.get('/accounts/templates', { preHandler: requireAuth() }, async () => ({
    industries: INDUSTRIES,
    templates: Object.fromEntries(INDUSTRIES.map((industry) => [industry, chartTemplate(industry)])),
  }));

  app.get('/accounts/:id', { preHandler: requireAuth() }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const ctx = req.ctx!;
    const account = await req.db.get<Record<string, unknown>>('SELECT * FROM accounts WHERE tenant_id = ? AND id = ?', [ctx.tenantId, id]);
    if (!account) throw notFound('Account not found');
    const children = await req.db.all('SELECT id, code, name, type FROM accounts WHERE tenant_id = ? AND parent_id = ? ORDER BY code', [ctx.tenantId, id]);
    const activity = await req.db.all(
      `SELECT je.id, je.date, je.entry_no, je.memo, jl.debit, jl.credit, je.source_type
       FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
       WHERE jl.tenant_id = ? AND jl.account_id = ? AND je.status = 'posted'
       ORDER BY je.date DESC, je.entry_no DESC LIMIT 50`,
      [ctx.tenantId, id],
    );
    return { account, children, activity };
  });

  app.post('/accounts', { preHandler: requireAuth('accounts:write') }, async (req, reply) => {
    const body = parse(accountSchema, req.body);
    const ctx = req.ctx!;
    const existing = await req.db.get('SELECT id FROM accounts WHERE tenant_id = ? AND code = ?', [ctx.tenantId, body.code]);
    if (existing) throw conflict(`Account code ${body.code} is already in use`);
    if (body.parentId) {
      const parent = await req.db.get('SELECT id FROM accounts WHERE tenant_id = ? AND id = ?', [ctx.tenantId, body.parentId]);
      if (!parent) throw unprocessable('Parent account not found');
    }
    const id = newId();
    const now = new Date().toISOString();
    await req.db.run(
      `INSERT INTO accounts (id, tenant_id, code, name, type, subtype, parent_id, description, is_system, is_active, currency, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      [id, ctx.tenantId, body.code, body.name, body.type, body.subtype ?? null, body.parentId ?? null, body.description ?? null, body.isActive === false ? 0 : 1, body.currency ?? ctx.tenant.base_currency, now, now],
    );
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'account.created',
      entityType: 'account',
      entityId: id,
      summary: `Created account ${body.code} ${body.name}`,
      after: body,
    });
    return reply.code(201).send({ id });
  });

  app.patch('/accounts/:id', { preHandler: requireAuth('accounts:write') }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(accountSchema.partial(), req.body);
    const ctx = req.ctx!;
    const before = await req.db.get<Record<string, unknown>>('SELECT * FROM accounts WHERE tenant_id = ? AND id = ?', [ctx.tenantId, id]);
    if (!before) throw notFound('Account not found');
    if (body.parentId === id) throw unprocessable('An account cannot be its own parent');
    if (body.code && body.code !== before.code) {
      const clash = await req.db.get('SELECT id FROM accounts WHERE tenant_id = ? AND code = ? AND id <> ?', [ctx.tenantId, body.code, id]);
      if (clash) throw conflict(`Account code ${body.code} is already in use`);
    }
    await req.db.run(
      `UPDATE accounts SET code = ?, name = ?, type = ?, subtype = ?, parent_id = ?, description = ?, is_active = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
      [
        body.code ?? before.code,
        body.name ?? before.name,
        body.type ?? before.type,
        body.subtype ?? before.subtype,
        body.parentId === undefined ? before.parent_id : body.parentId,
        body.description ?? before.description,
        body.isActive === undefined ? before.is_active : body.isActive ? 1 : 0,
        new Date().toISOString(),
        ctx.tenantId,
        id,
      ],
    );
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'account.updated',
      entityType: 'account',
      entityId: id,
      summary: `Updated account ${body.code ?? before.code}`,
      before,
      after: body,
    });
    return { ok: true };
  });

  app.delete('/accounts/:id', { preHandler: requireAuth('accounts:write') }, async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const ctx = req.ctx!;
    const account = await req.db.get<{ is_system: number; code: string; name: string }>(
      'SELECT * FROM accounts WHERE tenant_id = ? AND id = ?',
      [ctx.tenantId, id],
    );
    if (!account) throw notFound('Account not found');
    if (Number(account.is_system) === 1) throw conflict('System accounts are used by automation and cannot be deleted. Deactivate it instead.');
    const used = await req.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM journal_lines WHERE account_id = ?', [id]);
    if (Number(used?.n ?? 0) > 0) throw conflict('This account has transactions. Deactivate it instead of deleting.');
    const children = await req.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM accounts WHERE parent_id = ?', [id]);
    if (Number(children?.n ?? 0) > 0) throw conflict('Remove or reparent sub-accounts first');
    await req.db.run('DELETE FROM accounts WHERE tenant_id = ? AND id = ?', [ctx.tenantId, id]);
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'account.deleted',
      entityType: 'account',
      entityId: id,
      summary: `Deleted account ${account.code} ${account.name}`,
      before: account,
    });
    return reply.code(204).send();
  });

  app.post('/accounts/apply-template', { preHandler: requireAuth('accounts:write') }, async (req) => {
    const body = parse(z.object({ industry: z.string().min(2) }), req.body);
    const ctx = req.ctx!;
    const template = chartTemplate(body.industry);
    let created = 0;
    let skipped = 0;
    for (const account of template) {
      const existing = await req.db.get('SELECT id FROM accounts WHERE tenant_id = ? AND code = ?', [ctx.tenantId, account.code]);
      if (existing) {
        skipped += 1;
        continue;
      }
      await req.db.run(
        `INSERT INTO accounts (id, tenant_id, code, name, type, subtype, parent_id, description, is_system, system_key, is_active, currency, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1, ?, ?, ?)`,
        [
          newId(),
          ctx.tenantId,
          account.code,
          account.name,
          account.type,
          account.subtype,
          account.description ?? null,
          account.systemKey ? 1 : 0,
          account.systemKey ?? null,
          ctx.tenant.base_currency,
          new Date().toISOString(),
          new Date().toISOString(),
        ],
      );
      created += 1;
    }
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'account.template_applied',
      entityType: 'account',
      summary: `Applied ${body.industry} chart template (${created} created, ${skipped} skipped)`,
      after: { industry: body.industry, created, skipped },
    });
    return { created, skipped };
  });

  // ------------------------------------------------------------ periods --
  app.get('/periods', { preHandler: requireAuth() }, async (req) => {
    const ctx = req.ctx!;
    const periods = await req.db.all(
      `SELECT p.*,
        (SELECT COUNT(*) FROM journal_entries je WHERE je.tenant_id = p.tenant_id AND je.date BETWEEN p.start_date AND p.end_date AND je.status = 'posted') AS entry_count
       FROM fiscal_periods p WHERE p.tenant_id = ? ORDER BY p.start_date DESC`,
      [ctx.tenantId],
    );
    return { data: periods };
  });

  app.post('/periods/generate', { preHandler: requireAuth('accounts:write') }, async (req) => {
    const body = parse(z.object({ year: z.coerce.number().int().min(2000).max(2100), status: z.enum(['open', 'closed']).optional() }), req.body);
    const ctx = req.ctx!;
    let created = 0;
    for (let month = 0; month < 12; month += 1) {
      const start = new Date(Date.UTC(body.year, month, 1)).toISOString().slice(0, 10);
      const end = new Date(Date.UTC(body.year, month + 1, 0)).toISOString().slice(0, 10);
      const existing = await req.db.get('SELECT id FROM fiscal_periods WHERE tenant_id = ? AND start_date = ?', [ctx.tenantId, start]);
      if (existing) continue;
      await req.db.run(
        `INSERT INTO fiscal_periods (id, tenant_id, name, start_date, end_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          newId(),
          ctx.tenantId,
          new Date(start).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
          start,
          end,
          body.status ?? 'open',
          new Date().toISOString(),
        ],
      );
      created += 1;
    }
    return { created };
  });

  app.post('/periods/:id/publish', { preHandler: requireAuth('accounts:write') }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(z.object({ status: z.enum(['open', 'closed', 'locked']) }), req.body);
    const ctx = req.ctx!;
    const period = await req.db.get<{ name: string; status: string }>(
      'SELECT * FROM fiscal_periods WHERE tenant_id = ? AND id = ?',
      [ctx.tenantId, id],
    );
    if (!period) throw notFound('Period not found');
    await req.db.run('UPDATE fiscal_periods SET status = ?, closed_at = ?, closed_by = ? WHERE tenant_id = ? AND id = ?', [
      body.status,
      body.status === 'open' ? null : new Date().toISOString(),
      body.status === 'open' ? null : ctx.user.id,
      ctx.tenantId,
      id,
    ]);
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: `period.${body.status}`,
      entityType: 'fiscal_period',
      entityId: id,
      summary: `Period ${period.name} set to ${body.status}`,
      before: { status: period.status },
      after: { status: body.status },
    });
    return { ok: true };
  });

  app.get('/accounts/system-keys', { preHandler: requireAuth() }, async () => ({ data: SYSTEM_ACCOUNTS }));
}
