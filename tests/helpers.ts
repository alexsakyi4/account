import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/src/app.js';
import { createDb, type DB } from '../server/src/db/driver.js';
import { migrate } from '../server/src/db/migrate.js';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-1234';
process.env.ENCRYPTION_KEY = 'test-encryption-key-test-encryption-1';
process.env.UPLOAD_DIR = path.join(tmpdir(), 'ledgerline-test-uploads');

export interface TestContext {
  app: FastifyInstance;
  db: DB;
  dir: string;
  close: () => Promise<void>;
}

export async function createTestApp(): Promise<TestContext> {
  const dir = mkdtempSync(path.join(tmpdir(), 'ledgerline-test-'));
  const db = createDb(`sqlite:${path.join(dir, 'test.db')}`);
  await migrate(db);
  const app = await buildApp({ db, logger: false });
  await app.ready();
  return {
    app,
    db,
    dir,
    close: async () => {
      await app.close();
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface Session {
  token: string;
  refreshToken: string;
  tenantId: string;
  userId: string;
}

export async function registerCompany(ctx: TestContext, name = 'Test Co'): Promise<Session> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      companyName: name,
      name: 'Ada Lovelace',
      email: `admin-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`,
      password: 'CorrectHorse123!',
      industry: 'services',
      currency: 'USD',
    },
  });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  const body = res.json();
  return { token: body.accessToken, refreshToken: body.refreshToken, tenantId: body.session.tenant.id, userId: body.session.user.id };
}

export async function authed(
  ctx: TestContext,
  session: Session,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
) {
  return ctx.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${session.token}` },
    payload: payload as object | undefined,
  });
}

export async function createCustomer(ctx: TestContext, session: Session, name = 'Acme Ltd'): Promise<string> {
  const res = await authed(ctx, session, 'POST', '/contacts', {
    name,
    kind: 'customer',
    email: `${name.toLowerCase().replace(/\W/g, '')}@example.com`,
    paymentTermsDays: 30,
  });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json().id;
}

export async function createVendor(ctx: TestContext, session: Session, name = 'Supplier Inc'): Promise<string> {
  const res = await authed(ctx, session, 'POST', '/contacts', { name, kind: 'vendor', paymentTermsDays: 15 });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json().id;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function accountId(ctx: TestContext, session: Session, code: string): Promise<string> {
  const res = await authed(ctx, session, 'GET', '/accounts?includeInactive=true&pageSize=500');
  const account = res.json().data.find((a: { code: string }) => a.code === code);
  if (!account) throw new Error(`Account ${code} not found`);
  return account.id;
}

export async function taxCodeId(ctx: TestContext, session: Session, code = 'TAX0'): Promise<string> {
  const res = await authed(ctx, session, 'GET', '/tax-codes');
  const tax = res.json().data.find((t: { code: string }) => t.code === code);
  if (!tax) throw new Error(`Tax code ${code} not found`);
  return tax.id;
}

export async function journalTotals(ctx: TestContext, tenantId: string) {
  const row = await ctx.db.get<{ debit: number; credit: number }>(
    `SELECT COALESCE(SUM(jl.debit),0) AS debit, COALESCE(SUM(jl.credit),0) AS credit
     FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
     WHERE je.tenant_id = ? AND je.status = 'posted'`,
    [tenantId],
  );
  return { debit: Number(row?.debit ?? 0), credit: Number(row?.credit ?? 0) };
}

export async function addMember(
  ctx: TestContext,
  session: Session,
  role: 'accountant' | 'bookkeeper' | 'employee',
): Promise<Session> {
  const email = `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const invite = await authed(ctx, session, 'POST', '/users/invite', { email, role });
  const token = new URL(invite.json().inviteUrl).searchParams.get('token')!;
  const accept = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/accept-invite',
    payload: { token, password: 'AnotherPass123!', name: `${role} user` },
  });
  if (accept.statusCode !== 200) throw new Error(accept.body);
  const body = accept.json();
  return { token: body.accessToken, refreshToken: body.refreshToken, tenantId: body.session.tenant.id, userId: body.session.user.id };
}
