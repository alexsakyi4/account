import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import type { DB } from '../db/driver.js';
import { newId } from '../db/driver.js';
import { postJournal, systemAccount } from '../domain/ledger.js';
import { toMinor } from '../lib/money.js';
import { csvToObjects } from '../lib/csv.js';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors.js';
import { paginated, paging, paginationSchema, parse } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.js';
import { emitEvent } from '../services/events.js';
import { recordPayment } from '../services/documents.js';

const ruleSchema = z.object({
  name: z.string().min(1).max(80),
  priority: z.coerce.number().int().min(1).max(1000).default(100),
  matchField: z.enum(['description', 'payee', 'amount']).default('description'),
  matchOp: z.enum(['contains', 'equals', 'starts_with']).default('contains'),
  matchValue: z.string().min(1).max(120),
  txDirection: z.enum(['any', 'credit', 'debit']).default('any'),
  amountMin: z.coerce.number().int().optional(),
  amountMax: z.coerce.number().int().optional(),
  targetType: z.enum(['journal', 'exclude']).default('journal'),
  targetAccountId: z.string().uuid().nullable().optional(),
  autoApply: z.boolean().default(true),
  isActive: z.boolean().default(true),
});

async function bankAccount(db: FastifyInstance['db'], tenantId: string, id: string) {
  const account = await db.get<{ id: string; account_id: string; name: string; currency: string; opening_balance: number }>(
    'SELECT * FROM bank_accounts WHERE tenant_id = ? AND id = ?',
    [tenantId, id],
  );
  if (!account) throw notFound('Bank account not found');
  return account;
}

export async function bankingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/banking/accounts', { preHandler: requireAuth() }, async (req) => {
    const ctx = req.ctx!;
    const rows = await req.db.all<Record<string, unknown>>(
      `SELECT b.*, a.name AS gl_account_name, a.code AS gl_account_code,
        COALESCE((SELECT SUM(jl.debit - jl.credit) FROM journal_lines jl
          JOIN journal_entries je ON je.id = jl.entry_id AND je.status = 'posted'
          WHERE jl.account_id = b.account_id), 0) AS gl_balance,
        (SELECT COUNT(*) FROM bank_transactions t WHERE t.bank_account_id = b.id AND t.status = 'unmatched') AS unmatched_count,
        (SELECT MAX(t.date) FROM bank_transactions t WHERE t.bank_account_id = b.id) AS last_transaction_date
       FROM bank_accounts b JOIN accounts a ON a.id = b.account_id
       WHERE b.tenant_id = ? AND b.is_active = 1 ORDER BY b.name`,
      [ctx.tenantId],
    );
    return {
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        bankName: r.bank_name,
        mask: r.mask,
        currency: r.currency,
        accountId: r.account_id,
        glAccountName: `${r.gl_account_code} ${r.gl_account_name}`,
        balance: Number(r.gl_balance ?? 0),
        unmatched: Number(r.unmatched_count ?? 0),
        lastImport: r.last_import_at,
        lastTransactionDate: r.last_transaction_date,
        provider: r.provider,
      })),
    };
  });

  app.post('/banking/accounts', { preHandler: requireAuth('banking:write') }, async (req, reply) => {
    const body = parse(
      z.object({
        name: z.string().min(1).max(80),
        accountId: z.string().uuid(),
        bankName: z.string().max(120).optional(),
        mask: z.string().max(20).optional(),
        openingBalance: z.coerce.number().int().optional(),
        provider: z.enum(['manual', 'csv', 'plaid', 'saltedge']).default('manual'),
      }),
      req.body,
    );
    const ctx = req.ctx!;
    const clash = await req.db.get('SELECT id FROM bank_accounts WHERE tenant_id = ? AND account_id = ? AND is_active = 1', [
      ctx.tenantId,
      body.accountId,
    ]);
    if (clash) throw conflict('That general ledger account is already linked to a bank account');
    const id = newId();
    await req.db.run(
      `INSERT INTO bank_accounts (id, tenant_id, name, account_id, bank_name, mask, currency, opening_balance, current_balance, provider, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, ctx.tenantId, body.name, body.accountId, body.bankName ?? null, body.mask ?? null, ctx.tenant.base_currency, body.openingBalance ?? 0, body.openingBalance ?? 0, body.provider, new Date().toISOString()],
    );
    return reply.code(201).send({ id });
  });

  app.get('/banking/transactions', { preHandler: requireAuth() }, async (req) => {
    const ctx = req.ctx!;
    const query = parse(
      paginationSchema.extend({
        bankAccountId: z.string().optional(),
        status: z.string().default('all'),
        minAmount: z.coerce.number().optional(),
      }),
      req.query,
    );
    const where = ['t.tenant_id = ?'];
    const params: Array<string | number> = [ctx.tenantId];
    if (query.bankAccountId) {
      where.push('t.bank_account_id = ?');
      params.push(query.bankAccountId);
    }
    if (query.status !== 'all') {
      where.push(`t.status IN (${query.status.split(',').map(() => '?').join(',')})`);
      params.push(...query.status.split(','));
    }
    if (query.q) {
      where.push('(LOWER(t.description) LIKE ? OR LOWER(COALESCE(t.payee, \'\')) LIKE ?)');
      const like = `%${query.q.toLowerCase()}%`;
      params.push(like, like);
    }
    const { limit, offset } = paging(query.page, query.pageSize);
    const total = await req.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM bank_transactions t WHERE ${where.join(' AND ')}`, params);
    const rows = await req.db.all<Record<string, unknown>>(
      `SELECT t.*, b.name AS bank_account_name FROM bank_transactions t JOIN bank_accounts b ON b.id = t.bank_account_id
       WHERE ${where.join(' AND ')} ORDER BY t.date DESC, t.created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return paginated(rows, Number(total?.n ?? 0), query.page, query.pageSize);
  });

  app.get('/banking/transactions/:id/suggestions', { preHandler: requireAuth() }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const ctx = req.ctx!;
    const txn = await req.db.get<{ id: string; amount: number; date: string; description: string; payee: string | null; bank_account_id: string }>(
      'SELECT * FROM bank_transactions WHERE tenant_id = ? AND id = ?',
      [ctx.tenantId, id],
    );
    if (!txn) throw notFound('Transaction not found');
    const amount = Number(txn.amount);
    const payments = await req.db.all<{ id: string; number: string; amount: number; date: string; contact_name: string | null; direction: string }>(
      `SELECT p.id, p.number, p.amount, p.date, c.name AS contact_name, p.direction
       FROM payments p LEFT JOIN contacts c ON c.id = p.contact_id
       WHERE p.tenant_id = ? AND p.status = 'completed' AND p.amount = ?
         AND (p.direction = ?) AND p.date BETWEEN ? AND ?
         AND NOT EXISTS (SELECT 1 FROM bank_transactions bt WHERE bt.matched_entity_id = p.id)
       LIMIT 5`,
      [ctx.tenantId, Math.abs(amount), amount > 0 ? 'receipt' : 'disbursement', shift(txn.date, -14), shift(txn.date, 14)],
    );
    const invoices = await req.db.all<{ id: string; number: string; balance: number; contact_name: string; due_date: string }>(
      `SELECT i.id, i.number, i.balance, c.name AS contact_name, i.due_date FROM invoices i JOIN contacts c ON c.id = i.contact_id
       WHERE i.tenant_id = ? AND i.kind = 'invoice' AND i.balance > 0 AND i.balance = ? AND ? > 0 ORDER BY i.due_date LIMIT 5`,
      [ctx.tenantId, Math.abs(amount), amount],
    );
    const rules = await matchingRules(req.db, ctx.tenantId, txn);
    return { transaction: txn, payments, invoices, rules };
  });

  app.post('/banking/transactions/:id/match', { preHandler: requireAuth('banking:write') }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(
      z.object({
        type: z.enum(['payment', 'invoice', 'journal', 'exclude']),
        targetId: z.string().optional(),
        accountId: z.string().uuid().optional(),
        createRule: z.boolean().optional(),
      }),
      req.body,
    );
    const ctx = req.ctx!;
    const result = await matchTransaction(req, ctx.tenantId, ctx.user.id, id, body);
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: `banking.match_${body.type}`,
      entityType: 'bank_transaction',
      entityId: id,
      summary: `Bank transaction matched (${body.type})`,
      after: result,
    });
    return result;
  });

  app.post('/banking/transactions/bulk', { preHandler: requireAuth('banking:write') }, async (req) => {
    const body = parse(
      z.object({
        ids: z.array(z.string()).min(1).max(200),
        action: z.enum(['exclude', 'restore', 'auto_match']),
      }),
      req.body,
    );
    const ctx = req.ctx!;
    let affected = 0;
    for (const id of body.ids) {
      if (body.action === 'exclude') {
        affected += await req.db.run("UPDATE bank_transactions SET status = 'excluded' WHERE tenant_id = ? AND id = ? AND status = 'unmatched'", [ctx.tenantId, id]);
      } else if (body.action === 'restore') {
        affected += await req.db.run("UPDATE bank_transactions SET status = 'unmatched', match_type = NULL WHERE tenant_id = ? AND id = ? AND status = 'excluded'", [ctx.tenantId, id]);
      } else {
        try {
          const suggestion = await autoMatchOne(req, ctx.tenantId, ctx.user.id, id);
          if (suggestion.matched) affected += 1;
        } catch {
          /* leave for manual review */
        }
      }
    }
    return { affected };
  });

  /** Auto-matching rules: deterministic, testable, and always reversible. */
  app.get('/banking/rules', { preHandler: requireAuth() }, async (req) => ({
    data: await req.db.all('SELECT * FROM bank_rules WHERE tenant_id = ? ORDER BY priority, created_at', [req.ctx!.tenantId]),
  }));

  app.post('/banking/rules', { preHandler: requireAuth('banking:write') }, async (req, reply) => {
    const body = parse(ruleSchema, req.body);
    const ctx = req.ctx!;
    if (body.targetType === 'journal' && !body.targetAccountId) throw badRequest('Choose the account to categorise these transactions to');
    const id = newId();
    await req.db.run(
      `INSERT INTO bank_rules (id, tenant_id, name, priority, match_field, match_op, match_value, tx_direction, amount_min, amount_max,
         target_type, target_account_id, auto_apply, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, ctx.tenantId, body.name, body.priority, body.matchField, body.matchOp, body.matchValue, body.txDirection, body.amountMin ?? null, body.amountMax ?? null, body.targetType, body.targetAccountId ?? null, body.autoApply ? 1 : 0, body.isActive ? 1 : 0, new Date().toISOString()],
    );
    return reply.code(201).send({ id });
  });

  app.delete('/banking/rules/:id', { preHandler: requireAuth('banking:write') }, async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    await req.db.run('DELETE FROM bank_rules WHERE tenant_id = ? AND id = ?', [req.ctx!.tenantId, id]);
    return reply.code(204).send();
  });

  app.post('/banking/auto-match', { preHandler: requireAuth('banking:write') }, async (req) => {
    const body = parse(z.object({ bankAccountId: z.string().uuid() }), req.body);
    const ctx = req.ctx!;
    const txns = await req.db.all<{ id: string }>(
      "SELECT id FROM bank_transactions WHERE tenant_id = ? AND bank_account_id = ? AND status = 'unmatched' ORDER BY date LIMIT 200",
      [ctx.tenantId, body.bankAccountId],
    );
    let matched = 0;
    for (const txn of txns) {
      try {
        const result = await autoMatchOne(req, ctx.tenantId, ctx.user.id, txn.id);
        if (result.matched) matched += 1;
      } catch {
        /* keep unmatched for review */
      }
    }
    return { matched, scanned: txns.length };
  });

  app.post('/banking/accounts/:id/import', { preHandler: requireAuth('banking:write') }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(
      z.object({
        csv: z.string().min(1).max(2_000_000),
        mapping: z
          .object({ date: z.string(), description: z.string(), amount: z.string().optional(), debit: z.string().optional(), credit: z.string().optional() })
          .optional(),
      }),
      req.body,
    );
    const ctx = req.ctx!;
    const account = await bankAccount(req.db, ctx.tenantId, id);
    const rows = csvToObjects(body.csv);
    if (!rows.length) throw badRequest('The file has no rows');
    const mapping: { date: string; description: string; amount?: string; debit?: string; credit?: string; payee?: string } =
      body.mapping ?? detectMapping(Object.keys(rows[0]));
    if (!mapping.date || !mapping.description) throw unprocessable('Could not detect the date and description columns. Provide a mapping.');
    const batch = newId();
    let imported = 0;
    let skipped = 0;
    for (const row of rows) {
      const dateRaw = row[mapping.date] ?? '';
      const date = normaliseDate(dateRaw);
      if (!date) {
        skipped += 1;
        continue;
      }
      let amount = 0;
      if (mapping.amount) amount = toMinor(row[mapping.amount]);
      else {
        const debit = toMinor(row[mapping.debit ?? ''] ?? '');
        const credit = toMinor(row[mapping.credit ?? ''] ?? '');
        amount = credit - debit;
      }
      if (!amount) {
        skipped += 1;
        continue;
      }
      const externalId = `${date}-${amount}-${hash(row[mapping.description] ?? '')}`;
      const exists = await req.db.get('SELECT id FROM bank_transactions WHERE tenant_id = ? AND bank_account_id = ? AND external_id = ?', [
        ctx.tenantId,
        id,
        externalId,
      ]);
      if (exists) {
        skipped += 1;
        continue;
      }
      await req.db.run(
        `INSERT INTO bank_transactions (id, tenant_id, bank_account_id, date, description, payee, amount, currency, status, import_batch, external_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unmatched', ?, ?, ?)`,
        [newId(), ctx.tenantId, id, date, row[mapping.description] ?? '', row[mapping.payee ?? ''] ?? null, amount, account.currency, batch, externalId, new Date().toISOString()],
      );
      imported += 1;
    }
    await req.db.run('UPDATE bank_accounts SET last_import_at = ? WHERE id = ?', [new Date().toISOString(), id]);
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'banking.statement_imported',
      entityType: 'bank_account',
      entityId: id,
      summary: `Imported ${imported} bank transactions (${skipped} skipped)`,
    });
    return { imported, skipped, batch, detectedMapping: mapping };
  });

  app.post('/banking/accounts/:id/connect', { preHandler: requireAuth('integrations:manage') }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(z.object({ provider: z.enum(['plaid', 'saltedge']) }), req.body);
    const ctx = req.ctx!;
    await bankAccount(req.db, ctx.tenantId, id);
    if (!config.plaidClientId || !config.plaidSecret) {
      return {
        configured: false,
        provider: body.provider,
        message:
          'Bank feed integration is not configured. Add PLAID_CLIENT_ID / PLAID_SECRET to enable live feeds, or import a CSV statement in the meantime.',
      };
    }
    return {
      configured: true,
      provider: body.provider,
      linkTokenEndpoint: '/api/v1/banking/connect/token',
      message: 'Open the bank linking flow to authorise read-only access to transactions.',
    };
  });

  // -------------------------------------------------------- reconciliation --
  app.get('/banking/reconciliations', { preHandler: requireAuth() }, async (req) => {
    const rows = await req.db.all(
      `SELECT r.*, b.name AS bank_account_name FROM reconciliations r JOIN bank_accounts b ON b.id = r.bank_account_id
       WHERE r.tenant_id = ? ORDER BY r.created_at DESC LIMIT 50`,
      [req.ctx!.tenantId],
    );
    return { data: rows };
  });

  app.post('/banking/reconciliations', { preHandler: requireAuth('banking:write') }, async (req, reply) => {
    const body = parse(
      z.object({
        bankAccountId: z.string().uuid(),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        statementEndingBalance: z.coerce.number().int(),
      }),
      req.body,
    );
    const ctx = req.ctx!;
    const account = await bankAccount(req.db, ctx.tenantId, body.bankAccountId);
    const open = await req.db.get("SELECT id FROM reconciliations WHERE tenant_id = ? AND bank_account_id = ? AND status = 'open'", [ctx.tenantId, body.bankAccountId]);
    if (open) throw conflict('Finish the open reconciliation for this account before starting another');
    const cleared = await req.db.get<{ total: number }>(
      `SELECT COALESCE(SUM(t.amount),0) AS total FROM bank_transactions t
       WHERE t.tenant_id = ? AND t.bank_account_id = ? AND t.status IN ('reconciled','matched') AND t.date <= ?`,
      [ctx.tenantId, body.bankAccountId, body.endDate],
    );
    const id = newId();
    await req.db.run(
      `INSERT INTO reconciliations (id, tenant_id, bank_account_id, start_date, end_date, statement_ending_balance, beginning_balance, cleared_balance, difference, status, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 'open', ?)`,
      [id, ctx.tenantId, body.bankAccountId, body.endDate, body.statementEndingBalance, Number(account.opening_balance), Number(cleared?.total ?? 0), body.statementEndingBalance - Number(cleared?.total ?? 0) - Number(account.opening_balance), new Date().toISOString()],
    );
    return reply.code(201).send({ id });
  });

  app.get('/banking/reconciliations/:id', { preHandler: requireAuth() }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const ctx = req.ctx!;
    const recon = await req.db.get<Record<string, unknown>>(
      'SELECT * FROM reconciliations WHERE tenant_id = ? AND id = ?',
      [ctx.tenantId, id],
    );
    if (!recon) throw notFound('Reconciliation not found');
    const txns = await req.db.all<Record<string, unknown>>(
      `SELECT t.*, (SELECT COUNT(*) FROM reconciliation_items ri WHERE ri.transaction_id = t.id AND ri.reconciliation_id = ?) AS cleared
       FROM bank_transactions t
       WHERE t.tenant_id = ? AND t.bank_account_id = ? AND t.date <= ? AND t.status <> 'excluded'
       ORDER BY t.date, t.created_at`,
      [id, ctx.tenantId, recon.bank_account_id, recon.end_date],
    );
    const clearedTotal = txns.filter((t) => Number(t.cleared) > 0).reduce((a, t) => a + Number(t.amount), 0);
    return {
      reconciliation: recon,
      transactions: txns,
      summary: {
        beginningBalance: Number(recon.beginning_balance),
        clearedTotal,
        computedBalance: Number(recon.beginning_balance) + clearedTotal,
        statementEndingBalance: Number(recon.statement_ending_balance),
        difference: Number(recon.statement_ending_balance) - (Number(recon.beginning_balance) + clearedTotal),
      },
    };
  });

  app.post('/banking/reconciliations/:id/clear', { preHandler: requireAuth('banking:write') }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(z.object({ transactionIds: z.array(z.string()).default([]), clearAllMatched: z.boolean().default(false) }), req.body ?? {});
    const ctx = req.ctx!;
    const recon = await req.db.get<{ id: string; status: string; bank_account_id: string; end_date: string }>(
      'SELECT * FROM reconciliations WHERE tenant_id = ? AND id = ?',
      [ctx.tenantId, id],
    );
    if (!recon) throw notFound('Reconciliation not found');
    if (recon.status !== 'open') throw conflict('This reconciliation is already completed');
    let ids = body.transactionIds;
    if (body.clearAllMatched) {
      const matched = await req.db.all<{ id: string }>(
        "SELECT id FROM bank_transactions WHERE tenant_id = ? AND bank_account_id = ? AND status = 'matched' AND date <= ?",
        [ctx.tenantId, recon.bank_account_id, recon.end_date],
      );
      ids = matched.map((m) => m.id);
    }
    for (const txnId of ids) {
      const txn = await req.db.get<{ amount: number; status: string }>('SELECT amount, status FROM bank_transactions WHERE tenant_id = ? AND id = ?', [ctx.tenantId, txnId]);
      if (!txn) continue;
      await req.db.run(
        `INSERT INTO reconciliation_items (id, tenant_id, reconciliation_id, transaction_id, cleared_amount, created_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (reconciliation_id, transaction_id) DO NOTHING`,
        [newId(), ctx.tenantId, id, txnId, Number(txn.amount), new Date().toISOString()],
      );
      await req.db.run("UPDATE bank_transactions SET status = 'reconciled' WHERE tenant_id = ? AND id = ?", [ctx.tenantId, txnId]);
    }
    const cleared = await req.db.get<{ total: number; count: number }>(
      `SELECT COALESCE(SUM(cleared_amount),0) AS total, COUNT(*) AS count FROM reconciliation_items WHERE reconciliation_id = ?`,
      [id],
    );
    const reconRow = await req.db.get<{ beginning_balance: number; statement_ending_balance: number }>('SELECT * FROM reconciliations WHERE id = ?', [id]);
    const computed = Number(reconRow?.beginning_balance ?? 0) + Number(cleared?.total ?? 0);
    await req.db.run('UPDATE reconciliations SET cleared_balance = ?, difference = ? WHERE id = ?', [
      Number(cleared?.total ?? 0),
      Number(reconRow?.statement_ending_balance ?? 0) - computed,
      id,
    ]);
    return { cleared: Number(cleared?.count ?? 0), clearedTotal: Number(cleared?.total ?? 0), computed, difference: Number(reconRow?.statement_ending_balance ?? 0) - computed };
  });

  app.post('/banking/reconciliations/:id/complete', { preHandler: requireAuth('banking:write') }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const ctx = req.ctx!;
    const recon = await req.db.get<{ status: string; beginning_balance: number; statement_ending_balance: number }>(
      'SELECT * FROM reconciliations WHERE tenant_id = ? AND id = ?',
      [ctx.tenantId, id],
    );
    if (!recon) throw notFound('Reconciliation not found');
    if (recon.status === 'completed') throw conflict('Already completed');
    const cleared = await req.db.get<{ total: number }>('SELECT COALESCE(SUM(cleared_amount),0) AS total FROM reconciliation_items WHERE reconciliation_id = ?', [id]);
    const computed = Number(recon.beginning_balance) + Number(cleared?.total ?? 0);
    const difference = Number(recon.statement_ending_balance) - computed;
    if (difference !== 0) {
      throw unprocessable(`The reconciliation is off by ${(difference / 100).toFixed(2)}. Clear more transactions or add an adjustment.`);
    }
    await req.db.run(
      `UPDATE reconciliations SET status = 'completed', cleared_balance = ?, difference = 0, completed_at = ?, completed_by = ? WHERE id = ?`,
      [Number(cleared?.total ?? 0), new Date().toISOString(), ctx.user.id, id],
    );
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'banking.reconciled',
      entityType: 'reconciliation',
      entityId: id,
      summary: 'Bank reconciliation completed',
      after: { cleared: Number(cleared?.total ?? 0) },
    });
    await emitEvent(req.db, ctx.tenantId, 'reconciliation.completed', { reconciliationId: id });
    return { ok: true };
  });

  app.delete('/banking/transactions/:id/match', { preHandler: requireAuth('banking:write') }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const ctx = req.ctx!;
    const txn = await req.db.get<{ journal_entry_id: string | null; status: string }>(
      'SELECT * FROM bank_transactions WHERE tenant_id = ? AND id = ?',
      [ctx.tenantId, id],
    );
    if (!txn) throw notFound('Transaction not found');
    if (txn.journal_entry_id) {
      const { voidJournal } = await import('../domain/ledger.js');
      await voidJournal(req.db, ctx.tenantId, txn.journal_entry_id);
    }
    await req.db.run(
      "UPDATE bank_transactions SET status = 'unmatched', match_type = NULL, matched_entity_id = NULL, journal_entry_id = NULL WHERE tenant_id = ? AND id = ?",
      [ctx.tenantId, id],
    );
    return { ok: true };
  });
}

async function matchingRules(db: FastifyInstance['db'], tenantId: string, txn: { amount: number; description: string; payee: string | null }) {
  const rules = await db.all<{
    id: string;
    name: string;
    match_field: string;
    match_op: string;
    match_value: string;
    tx_direction: string;
    amount_min: number | null;
    amount_max: number | null;
    target_type: string;
    target_account_id: string | null;
    auto_apply: number;
  }>("SELECT * FROM bank_rules WHERE tenant_id = ? AND is_active = 1 ORDER BY priority", [tenantId]);
  return rules.filter((rule) => ruleMatches(rule, txn));
}

export function ruleMatches(
  rule: { match_field: string; match_op: string; match_value: string; tx_direction: string; amount_min: number | null; amount_max: number | null },
  txn: { amount: number; description: string; payee: string | null },
): boolean {
  const direction = txn.amount > 0 ? 'credit' : 'debit';
  if (rule.tx_direction !== 'any' && rule.tx_direction !== direction) return false;
  if (rule.amount_min !== null && rule.amount_min !== undefined && Math.abs(txn.amount) < Number(rule.amount_min)) return false;
  if (rule.amount_max !== null && rule.amount_max !== undefined && Math.abs(txn.amount) > Number(rule.amount_max)) return false;
  const raw =
    rule.match_field === 'payee'
      ? (txn.payee ?? '').toLowerCase()
      : rule.match_field === 'amount'
        ? String(Math.abs(txn.amount))
        : txn.description.toLowerCase();
  const value = rule.match_value.toLowerCase();
  switch (rule.match_op) {
    case 'equals':
      return raw === value;
    case 'starts_with':
      return raw.startsWith(value);
    default:
      return raw.includes(value);
  }
}

async function autoMatchOne(
  req: { db: DB },
  tenantId: string,
  userId: string | null,
  txnId: string,
): Promise<{ matched: boolean; type?: string; reason?: string }> {
  const txn = await req.db.get<{ id: string; amount: number; description: string; payee: string | null; bank_account_id: string; date: string }>(
    'SELECT * FROM bank_transactions WHERE tenant_id = ? AND id = ?',
    [tenantId, txnId],
  );
  if (!txn) return { matched: false, reason: 'not_found' };
  const rules = await matchingRules(req.db, tenantId, txn);
  const rule = rules[0];
  if (rule) {
    if (rule.target_type === 'exclude') {
      await req.db.run("UPDATE bank_transactions SET status = 'excluded' WHERE id = ?", [txnId]);
      return { matched: true, type: 'exclude' };
    }
    if (rule.auto_apply === 1 && rule.target_account_id) {
      await matchTransaction(req, tenantId, userId, txnId, { type: 'journal', accountId: rule.target_account_id, targetId: rule.id });
      return { matched: true, type: 'rule' };
    }
  }

  const candidate = await req.db.get<{ id: string; direction: string }>(
    `SELECT p.id, p.direction FROM payments p
     WHERE p.tenant_id = ? AND p.status = 'completed' AND p.amount = ? AND p.direction = ?
       AND p.date BETWEEN ? AND ?
       AND NOT EXISTS (SELECT 1 FROM bank_transactions bt WHERE bt.matched_entity_id = p.id)
     LIMIT 1`,
    [tenantId, Math.abs(txn.amount), txn.amount > 0 ? 'receipt' : 'disbursement', shift(txn.date, -14), shift(txn.date, 14)],
  );
  if (candidate) {
    await matchTransaction(req, tenantId, userId, txnId, { type: 'payment', targetId: candidate.id });
    return { matched: true, type: 'payment' };
  }

  if (txn.amount > 0) {
    const invoice = await req.db.get<{ id: string; total: number; balance: number; number: string }>(
      `SELECT i.id
       FROM invoices i
       WHERE i.tenant_id = ? AND i.kind = 'invoice' AND i.balance = ? AND i.status IN ('sent','partial','overdue')
         AND (i.number LIKE ? OR ? LIKE '%' || i.number || '%')
       LIMIT 1`,
      [tenantId, txn.amount, `%${txn.description}%`, txn.description],
    );
    if (invoice) {
      await matchTransaction(req, tenantId, userId, txnId, { type: 'invoice', targetId: invoice.id });
      return { matched: true, type: 'invoice' };
    }
  }
  return { matched: false, reason: 'no_candidate' };
}

async function matchTransaction(
  req: { db: DB },
  tenantId: string,
  userId: string | null,
  txnId: string,
  body: { type: 'payment' | 'invoice' | 'journal' | 'exclude'; targetId?: string; accountId?: string },
): Promise<{ ok: boolean; journalEntryId?: string | null; message?: string }> {
  const txn = await req.db.get<{
    id: string;
    amount: number;
    date: string;
    description: string;
    payee: string | null;
    bank_account_id: string;
    status: string;
    currency: string;
  }>('SELECT * FROM bank_transactions WHERE tenant_id = ? AND id = ?', [tenantId, txnId]);
  if (!txn) throw notFound('Transaction not found');
  if (txn.status === 'reconciled') throw conflict('This transaction is already reconciled');
  const account = await bankAccount(req.db, tenantId, txn.bank_account_id);
  const isInflow = txn.amount > 0;
  const absAmount = Math.abs(txn.amount);

  if (body.type === 'exclude') {
    await req.db.run("UPDATE bank_transactions SET status = 'excluded' WHERE tenant_id = ? AND id = ?", [tenantId, txnId]);
    return { ok: true };
  }

  if (body.type === 'payment') {
    if (!body.targetId) throw badRequest('Choose the payment to match');
    const payment = await req.db.get<{ id: string; deposit_account_id: string | null; amount: number; direction: string }>(
      'SELECT * FROM payments WHERE tenant_id = ? AND id = ?',
      [tenantId, body.targetId],
    );
    if (!payment) throw notFound('Payment not found');
    if (Number(payment.amount) !== absAmount) throw unprocessable('The payment amount does not match this bank transaction');
    let entryId: string | null = null;
    if (!payment.deposit_account_id || payment.deposit_account_id !== account.account_id) {
      const undeposited = await systemAccount(req.db, tenantId, 'undeposited_funds');
      entryId = await postJournal(req.db, {
        tenantId,
        date: txn.date,
        memo: `Bank match: ${txn.description}`,
        sourceType: 'bank',
        sourceId: txn.id,
        currency: txn.currency,
        createdBy: userId,
        lines: isInflow
          ? [
              { accountId: account.account_id, debit: absAmount, description: txn.description },
              { accountId: undeposited.id, credit: absAmount, description: 'Undeposited funds cleared' },
            ]
          : [
              { accountId: undeposited.id, debit: absAmount, description: 'Undeposited funds cleared' },
              { accountId: account.account_id, credit: absAmount, description: txn.description },
            ],
      });
    }
    await req.db.run(
      "UPDATE bank_transactions SET status = 'matched', match_type = 'payment', matched_entity_id = ?, journal_entry_id = ? WHERE tenant_id = ? AND id = ?",
      [payment.id, entryId, tenantId, txnId],
    );
    return { ok: true, journalEntryId: entryId };
  }

  if (body.type === 'invoice') {
    if (!body.targetId) throw badRequest('Choose the invoice to match');
    const invoice = await req.db.get<{ id: string; contact_id: string; balance: number; number: string }>(
      'SELECT id, contact_id, balance, number FROM invoices WHERE tenant_id = ? AND id = ?',
      [tenantId, body.targetId],
    );
    if (!invoice) throw notFound('Invoice not found');
    const amount = Math.min(absAmount, Number(invoice.balance));
    const payment = await recordPayment(req.db, tenantId, userId, {
      direction: 'receipt',
      contactId: invoice.contact_id,
      date: txn.date,
      amount,
      method: 'bank_transfer',
      reference: txn.description,
      depositAccountId: account.account_id,
      applications: [{ invoiceId: invoice.id, amount }],
    });
    await req.db.run(
      "UPDATE bank_transactions SET status = 'matched', match_type = 'invoice', matched_entity_id = ?, journal_entry_id = (SELECT journal_entry_id FROM payments WHERE id = ?) WHERE tenant_id = ? AND id = ?",
      [payment.paymentId, payment.paymentId, tenantId, txnId],
    );
    return { ok: true, message: `Recorded receipt ${payment.paymentId} for ${invoice.number}` };
  }

  if (!body.accountId) throw badRequest('Choose the account this transaction belongs to');
  const offsetAccount = await req.db.get<{ id: string; name: string }>('SELECT id, name FROM accounts WHERE tenant_id = ? AND id = ?', [
    tenantId,
    body.accountId,
  ]);
  if (!offsetAccount) throw notFound('Account not found');
  const entryId = await postJournal(req.db, {
    tenantId,
    date: txn.date,
    memo: txn.description,
    sourceType: 'bank',
    sourceId: txn.id,
    currency: txn.currency,
    createdBy: userId,
    lines: isInflow
      ? [
          { accountId: account.account_id, debit: absAmount, description: txn.description },
          { accountId: offsetAccount.id, credit: absAmount, description: txn.description },
        ]
      : [
          { accountId: offsetAccount.id, debit: absAmount, description: txn.description },
          { accountId: account.account_id, credit: absAmount, description: txn.description },
        ],
  });
  await req.db.run(
    "UPDATE bank_transactions SET status = 'matched', match_type = 'journal', matched_entity_id = ?, journal_entry_id = ? WHERE tenant_id = ? AND id = ?",
    [entryId, entryId, tenantId, txnId],
  );
  return { ok: true, journalEntryId: entryId };
}

function detectMapping(headers: string[]): { date: string; description: string; amount?: string; debit?: string; credit?: string; payee?: string } {
  const find = (candidates: string[]) =>
    headers.find((h) => candidates.includes(h.toLowerCase().replace(/[^a-z]/g, ''))) ?? '';
  const date = find(['date', 'transactiondate', 'posteddate', 'valuedate', 'dateposted']);
  const description = find(['description', 'memo', 'narrative', 'details', 'transaction', 'payee']);
  const amount = find(['amount', 'transactionamount', 'value']);
  const debit = find(['debit', 'withdrawal', 'moneyout', 'debitamount']);
  const credit = find(['credit', 'deposit', 'moneyin', 'creditamount']);
  return {
    date: date || headers[0],
    description: description || headers[1],
    ...(amount ? { amount } : { debit, credit }),
    payee: find(['payee', 'name', 'merchant']),
  };
}

function normaliseDate(value: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function hash(value: string): string {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) h = (Math.imul(31, h) + value.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

function shift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
