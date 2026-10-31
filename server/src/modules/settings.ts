import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { newId } from '../db/driver.js';
import { hashPassword, randomToken, sha256, signToken, verifyTotp, decryptSecret } from '../lib/crypto.js';
import { conflict, notFound, unprocessable } from '../lib/errors.js';
import { fromMinor } from '../lib/money.js';
import { paginationSchema, parse } from '../lib/validate.js';
import { PLAN_CODES, PLANS, planFor, seatLimit } from '../../../shared/plans.js';
import { requireAuth } from '../middleware/auth.js';
import { recordAudit, verifyChain } from '../services/audit.js';
import { ROLES, FEATURE_FLAGS, PERMISSIONS, getFlags, permissionsFor, readSettings, setFlag } from '../services/tenancy.js';

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------- company --
  app.get('/company', { preHandler: requireAuth() }, async (req) => {
    const ctx = req.ctx!;
    const tenant = await req.db.get<Record<string, unknown>>('SELECT * FROM tenants WHERE id = ?', [ctx.tenantId]);
    return {
      company: {
        ...tenant,
        settings: readSettings(tenant?.settings_json as string | null),
        address: tenant?.address_json ? JSON.parse(String(tenant?.address_json)) : null,
        settings_json: undefined,
        address_json: undefined,
      },
      flags: ctx.flags,
      permissions: ctx.permissions,
      role: ctx.role,
    };
  });

  app.patch('/company', { preHandler: requireAuth('company:manage') }, async (req) => {
    const body = parse(
      z.object({
        name: z.string().min(1).max(120).optional(),
        legalName: z.string().max(160).optional(),
        email: z.string().email().optional(),
        phone: z.string().max(40).optional(),
        website: z.string().max(120).optional(),
        industry: z.string().max(40).optional(),
        baseCurrency: z.string().length(3).optional(),
        fiscalYearStartMonth: z.coerce.number().int().min(1).max(12).optional(),
        address: z
          .object({
            line1: z.string().max(120).optional(),
            line2: z.string().max(120).optional(),
            city: z.string().max(80).optional(),
            region: z.string().max(80).optional(),
            postalCode: z.string().max(20).optional(),
            country: z.string().max(2).optional(),
          })
          .optional(),
        settings: z
          .object({
            invoiceFooter: z.string().max(500).optional(),
            invoicePrefix: z.string().max(10).optional(),
            defaultPaymentTermsDays: z.coerce.number().int().min(0).max(365).optional(),
            taxEnabled: z.boolean().optional(),
            defaultTaxCodeId: z.string().uuid().nullable().optional(),
            reminderDays: z.array(z.coerce.number().int().min(0).max(90)).max(5).optional(),
            dateFormat: z.string().max(20).optional(),
            approvalThreshold: z.coerce.number().int().min(0).optional(),
            logoUrl: z.string().max(300).nullable().optional(),
          })
          .optional(),
      }),
      req.body,
    );
    const ctx = req.ctx!;
    const before = await req.db.get<Record<string, unknown>>('SELECT * FROM tenants WHERE id = ?', [ctx.tenantId]);
    const settings = { ...readSettings(before?.settings_json as string | null), ...(body.settings ?? {}) };
    await req.db.run(
      `UPDATE tenants SET name = ?, legal_name = ?, email = ?, phone = ?, website = ?, industry = ?, base_currency = ?,
        fiscal_year_start_month = ?, address_json = ?, settings_json = ?, updated_at = ?
       WHERE id = ?`,
      [
        body.name ?? before?.name,
        body.legalName ?? before?.legal_name,
        body.email ?? before?.email,
        body.phone ?? before?.phone,
        body.website ?? before?.website,
        body.industry ?? before?.industry,
        body.baseCurrency ?? before?.base_currency,
        body.fiscalYearStartMonth ?? before?.fiscal_year_start_month,
        body.address ? JSON.stringify(body.address) : before?.address_json,
        JSON.stringify(settings),
        new Date().toISOString(),
        ctx.tenantId,
      ],
    );
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'company.updated',
      entityType: 'tenant',
      entityId: ctx.tenantId,
      summary: 'Company settings updated',
      before: { name: before?.name, base_currency: before?.base_currency },
      after: body,
    });
    return { ok: true, settings };
  });

  // ------------------------------------------------------------------ users --
  app.get('/users', { preHandler: requireAuth() }, async (req) => {
    const ctx = req.ctx!;
    const rows = await req.db.all<Record<string, unknown>>(
      `SELECT u.id, u.name, u.email, u.status, u.totp_enabled, u.last_login_at, m.role, m.status AS membership_status, m.created_at
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id = ? ORDER BY u.name`,
      [ctx.tenantId],
    );
    return {
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        role: r.role,
        status: r.membership_status,
        twoFactorEnabled: Number(r.totp_enabled) === 1,
        lastLoginAt: r.last_login_at,
        joinedAt: r.created_at,
      })),
      roles: ROLES,
      permissionMatrix: Object.fromEntries(ROLES.map((role) => [role, permissionsFor(role)])),
      allPermissions: PERMISSIONS,
    };
  });

  app.post('/users/invite', { preHandler: requireAuth('users:manage') }, async (req, reply) => {
    const body = parse(
      z.object({
        email: z.string().email().transform((v) => v.toLowerCase()),
        role: z.enum(ROLES),
        name: z.string().min(1).max(120).optional(),
      }),
      req.body,
    );
    const ctx = req.ctx!;
    const subscription = await req.db.get<{ plan: string }>('SELECT plan FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1', [
      ctx.tenantId,
    ]);
    const memberCount = await req.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM memberships WHERE tenant_id = ? AND status = 'active'",
      [ctx.tenantId],
    );
    const limit = seatLimit(subscription?.plan ?? 'trial');
    if (Number(memberCount?.n ?? 0) >= limit) {
      throw conflict(`Your ${planFor(subscription?.plan ?? 'trial').name} plan allows ${limit} active users. Upgrade the plan to invite more.`);
    }
    const existingUser = await req.db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', [body.email]);
    if (existingUser) {
      const member = await req.db.get('SELECT id FROM memberships WHERE tenant_id = ? AND user_id = ?', [ctx.tenantId, existingUser.id]);
      if (member) throw conflict('That person is already a member of this company');
    }
    const token = signToken(
      { sub: existingUser?.id ?? 'invite', tid: ctx.tenantId, role: body.role, typ: 'access', inviteEmail: body.email },
      60 * 60 * 24 * 7,
    );
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'user.invited',
      entityType: 'user',
      entityId: existingUser?.id ?? null,
      summary: `Invited ${body.email} as ${body.role}`,
      after: { email: body.email, role: body.role },
    });
    return reply.code(201).send({
      inviteUrl: `${config.appUrl}/accept-invite?token=${token}`,
      expiresInDays: 7,
      email: body.email,
      role: body.role,
      delivered: false,
    });
  });

  app.patch('/users/:id', { preHandler: requireAuth('users:manage') }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(z.object({ role: z.enum(ROLES).optional(), status: z.enum(['active', 'disabled']).optional() }), req.body);
    const ctx = req.ctx!;
    const membership = await req.db.get<{ id: string; role: string }>('SELECT * FROM memberships WHERE tenant_id = ? AND user_id = ?', [ctx.tenantId, id]);
    if (!membership) throw notFound('Member not found');
    if (id === ctx.user.id && body.role && body.role !== 'admin') throw unprocessable('You cannot remove your own admin access');
    if (membership.role === 'admin' && body.role && body.role !== 'admin') {
      const admins = await req.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memberships WHERE tenant_id = ? AND role = 'admin' AND status = 'active'", [ctx.tenantId]);
      if (Number(admins?.n ?? 0) <= 1) throw unprocessable('A company must keep at least one administrator');
    }
    await req.db.run('UPDATE memberships SET role = COALESCE(?, role), status = COALESCE(?, status) WHERE id = ?', [
      body.role ?? null,
      body.status ?? null,
      membership.id,
    ]);
    if (body.status === 'disabled') await req.db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ?', [new Date().toISOString(), id]);
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'user.updated',
      entityType: 'user',
      entityId: id,
      summary: `Updated member ${id}`,
      before: { role: membership.role },
      after: body,
    });
    return { ok: true };
  });

  app.delete('/users/:id', { preHandler: requireAuth('users:manage') }, async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const ctx = req.ctx!;
    if (id === ctx.user.id) throw unprocessable('You cannot remove yourself');
    const membership = await req.db.get<{ role: string }>('SELECT * FROM memberships WHERE tenant_id = ? AND user_id = ?', [ctx.tenantId, id]);
    if (!membership) throw notFound('Member not found');
    if (membership.role === 'admin') {
      const admins = await req.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memberships WHERE tenant_id = ? AND role = 'admin'", [ctx.tenantId]);
      if (Number(admins?.n ?? 0) <= 1) throw unprocessable('A company must keep at least one administrator');
    }
    await req.db.run('DELETE FROM memberships WHERE tenant_id = ? AND user_id = ?', [ctx.tenantId, id]);
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'user.removed',
      entityType: 'user',
      entityId: id,
      summary: 'Member removed from company',
    });
    return reply.code(204).send();
  });

  // ------------------------------------------------------------------ flags --
  app.get('/flags', { preHandler: requireAuth() }, async (req) => ({
    flags: Object.entries(FEATURE_FLAGS).map(([key, meta]) => ({ key, ...meta, enabled: req.ctx!.flags[key] })),
  }));

  app.patch('/flags/:key', { preHandler: requireAuth('company:manage') }, async (req) => {
    const { key } = parse(z.object({ key: z.string() }), req.params);
    const body = parse(z.object({ enabled: z.boolean() }), req.body);
    const ctx = req.ctx!;
    await setFlag(req.db, ctx.tenantId, key, body.enabled);
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'feature_flag.updated',
      entityType: 'feature_flag',
      entityId: key,
      summary: `${key} ${body.enabled ? 'enabled' : 'disabled'}`,
    });
    return { ok: true };
  });

  // ------------------------------------------------------------------- taxes --
  app.get('/tax-codes', { preHandler: requireAuth() }, async (req) => ({
    data: await req.db.all('SELECT * FROM tax_codes WHERE tenant_id = ? ORDER BY code', [req.ctx!.tenantId]),
  }));

  app.post('/tax-codes', { preHandler: requireAuth('company:manage') }, async (req, reply) => {
    const body = parse(
      z.object({
        code: z.string().min(1).max(20).transform((v) => v.toUpperCase()),
        name: z.string().min(1).max(80),
        rateBp: z.coerce.number().int().min(0).max(10_000),
        taxType: z.enum(['vat', 'gst', 'sales', 'custom']).default('vat'),
        isInclusive: z.boolean().default(false),
        accountId: z.string().uuid().nullable().optional(),
      }),
      req.body,
    );
    const ctx = req.ctx!;
    const clash = await req.db.get('SELECT id FROM tax_codes WHERE tenant_id = ? AND code = ?', [ctx.tenantId, body.code]);
    if (clash) throw conflict(`Tax code ${body.code} already exists`);
    const id = newId();
    await req.db.run(
      `INSERT INTO tax_codes (id, tenant_id, code, name, rate_bp, tax_type, is_inclusive, account_id, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [id, ctx.tenantId, body.code, body.name, body.rateBp, body.taxType, body.isInclusive ? 1 : 0, body.accountId ?? null, new Date().toISOString()],
    );
    return reply.code(201).send({ id });
  });

  app.patch('/tax-codes/:id', { preHandler: requireAuth('company:manage') }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(
      z.object({ name: z.string().max(80).optional(), rateBp: z.coerce.number().int().min(0).max(10_000).optional(), isActive: z.boolean().optional() }),
      req.body,
    );
    await req.db.run('UPDATE tax_codes SET name = COALESCE(?, name), rate_bp = COALESCE(?, rate_bp), is_active = COALESCE(?, is_active) WHERE tenant_id = ? AND id = ?', [
      body.name ?? null,
      body.rateBp ?? null,
      body.isActive === undefined ? null : body.isActive ? 1 : 0,
      req.ctx!.tenantId,
      id,
    ]);
    return { ok: true };
  });

  // -------------------------------------------------------------- currencies --
  app.get('/currencies', { preHandler: requireAuth() }, async (req) => {
    const ctx = req.ctx!;
    const currencies = await req.db.all('SELECT * FROM currencies WHERE tenant_id = ? ORDER BY is_base DESC, code', [ctx.tenantId]);
    const latest = await req.db.all<{ quote_currency: string; rate: number; rate_date: string }>(
      `SELECT quote_currency, rate, rate_date FROM exchange_rates WHERE tenant_id = ? AND rate_date = (
         SELECT MAX(rate_date) FROM exchange_rates e2 WHERE e2.tenant_id = exchange_rates.tenant_id AND e2.quote_currency = exchange_rates.quote_currency
       )`,
      [ctx.tenantId],
    );
    const rateMap = new Map(latest.map((r) => [r.quote_currency, r]));
    return {
      data: currencies.map((c) => ({
        ...c,
        rate: (rateMap.get(String((c as Record<string, unknown>).code))?.rate ?? 1) as number,
        rateDate: (rateMap.get(String((c as Record<string, unknown>).code))?.rate_date ?? null) as string | null,
      })),
      base: ctx.tenant.base_currency,
    };
  });

  app.post('/currencies/rates', { preHandler: requireAuth('company:manage') }, async (req) => {
    const body = parse(
      z.object({
        quoteCurrency: z.string().length(3).toUpperCase(),
        rate: z.coerce.number().positive(),
        rateDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }),
      req.body,
    );
    const ctx = req.ctx!;
    await req.db.run(
      `INSERT INTO exchange_rates (id, tenant_id, base_currency, quote_currency, rate, rate_date, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'manual', ?)
       ON CONFLICT (tenant_id, base_currency, quote_currency, rate_date) DO UPDATE SET rate = excluded.rate`,
      [newId(), ctx.tenantId, body.quoteCurrency, ctx.tenant.base_currency, body.rate, body.rateDate, new Date().toISOString()],
    );
    return { ok: true };
  });

  app.get('/currencies/convert', { preHandler: requireAuth() }, async (req) => {
    const query = parse(z.object({ amount: z.coerce.number(), from: z.string().length(3), to: z.string().length(3) }), req.query);
    const ctx = req.ctx!;
    const rate = await latestRate(req.db, ctx.tenantId, query.from, query.to);
    return { rate, amount: fromMinor(Math.round(query.amount * 100) * rate, 2), minorUnits: Math.round(query.amount * 100 * rate) };
  });

  // -------------------------------------------------------------- onboarding --
  app.get('/onboarding', { preHandler: requireAuth() }, async (req) => {
    const ctx = req.ctx!;
    const rows = await req.db.all<{ step_key: string; completed_at: string | null }>(
      'SELECT step_key, completed_at FROM onboarding_progress WHERE tenant_id = ?',
      [ctx.tenantId],
    );
    return { data: rows, completed: rows.filter((r) => r.completed_at).length };
  });

  app.post('/onboarding/:step', { preHandler: requireAuth() }, async (req) => {
    const { step } = parse(z.object({ step: z.string().max(40) }), req.params);
    const ctx = req.ctx!;
    await req.db.run(
      `INSERT INTO onboarding_progress (id, tenant_id, step_key, completed_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (tenant_id, step_key) DO UPDATE SET completed_at = excluded.completed_at`,
      [newId(), ctx.tenantId, step, new Date().toISOString()],
    );
    return { ok: true };
  });

  app.post('/onboarding/reset', { preHandler: requireAuth('company:manage') }, async (req) => {
    await req.db.run('UPDATE onboarding_progress SET completed_at = NULL WHERE tenant_id = ?', [req.ctx!.tenantId]);
    return { ok: true };
  });

  // ---------------------------------------------------------------- api keys --
  app.get('/api-keys', { preHandler: requireAuth('integrations:manage') }, async (req) => ({
    data: await req.db.all('SELECT id, name, prefix, role, scopes, last_used_at, revoked_at, created_at FROM api_keys WHERE tenant_id = ?', [
      req.ctx!.tenantId,
    ]),
  }));

  app.post('/api-keys', { preHandler: requireAuth('integrations:manage') }, async (req, reply) => {
    const body = parse(z.object({ name: z.string().min(1).max(80), role: z.enum(ROLES).default('bookkeeper') }), req.body);
    const ctx = req.ctx!;
    const key = `ll_${randomToken(24)}`;
    const id = newId();
    await req.db.run(
      `INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash, scopes, role, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, '*', ?, ?, ?)`,
      [id, ctx.tenantId, body.name, key.slice(0, 10), sha256(key), body.role, ctx.user.id, new Date().toISOString()],
    );
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'api_key.created',
      entityType: 'api_key',
      entityId: id,
      summary: `Created API key ${body.name}`,
    });
    return reply.code(201).send({ id, key, prefix: key.slice(0, 10), note: 'Copy this key now — it is not shown again.' });
  });

  app.delete('/api-keys/:id', { preHandler: requireAuth('integrations:manage') }, async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    await req.db.run('UPDATE api_keys SET revoked_at = ? WHERE tenant_id = ? AND id = ?', [new Date().toISOString(), req.ctx!.tenantId, id]);
    return reply.code(204).send();
  });

  // ------------------------------------------------------------ notifications --
  app.get('/notifications', { preHandler: requireAuth() }, async (req) => {
    const ctx = req.ctx!;
    const rows = await req.db.all(
      `SELECT * FROM notifications WHERE tenant_id = ? AND (user_id IS NULL OR user_id = ?) ORDER BY created_at DESC LIMIT ?`,
      [ctx.tenantId, ctx.user.id, parse(paginationSchema, req.query).pageSize],
    );
    return { data: rows };
  });

  app.post('/notifications/:id/read', { preHandler: requireAuth() }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    await req.db.run('UPDATE notifications SET read_at = ? WHERE id = ? AND tenant_id = ?', [new Date().toISOString(), id, req.ctx!.tenantId]);
    return { ok: true };
  });

  // ---------------------------------------------------------------- billing --
  app.get('/subscription', { preHandler: requireAuth() }, async (req) => {
    const ctx = req.ctx!;
    const subscription = await req.db.get('SELECT * FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1', [ctx.tenantId]);
    const seats = await req.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memberships WHERE tenant_id = ? AND status = 'active'", [ctx.tenantId]);
    const planRow = subscription as { plan?: string } | null;
    const plan = planFor(planRow?.plan ?? 'trial');
    return { subscription, seats: Number(seats?.n ?? 0), seatLimit: plan.seats, plans: PLANS };
  });

  app.post('/subscription/change', { preHandler: requireAuth('billing:manage') }, async (req) => {
    const body = parse(z.object({ plan: z.enum(PLAN_CODES) }), req.body);
    const ctx = req.ctx!;
    const seats = await req.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM memberships WHERE tenant_id = ? AND status = 'active'",
      [ctx.tenantId],
    );
    if (Number(seats?.n ?? 0) > seatLimit(body.plan)) {
      throw conflict(`${planFor(body.plan).name} allows ${seatLimit(body.plan)} seats; remove members first.`);
    }
    await req.db.run('UPDATE subscriptions SET plan = ?, price_cents = ?, status = ?, updated_at = ? WHERE tenant_id = ?', [
      body.plan,
      planFor(body.plan).priceCents,
      body.plan === 'trial' ? 'trialing' : 'active',
      new Date().toISOString(),
      ctx.tenantId,
    ]);
    await req.db.run('UPDATE tenants SET plan = ? WHERE id = ?', [body.plan, ctx.tenantId]);
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'billing.plan_changed',
      entityType: 'subscription',
      entityId: ctx.tenantId,
      summary: `Plan changed to ${body.plan}`,
    });
    return { ok: true, plan: body.plan };
  });

  // ------------------------------------------------------------------ audit --
  app.get('/audit/verify', { preHandler: requireAuth('audit:read') }, async (req) => verifyChain(req.db, req.ctx!.tenantId));

  app.get('/audit/export', { preHandler: requireAuth('audit:read') }, async (req) => {
    const ctx = req.ctx!;
    const rows = await req.db.all<Record<string, unknown>>(
      'SELECT * FROM audit_logs WHERE tenant_id = ? ORDER BY seq LIMIT 10000',
      [ctx.tenantId],
    );
    const { toCsv } = await import('../lib/csv.js');
    return {
      filename: `audit-log-${new Date().toISOString().slice(0, 10)}.csv`,
      content: toCsv(
        rows.map((r) => ({
          Seq: r.seq,
          Timestamp: r.created_at,
          Actor: r.actor_email ?? '',
          Role: r.actor_role ?? '',
          Action: r.action,
          Entity: `${r.entity_type}:${r.entity_id ?? ''}`,
          Summary: r.summary ?? '',
          IP: r.ip ?? '',
          Hash: r.hash,
          'Previous hash': r.prev_hash,
        })),
      ),
    };
  });

  // ------------------------------------------------------------------- GDPR --
  app.post('/gdpr/export', { preHandler: requireAuth() }, async (req) => {
    const ctx = req.ctx!;
    const id = newId();
    await req.db.run(`INSERT INTO gdpr_requests (id, tenant_id, user_id, request_type, status, requested_at) VALUES (?, ?, ?, 'export', 'completed', ?)`, [
      id,
      ctx.tenantId,
      ctx.user.id,
      new Date().toISOString(),
    ]);
    const user = await req.db.get('SELECT id, email, name, created_at, last_login_at FROM users WHERE id = ?', [ctx.user.id]);
    const memberships = await req.db.all('SELECT tenant_id, role, created_at FROM memberships WHERE user_id = ?', [ctx.user.id]);
    const audit = await req.db.all('SELECT action, entity_type, created_at FROM audit_logs WHERE actor_id = ? ORDER BY created_at DESC LIMIT 500', [ctx.user.id]);
    return { requestId: id, user, memberships, activity: audit, generatedAt: new Date().toISOString() };
  });

  app.post('/gdpr/erase', { preHandler: requireAuth('company:manage') }, async (req) => {
    const body = parse(z.object({ confirm: z.literal(true), userId: z.string().optional() }), req.body);
    void body;
    const ctx = req.ctx!;
    const targetId = (req.body as { userId?: string }).userId ?? ctx.user.id;
    if (targetId !== ctx.user.id && ctx.role !== 'admin') throw notFound('Member not found');
    const id = newId();
    await req.db.run(`INSERT INTO gdpr_requests (id, tenant_id, user_id, request_type, status, requested_at) VALUES (?, ?, ?, 'erase', 'pending', ?)`, [
      id,
      ctx.tenantId,
      targetId,
      new Date().toISOString(),
    ]);
    // Anonymise the personal record; financial documents keep their integrity.
    await req.db.run(
      `UPDATE users SET email = ?, name = 'Erased user', password_hash = ?, totp_secret = NULL, totp_enabled = 0, status = 'erased', updated_at = ? WHERE id = ?`,
      [`erased+${targetId}@invalid`, await hashPassword(randomToken(32)), new Date().toISOString(), targetId],
    );
    await req.db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ?', [new Date().toISOString(), targetId]);
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'gdpr.erasure',
      entityType: 'user',
      entityId: targetId,
      summary: 'Personal data erased at the data subject’s request',
    });
    return { ok: true, requestId: id };
  });

  app.get('/gdpr/requests', { preHandler: requireAuth('company:manage') }, async (req) => ({
    data: await req.db.all('SELECT * FROM gdpr_requests WHERE tenant_id = ? ORDER BY requested_at DESC', [req.ctx!.tenantId]),
  }));

  // --------------------------------------------------------- security views --
  app.get('/security/overview', { preHandler: requireAuth() }, async (req) => {
    const ctx = req.ctx!;
    const members = await req.db.all<{ role: string; totp_enabled: number }>(
      `SELECT m.role, u.totp_enabled FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ? AND m.status = 'active'`,
      [ctx.tenantId],
    );
    const admins = members.filter((m) => m.role === 'admin');
    const logins = await req.db.all(
      `SELECT email, success, ip, created_at FROM login_attempts ORDER BY created_at DESC LIMIT 20`,
    );
    return {
      twoFactor: {
        required: config.require2faForAdmins,
        admins: admins.length,
        adminsWith2fa: admins.filter((a) => Number(a.totp_enabled) === 1).length,
        enabledForCurrentUser: Number(ctx.user.totp_enabled) === 1,
      },
      members: members.length,
      recentLogins: logins,
      encryptionAtRest: 'AES-256-GCM for secrets, TLS 1.2+ in transit',
      sessionPolicy: { accessTokenMinutes: Math.round(config.accessTokenTtl / 60), refreshDays: Math.round(config.refreshTokenTtl / 86400) },
    };
  });

  app.post('/security/verify-2fa', { preHandler: requireAuth() }, async (req) => {
    const body = parse(z.object({ code: z.string().min(6).max(8) }), req.body);
    const user = await req.db.get<{ totp_secret: string | null; totp_enabled: number }>('SELECT totp_secret, totp_enabled FROM users WHERE id = ?', [req.ctx!.user.id]);
    if (!user || Number(user.totp_enabled) !== 1) throw unprocessable('Two-factor authentication is not enabled');
    const secret = decryptSecret(user.totp_secret);
    if (!secret || !verifyTotp(secret, body.code)) throw unprocessable('Invalid verification code');
    return { ok: true };
  });

  app.get('/usage', { preHandler: requireAuth() }, async (req) => {
    const ctx = req.ctx!;
    const counts = await req.db.get<Record<string, number>>(
      `SELECT
        (SELECT COUNT(*) FROM accounts WHERE tenant_id = ?) AS accounts,
        (SELECT COUNT(*) FROM contacts WHERE tenant_id = ?) AS contacts,
        (SELECT COUNT(*) FROM invoices WHERE tenant_id = ?) AS invoices,
        (SELECT COUNT(*) FROM bills WHERE tenant_id = ?) AS bills,
        (SELECT COUNT(*) FROM payments WHERE tenant_id = ?) AS payments,
        (SELECT COUNT(*) FROM journal_entries WHERE tenant_id = ?) AS journal_entries,
        (SELECT COUNT(*) FROM attachments WHERE tenant_id = ?) AS attachments,
        (SELECT COUNT(*) FROM memberships WHERE tenant_id = ?) AS members`,
      Array(8).fill(ctx.tenantId),
    );
    return { counts, limits: { members: 50, attachmentsMb: 1024 } };
  });
}

async function latestRate(db: FastifyInstance['db'], tenantId: string, from: string, to: string): Promise<number> {
  if (from === to) return 1;
  // A rate row means: 1 unit of base_currency = rate units of quote_currency.
  const direct = await db.get<{ rate: number }>(
    'SELECT rate FROM exchange_rates WHERE tenant_id = ? AND base_currency = ? AND quote_currency = ? ORDER BY rate_date DESC LIMIT 1',
    [tenantId, from, to],
  );
  if (direct) return Number(direct.rate);
  const inverse = await db.get<{ rate: number }>(
    'SELECT rate FROM exchange_rates WHERE tenant_id = ? AND base_currency = ? AND quote_currency = ? ORDER BY rate_date DESC LIMIT 1',
    [tenantId, to, from],
  );
  if (inverse && Number(inverse.rate) > 0) return 1 / Number(inverse.rate);
  return 1;
}
