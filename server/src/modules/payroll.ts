import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { newId } from '../db/driver.js';
import { SYSTEM_ACCOUNTS } from '../domain/accounts.js';
import { postJournal, systemAccount } from '../domain/ledger.js';
import { computePayrollLine, periodPay, type PayFrequency } from '../domain/payroll.js';
import { conflict, notFound, unprocessable } from '../lib/errors.js';
import { paginated, paging, paginationSchema, parse } from '../lib/validate.js';
import { requireAuth, type AuthContext } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.js';

function requireModule(req: { ctx?: AuthContext }, key: 'payroll' | 'timesheets'): void {
  if (!req.ctx?.flags[key]) {
    throw unprocessable(`The ${key} module is disabled for this company. Enable it in Settings → Features.`);
  }
}

export async function payrollRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------- employees --
  app.get('/employees', { preHandler: requireAuth() }, async (req) => {
    const ctx = req.ctx!;
    const query = parse(paginationSchema, req.query);
    const where = ['tenant_id = ?'];
    const params: Array<string | number> = [ctx.tenantId];
    if (query.q) {
      where.push('(LOWER(name) LIKE ? OR LOWER(employee_no) LIKE ?)');
      const like = `%${query.q.toLowerCase()}%`;
      params.push(like, like);
    }
    const { limit, offset } = paging(query.page, query.pageSize);
    const rows = await req.db.all(
      `SELECT * FROM employees WHERE ${where.join(' AND ')} ORDER BY name LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    const total = await req.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM employees WHERE ${where.join(' AND ')}`, params);
    return paginated(rows, Number(total?.n ?? 0), query.page, query.pageSize);
  });

  app.post('/employees', { preHandler: requireAuth('payroll:manage') }, async (req, reply) => {
    const body = parse(
      z.object({
        name: z.string().min(1).max(120),
        email: z.string().email().optional(),
        employeeNo: z.string().max(30).optional(),
        payType: z.enum(['salary', 'hourly']).default('salary'),
        payRate: z.coerce.number().int().min(0),
        payFrequency: z.enum(['weekly', 'biweekly', 'semimonthly', 'monthly', 'annual']).default('monthly'),
        taxId: z.string().max(40).optional(),
        hireDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
      req.body,
    );
    const ctx = req.ctx!;
    requireModule(req, 'payroll');
    const id = newId();
    const count = await req.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM employees WHERE tenant_id = ?', [ctx.tenantId]);
    const employeeNo = body.employeeNo ?? `EMP-${String(Number(count?.n ?? 0) + 1).padStart(3, '0')}`;
    const clash = await req.db.get('SELECT id FROM employees WHERE tenant_id = ? AND employee_no = ?', [ctx.tenantId, employeeNo]);
    if (clash) throw conflict(`Employee number ${employeeNo} is already in use`);
    await req.db.run(
      `INSERT INTO employees (id, tenant_id, employee_no, name, email, pay_type, pay_rate, pay_frequency, tax_id, hire_date, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      [id, ctx.tenantId, employeeNo, body.name, body.email ?? null, body.payType, body.payRate, body.payFrequency, body.taxId ?? null, body.hireDate ?? null, new Date().toISOString()],
    );
    return reply.code(201).send({ id, employeeNo });
  });

  app.patch('/employees/:id', { preHandler: requireAuth('payroll:manage') }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(
      z.object({
        name: z.string().min(1).optional(),
        email: z.string().email().optional(),
        payRate: z.coerce.number().int().min(0).optional(),
        payType: z.enum(['salary', 'hourly']).optional(),
        status: z.enum(['active', 'inactive']).optional(),
      }),
      req.body,
    );
    const ctx = req.ctx!;
    await req.db.run(
      `UPDATE employees SET name = COALESCE(?, name), email = COALESCE(?, email), pay_rate = COALESCE(?, pay_rate),
        pay_type = COALESCE(?, pay_type), status = COALESCE(?, status) WHERE tenant_id = ? AND id = ?`,
      [body.name ?? null, body.email ?? null, body.payRate ?? null, body.payType ?? null, body.status ?? null, ctx.tenantId, id],
    );
    return { ok: true };
  });

  // ------------------------------------------------------------ timesheets --
  app.get('/timesheets', { preHandler: requireAuth() }, async (req) => {
    const ctx = req.ctx!;
    const query = parse(
      paginationSchema.extend({
        employeeId: z.string().optional(),
        status: z.string().default('all'),
        weekOf: z.string().optional(),
      }),
      req.query,
    );
    const where = ['t.tenant_id = ?'];
    const params: Array<string | number> = [ctx.tenantId];
    if (query.employeeId) {
      where.push('t.employee_id = ?');
      params.push(query.employeeId);
    }
    if (query.status !== 'all') {
      where.push('t.status = ?');
      params.push(query.status);
    }
    // Employees only see their own time.
    if (ctx.role === 'employee') {
      where.push('e.email = ?');
      params.push(ctx.user.email);
    }
    if (query.from) {
      where.push('t.work_date >= ?');
      params.push(query.from);
    }
    if (query.to) {
      where.push('t.work_date <= ?');
      params.push(query.to);
    }
    const rows = await req.db.all(
      `SELECT t.*, e.name AS employee_name FROM timesheets t JOIN employees e ON e.id = t.employee_id
       WHERE ${where.join(' AND ')} ORDER BY t.work_date DESC LIMIT 500`,
      params,
    );
    return { data: rows };
  });

  app.post('/timesheets', { preHandler: requireAuth('timesheets:submit') }, async (req, reply) => {
    const body = parse(
      z.object({
        employeeId: z.string().uuid().optional(),
        entries: z
          .array(
            z.object({
              workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
              hours: z.coerce.number().min(0).max(24),
              project: z.string().max(120).optional(),
              billable: z.boolean().default(false),
              rate: z.coerce.number().int().min(0).optional(),
              description: z.string().max(500).optional(),
            }),
          )
          .min(1)
          .max(50),
      }),
      req.body,
    );
    const ctx = req.ctx!;
    requireModule(req, 'timesheets');
    let employeeId = body.employeeId;
    if (!employeeId) {
      const employee = await req.db.get<{ id: string }>('SELECT id FROM employees WHERE tenant_id = ? AND email = ?', [ctx.tenantId, ctx.user.email]);
      if (!employee) throw unprocessable('No employee record is linked to your account. Ask an administrator to add you.');
      employeeId = employee.id;
    }
    for (const entry of body.entries) {
      await req.db.run(
        `INSERT INTO timesheets (id, tenant_id, employee_id, work_date, hours, project, billable, rate, description, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?)`,
        [newId(), ctx.tenantId, employeeId, entry.workDate, entry.hours, entry.project ?? null, entry.billable ? 1 : 0, entry.rate ?? 0, entry.description ?? null, new Date().toISOString()],
      );
    }
    return reply.code(201).send({ created: body.entries.length });
  });

  app.post('/timesheets/approve', { preHandler: requireAuth('timesheets:approve') }, async (req) => {
    const body = parse(z.object({ ids: z.array(z.string()).min(1).max(200), status: z.enum(['approved', 'rejected']).default('approved') }), req.body);
    const ctx = req.ctx!;
    let updated = 0;
    for (const id of body.ids) {
      updated += await req.db.run('UPDATE timesheets SET status = ?, approved_by = ? WHERE tenant_id = ? AND id = ?', [
        body.status,
        ctx.user.id,
        ctx.tenantId,
        id,
      ]);
    }
    return { updated };
  });

  // ------------------------------------------------------------- pay runs --
  app.get('/payroll/runs', { preHandler: requireAuth('payroll:manage') }, async (req) => {
    const ctx = req.ctx!;
    const rows = await req.db.all('SELECT * FROM payroll_runs WHERE tenant_id = ? ORDER BY pay_date DESC LIMIT 50', [ctx.tenantId]);
    return { data: rows };
  });

  app.post('/payroll/runs', { preHandler: requireAuth('payroll:manage') }, async (req, reply) => {
    const body = parse(
      z.object({
        periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        payDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }),
      req.body,
    );
    const ctx = req.ctx!;
    requireModule(req, 'payroll');
    const employees = await req.db.all<{
      id: string;
      name: string;
      pay_type: string;
      pay_rate: number;
      pay_frequency: PayFrequency;
    }>("SELECT id, name, pay_type, pay_rate, pay_frequency FROM employees WHERE tenant_id = ? AND status = 'active'", [ctx.tenantId]);
    if (!employees.length) throw unprocessable('Add at least one active employee before running payroll');

    const runId = newId();
    let grossTotal = 0;
    let taxTotal = 0;
    let employerTotal = 0;
    let netTotal = 0;
    const lines: Array<{ employeeId: string; name: string; hours: number; gross: number; withholding: number; employerTax: number; net: number; calc: ReturnType<typeof computePayrollLine> }> = [];

    for (const employee of employees) {
      let gross = 0;
      let hours = 0;
      if (employee.pay_type === 'hourly') {
        const timesheet = await req.db.get<{ hours: number }>(
          `SELECT COALESCE(SUM(hours),0) AS hours FROM timesheets
           WHERE tenant_id = ? AND employee_id = ? AND status = 'approved' AND work_date BETWEEN ? AND ?`,
          [ctx.tenantId, employee.id, body.periodStart, body.periodEnd],
        );
        hours = Number(timesheet?.hours ?? 0);
        gross = Math.round(hours * Number(employee.pay_rate));
      } else {
        gross = periodPay(Number(employee.pay_rate), employee.pay_frequency ?? 'monthly');
      }
      if (gross <= 0) continue;
      const calc = computePayrollLine(gross, employee.pay_frequency ?? 'monthly');
      const employerTax = calc.employerSocial + calc.employerMedicare;
      const withholding = calc.incomeTax + calc.socialTax + calc.medicare;
      grossTotal += gross;
      taxTotal += withholding + employerTax;
      employerTotal += employerTax;
      netTotal += calc.net;
      lines.push({ employeeId: employee.id, name: employee.name, hours, gross, withholding, employerTax, net: calc.net, calc });
    }

    await req.db.run(
      `INSERT INTO payroll_runs (id, tenant_id, period_start, period_end, pay_date, status, gross, tax_total, deductions_total, net_total, created_at)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
      [runId, ctx.tenantId, body.periodStart, body.periodEnd, body.payDate, grossTotal, taxTotal, employerTotal, netTotal, new Date().toISOString()],
    );
    for (const line of lines) {
      const calc = line.calc;
      await req.db.run(
        `INSERT INTO payroll_lines (id, tenant_id, run_id, employee_id, hours, gross, income_tax, social_tax, medicare, deductions, net)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId(), ctx.tenantId, runId, line.employeeId, line.hours, calc.gross, calc.incomeTax, calc.socialTax, calc.medicare, calc.employerSocial + calc.employerMedicare, calc.net],
      );
    }
    return reply.code(201).send({ id: runId, gross: grossTotal, tax: taxTotal, net: netTotal, employees: lines.length });
  });

  app.get('/payroll/runs/:id', { preHandler: requireAuth('payroll:manage') }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const ctx = req.ctx!;
    const run = await req.db.get<Record<string, unknown>>('SELECT * FROM payroll_runs WHERE tenant_id = ? AND id = ?', [ctx.tenantId, id]);
    if (!run) throw notFound('Payroll run not found');
    const lines = await req.db.all(
      `SELECT l.*, e.name AS employee_name FROM payroll_lines l JOIN employees e ON e.id = l.employee_id
       WHERE l.tenant_id = ? AND l.run_id = ? ORDER BY e.name`,
      [ctx.tenantId, id],
    );
    return { run, lines };
  });

  app.post('/payroll/runs/:id/approve', { preHandler: requireAuth('payroll:manage') }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const ctx = req.ctx!;
    const run = await req.db.get<{ status: string; gross: number; tax_total: number; deductions_total: number; net_total: number; pay_date: string; period_start: string; period_end: string; journal_entry_id: string | null }>(
      'SELECT * FROM payroll_runs WHERE tenant_id = ? AND id = ?',
      [ctx.tenantId, id],
    );
    if (!run) throw notFound('Payroll run not found');
    if (run.journal_entry_id) throw conflict('This payroll run is already posted');

    const salaries = await systemAccount(req.db, ctx.tenantId, SYSTEM_ACCOUNTS.PAYROLL_EXPENSE);
    const taxExpense = await systemAccount(req.db, ctx.tenantId, SYSTEM_ACCOUNTS.PAYROLL_TAX_EXPENSE);
    const liabilities = await systemAccount(req.db, ctx.tenantId, SYSTEM_ACCOUNTS.PAYROLL_LIABILITIES);
    // tax_total = employee withholdings + employer contributions; deductions_total = employer share.
    const employerTax = Number(run.deductions_total);

    const entryId = await postJournal(req.db, {
      tenantId: ctx.tenantId,
      date: run.pay_date,
      memo: `Payroll ${run.period_start} to ${run.period_end}`,
      sourceType: 'payroll',
      sourceId: id,
      currency: ctx.tenant.base_currency,
      createdBy: ctx.user.id,
      lines: [
        { accountId: salaries.id, debit: Number(run.gross), description: 'Gross wages' },
        { accountId: taxExpense.id, debit: Math.max(0, employerTax), description: 'Employer payroll taxes' },
        { accountId: liabilities.id, credit: Number(run.tax_total), description: 'Payroll taxes withheld and employer contributions' },
        { accountId: liabilities.id, credit: Number(run.net_total), description: 'Net pay payable' },
      ],
    });
    await req.db.run("UPDATE payroll_runs SET status = 'approved', journal_entry_id = ? WHERE id = ?", [entryId, id]);
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'payroll.approved',
      entityType: 'payroll_run',
      entityId: id,
      summary: `Payroll approved: gross ${run.gross}`,
    });
    return { ok: true, journalEntryId: entryId };
  });

  app.post('/payroll/runs/:id/pay', { preHandler: requireAuth('payroll:manage') }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(z.object({ bankAccountId: z.string().uuid().optional() }), req.body ?? {});
    const ctx = req.ctx!;
    const run = await req.db.get<{ status: string; net_total: number; pay_date: string; journal_entry_id: string | null }>(
      'SELECT * FROM payroll_runs WHERE tenant_id = ? AND id = ?',
      [ctx.tenantId, id],
    );
    if (!run) throw notFound('Payroll run not found');
    if (run.status !== 'approved') throw unprocessable('Approve the payroll run before paying it');
    const liabilities = await systemAccount(req.db, ctx.tenantId, SYSTEM_ACCOUNTS.PAYROLL_LIABILITIES);
    const bankAccountId = body.bankAccountId
      ? (await req.db.get<{ account_id: string }>('SELECT account_id FROM bank_accounts WHERE tenant_id = ? AND id = ?', [ctx.tenantId, body.bankAccountId]))?.account_id
      : (await systemAccount(req.db, ctx.tenantId, SYSTEM_ACCOUNTS.CHECKING)).id;
    if (!bankAccountId) throw unprocessable('Choose a bank account');
    await postJournal(req.db, {
      tenantId: ctx.tenantId,
      date: run.pay_date,
      memo: 'Payroll disbursement',
      sourceType: 'payroll',
      sourceId: id,
      currency: ctx.tenant.base_currency,
      createdBy: ctx.user.id,
      lines: [
        { accountId: liabilities.id, debit: Number(run.net_total), description: 'Net pay cleared' },
        { accountId: bankAccountId, credit: Number(run.net_total), description: 'Payroll payment' },
      ],
    });
    await req.db.run("UPDATE payroll_runs SET status = 'paid' WHERE id = ?", [id]);
    return { ok: true };
  });

  app.get('/payroll/summary', { preHandler: requireAuth('payroll:manage') }, async (req) => {
    const ctx = req.ctx!;
    const employees = await req.db.get<{ count: number; annual: number }>(
      `SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN pay_type = 'salary' THEN pay_rate * 12 ELSE pay_rate * 2080 END),0) AS annual
       FROM employees WHERE tenant_id = ? AND status = 'active'`,
      [ctx.tenantId],
    );
    const runs = await req.db.all('SELECT id, period_start, period_end, pay_date, status, gross, net_total FROM payroll_runs WHERE tenant_id = ? ORDER BY pay_date DESC LIMIT 6', [ctx.tenantId]);
    return { headcount: Number(employees?.count ?? 0), annualPayroll: Number(employees?.annual ?? 0), recentRuns: runs };
  });
}
