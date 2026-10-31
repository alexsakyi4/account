import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { postJournal, reverseJournal, voidJournal } from '../domain/ledger.js';
import { conflict, notFound } from '../lib/errors.js';
import { toCsv } from '../lib/csv.js';
import { paginated, paging, paginationSchema, parse } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.js';
import { emitEvent } from '../services/events.js';

const entrySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  memo: z.string().max(500).optional(),
  currency: z.string().length(3).optional(),
  fxRate: z.coerce.number().positive().optional(),
  sourceType: z.enum(['manual', 'adjusting', 'opening']).default('manual'),
  lines: z
    .array(
      z.object({
        accountId: z.string().uuid(),
        debit: z.coerce.number().int().min(0).default(0),
        credit: z.coerce.number().int().min(0).default(0),
        description: z.string().max(300).optional(),
        contactId: z.string().uuid().nullable().optional(),
        taxCodeId: z.string().uuid().nullable().optional(),
      }),
    )
    .min(2)
    .max(200),
});

export async function journalRoutes(app: FastifyInstance): Promise<void> {
  app.get('/journal-entries', { preHandler: requireAuth('reports:read') }, async (req) => {
    const ctx = req.ctx!;
    const query = parse(
      paginationSchema.extend({
        sourceType: z.string().optional(),
        accountId: z.string().optional(),
        status: z.enum(['posted', 'void', 'reversed', 'all']).default('all'),
      }),
      req.query,
    );
    const where = ['je.tenant_id = ?'];
    const params: Array<string | number> = [ctx.tenantId];
    if (query.from) {
      where.push('je.date >= ?');
      params.push(query.from);
    }
    if (query.to) {
      where.push('je.date <= ?');
      params.push(query.to);
    }
    if (query.sourceType && query.sourceType !== 'all') {
      where.push('je.source_type = ?');
      params.push(query.sourceType);
    }
    if (query.status !== 'all') {
      where.push('je.status = ?');
      params.push(query.status);
    }
    if (query.q) {
      where.push('(LOWER(COALESCE(je.memo, \'\')) LIKE ? OR CAST(je.entry_no AS TEXT) LIKE ?)');
      const like = `%${query.q.toLowerCase()}%`;
      params.push(like, `%${query.q}%`);
    }
    if (query.accountId) {
      where.push('EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id = je.id AND l.account_id = ?)');
      params.push(query.accountId);
    }
    const { limit, offset } = paging(query.page, query.pageSize);
    const total = await req.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries je WHERE ${where.join(' AND ')}`, params);
    const rows = await req.db.all<Record<string, unknown>>(
      `SELECT je.*, (SELECT COALESCE(SUM(jl.debit),0) FROM journal_lines jl WHERE jl.entry_id = je.id) AS total
       FROM journal_entries je WHERE ${where.join(' AND ')}
       ORDER BY je.date DESC, je.entry_no DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return paginated(rows, Number(total?.n ?? 0), query.page, query.pageSize);
  });

  app.get('/journal-entries/:id', { preHandler: requireAuth('reports:read') }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const ctx = req.ctx!;
    const entry = await req.db.get<Record<string, unknown>>('SELECT * FROM journal_entries WHERE tenant_id = ? AND id = ?', [ctx.tenantId, id]);
    if (!entry) throw notFound('Journal entry not found');
    const lines = await req.db.all(
      `SELECT jl.*, a.code, a.name AS account_name, a.type FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id WHERE jl.entry_id = ? ORDER BY jl.line_no`,
      [id],
    );
    return { entry, lines };
  });

  app.post('/journal-entries', { preHandler: requireAuth('journal:write') }, async (req, reply) => {
    const body = parse(entrySchema, req.body);
    const ctx = req.ctx!;
    const entryId = await postJournal(req.db, {
      tenantId: ctx.tenantId,
      date: body.date,
      memo: body.memo,
      sourceType: body.sourceType,
      currency: body.currency ?? ctx.tenant.base_currency,
      fxRate: body.fxRate,
      createdBy: ctx.user.id,
      lines: body.lines,
    });
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'journal.posted',
      entityType: 'journal_entry',
      entityId: entryId,
      summary: `Manual journal entry: ${body.memo ?? 'no memo'}`,
      after: { lines: body.lines.length },
    });
    await emitEvent(req.db, ctx.tenantId, 'journal.posted', { entryId });
    return reply.code(201).send({ id: entryId });
  });

  app.post('/journal-entries/:id/reverse', { preHandler: requireAuth('journal:write') }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const ctx = req.ctx!;
    const reversalId = await reverseJournal(req.db, ctx.tenantId, id, ctx.user.id);
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'journal.reversed',
      entityType: 'journal_entry',
      entityId: id,
      summary: 'Journal entry reversed',
      after: { reversalId },
    });
    return { id: reversalId };
  });

  app.post('/journal-entries/:id/void', { preHandler: requireAuth('journal:write') }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const ctx = req.ctx!;
    const entry = await req.db.get<{ status: string }>('SELECT status FROM journal_entries WHERE tenant_id = ? AND id = ?', [ctx.tenantId, id]);
    if (!entry) throw notFound('Journal entry not found');
    if (entry.status !== 'posted') throw conflict('Only posted entries can be voided');
    await voidJournal(req.db, ctx.tenantId, id);
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'journal.voided',
      entityType: 'journal_entry',
      entityId: id,
      summary: 'Journal entry voided',
    });
    return { ok: true };
  });

  app.get('/journal-entries/export', { preHandler: requireAuth('data:export') }, async (req) => {
    const ctx = req.ctx!;
    const query = parse(z.object({ from: z.string().optional(), to: z.string().optional() }), req.query);
    const rows = await req.db.all<{ date: string; entry_no: number; memo: string | null; source_type: string; code: string; account: string; description: string | null; debit: number; credit: number }>(
      `SELECT je.date, je.entry_no, je.memo, je.source_type, a.code, a.name AS account, jl.description, jl.debit, jl.credit
       FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id JOIN accounts a ON a.id = jl.account_id
       WHERE je.tenant_id = ? AND je.status = 'posted' AND je.date >= ? AND je.date <= ?
       ORDER BY je.date, je.entry_no, jl.line_no`,
      [ctx.tenantId, query.from ?? '0000-01-01', query.to ?? new Date().toISOString().slice(0, 10)],
    );
    const csv = toCsv(
      rows.map((r) => ({
        Date: r.date,
        'Entry #': r.entry_no,
        Source: r.source_type,
        Memo: r.memo ?? '',
        Account: `${r.code} ${r.account}`,
        Description: r.description ?? '',
        Debit: (Number(r.debit) / 100).toFixed(2),
        Credit: (Number(r.credit) / 100).toFixed(2),
      })),
    );
    return { filename: 'general-ledger.csv', content: csv };
  });
}
