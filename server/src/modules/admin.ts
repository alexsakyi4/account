/**
 * Platform administration console (SaaS operator view). Every route requires a
 * platform administrator flag and is audited against a synthetic "platform"
 * tenant so tenant-isolated audit logs stay clean.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { newId } from '../db/driver.js';
import { notFound } from '../lib/errors.js';
import { fromMinor } from '../lib/money.js';
import { paginated, paging, paginationSchema, parse } from '../lib/validate.js';
import { PLANS } from '../../../shared/plans.js';
import { platformAdminOnly, requireAuth } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.js';

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/tenants', { preHandler: requireAuth() }, async (req) => {
    platformAdminOnly(req);
    const query = parse(paginationSchema.extend({ status: z.string().optional(), plan: z.string().optional() }), req.query);
    const where = ['t.deleted_at IS NULL'];
    const params: Array<string | number> = [];
    if (query.status && query.status !== 'all') {
      where.push('t.status = ?');
      params.push(query.status);
    }
    if (query.plan && query.plan !== 'all') {
      where.push('t.plan = ?');
      params.push(query.plan);
    }
    if (query.q) {
      where.push('(LOWER(t.name) LIKE ? OR LOWER(t.slug) LIKE ?)');
      const like = `%${query.q.toLowerCase()}%`;
      params.push(like, like);
    }
    const { limit, offset } = paging(query.page, query.pageSize);
    const total = await app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tenants t WHERE ${where.join(' AND ')}`, params);
    const rows = await app.db.all<Record<string, unknown>>(
      `SELECT t.id, t.name, t.slug, t.plan, t.status, t.industry, t.base_currency, t.is_sandbox, t.created_at,
        (SELECT COUNT(*) FROM memberships m WHERE m.tenant_id = t.id AND m.status = 'active') AS users,
        (SELECT COUNT(*) FROM invoices i WHERE i.tenant_id = t.id) AS invoices,
        (SELECT COALESCE(SUM(i.total),0) FROM invoices i WHERE i.tenant_id = t.id AND i.status NOT IN ('draft','void')) AS invoiced,
        (SELECT price_cents FROM subscriptions s WHERE s.tenant_id = t.id ORDER BY s.created_at DESC LIMIT 1) AS mrr
       FROM tenants t WHERE ${where.join(' AND ')}
       ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return paginated(rows, Number(total?.n ?? 0), query.page, query.pageSize);
  });

  app.get('/admin/metrics', { preHandler: requireAuth() }, async (req) => {
    platformAdminOnly(req);
    const counts = await app.db.get<Record<string, number>>(
      `SELECT
        (SELECT COUNT(*) FROM tenants WHERE deleted_at IS NULL) AS tenants,
        (SELECT COUNT(*) FROM tenants WHERE status = 'active' AND deleted_at IS NULL) AS active_tenants,
        (SELECT COUNT(*) FROM users WHERE status = 'active') AS users,
        (SELECT COUNT(*) FROM invoices WHERE status NOT IN ('draft','void')) AS invoices,
        (SELECT COUNT(*) FROM journal_entries) AS journal_entries,
        (SELECT COALESCE(SUM(price_cents),0) FROM subscriptions WHERE status = 'active') AS mrr_cents,
        (SELECT COUNT(*) FROM subscriptions WHERE status = 'trialing') AS trials`,
    );
    const signups = await app.db.all<{ month: string; count: number }>(
      `SELECT SUBSTR(created_at, 1, 7) AS month, COUNT(*) AS count FROM tenants GROUP BY month ORDER BY month DESC LIMIT 12`,
    );
    const planMix = await app.db.all<{ plan: string; count: number }>('SELECT plan, COUNT(*) AS count FROM tenants GROUP BY plan');
    return {
      ...counts,
      mrr: fromMinor(Number(counts?.mrr_cents ?? 0), 2),
      signups: signups.reverse(),
      planMix,
      health: { database: app.db.dialect, uptimeHours: Math.round(process.uptime() / 3600) },
    };
  });

  app.patch('/admin/tenants/:id', { preHandler: requireAuth() }, async (req) => {
    platformAdminOnly(req);
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(z.object({ status: z.enum(['active', 'suspended']), reason: z.string().max(300).optional() }), req.body);
    const tenant = await app.db.get<{ name: string; status: string }>('SELECT name, status FROM tenants WHERE id = ?', [id]);
    if (!tenant) throw notFound('Tenant not found');
    await app.db.run('UPDATE tenants SET status = ?, updated_at = ? WHERE id = ?', [body.status, new Date().toISOString(), id]);
    await recordAudit(app.db, {
      tenantId: 'platform',
      actor: { id: req.ctx!.user.id, email: req.ctx!.user.email, role: 'platform_admin', ip: req.ip },
      action: `tenant.${body.status}`,
      entityType: 'tenant',
      entityId: id,
      summary: `${tenant.name} set to ${body.status}${body.reason ? ` (${body.reason})` : ''}`,
      before: { status: tenant.status },
      after: { status: body.status },
    });
    if (body.status === 'suspended') {
      await app.db.run(
        `UPDATE sessions SET revoked_at = ? WHERE tenant_id = ?`,
        [new Date().toISOString(), id],
      );
    }
    return { ok: true };
  });

  app.post('/admin/tenants/:id/impersonate', { preHandler: requireAuth() }, async (req) => {
    platformAdminOnly(req);
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const owner = await app.db.get<{ user_id: string; email: string }>(
      `SELECT m.user_id, u.email FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id = ? AND m.role = 'admin' ORDER BY m.created_at LIMIT 1`,
      [id],
    );
    if (!owner) throw notFound('No administrator found for this company');
    await recordAudit(app.db, {
      tenantId: 'platform',
      actor: { id: req.ctx!.user.id, email: req.ctx!.user.email, role: 'platform_admin', ip: req.ip },
      action: 'tenant.support_access',
      entityType: 'tenant',
      entityId: id,
      summary: `Support access requested for ${owner.email}`,
    });
    const { signToken } = await import('../lib/crypto.js');
    return {
      accessToken: signToken({ sub: owner.user_id, tid: id, role: 'admin', typ: 'access', support: true }, 900),
      warning: 'Support sessions expire in 15 minutes and are recorded in the platform audit log.',
    };
  });

  app.get('/admin/plans', { preHandler: requireAuth() }, async (req) => {
    platformAdminOnly(req);
    return {
      data: PLANS.map((plan) => ({ code: plan.code, name: plan.name, priceCents: plan.priceCents, seats: plan.seats })),
    };
  });

  app.get('/admin/audit', { preHandler: requireAuth() }, async (req) => {
    platformAdminOnly(req);
    const rows = await app.db.all(
      "SELECT * FROM audit_logs WHERE tenant_id = 'platform' ORDER BY seq DESC LIMIT 200",
    );
    return { data: rows };
  });

  app.get('/admin/health', { preHandler: requireAuth() }, async (req) => {
    platformAdminOnly(req);
    const start = Date.now();
    await app.db.get('SELECT 1 AS ok');
    return {
      database: { dialect: app.db.dialect, latencyMs: Date.now() - start },
      queue: await app.db.get<{ pending: number; failed: number }>(
        `SELECT
          (SELECT COUNT(*) FROM webhook_deliveries WHERE status = 'pending') AS pending,
          (SELECT COUNT(*) FROM webhook_deliveries WHERE status = 'failed') AS failed`,
      ),
      runtime: { node: process.version, uptimeSeconds: Math.round(process.uptime()), memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024) },
      id: newId(),
    };
  });
}
