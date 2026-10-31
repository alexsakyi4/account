/**
 * Roles, permissions, feature flags and per-company settings.
 */
import type { DB } from '../db/driver.js';
import { forbidden, notFound } from '../lib/errors.js';
import { can } from '../../../shared/roles.js';
import type { Permission } from '../../../shared/roles.js';

export {
  ROLES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLE_LABELS,
  ROLE_DESCRIPTIONS,
  can,
  isRole,
  permissionsFor,
} from '../../../shared/roles.js';
export type { Role, Permission } from '../../../shared/roles.js';

export function requirePermission(role: string, permission: Permission): void {
  if (!can(role, permission)) {
    throw forbidden(`Your role (${role}) cannot perform this action. Required permission: ${permission}`);
  }
}

export const FEATURE_FLAGS: Record<string, { default: boolean; label: string; description: string }> = {
  inventory: { default: true, label: 'Inventory', description: 'Track stock, COGS and adjustments' },
  payroll: { default: false, label: 'Payroll', description: 'Payroll runs and payslips' },
  multi_currency: { default: true, label: 'Multi-currency', description: 'Transact and report in foreign currencies' },
  bank_feeds: { default: true, label: 'Bank feeds', description: 'Connect live bank feeds and import statements' },
  recurring_invoices: { default: true, label: 'Recurring invoices', description: 'Automatically issue invoices on a schedule' },
  expense_ocr: { default: true, label: 'Receipt OCR', description: 'Extract totals from uploaded receipts' },
  timesheets: { default: true, label: 'Timesheets', description: 'Employee time tracking and approvals' },
  approvals: { default: false, label: 'Approvals', description: 'Expense and bill approval workflows' },
  api_access: { default: true, label: 'API & webhooks', description: 'REST API keys and outbound webhooks' },
};

export async function getFlags(db: DB, tenantId: string): Promise<Record<string, boolean>> {
  const rows = await db.all<{ flag_key: string; enabled: number }>(
    'SELECT flag_key, enabled FROM feature_flags WHERE tenant_id = ?',
    [tenantId],
  );
  const result: Record<string, boolean> = {};
  for (const [key, meta] of Object.entries(FEATURE_FLAGS)) result[key] = meta.default;
  for (const row of rows) result[row.flag_key] = Number(row.enabled) === 1;
  return result;
}

export async function isFeatureEnabled(db: DB, tenantId: string, key: string): Promise<boolean> {
  const flags = await getFlags(db, tenantId);
  return Boolean(flags[key]);
}

export async function setFlag(db: DB, tenantId: string, key: string, enabled: boolean): Promise<void> {
  if (!FEATURE_FLAGS[key]) throw notFound(`Unknown feature flag: ${key}`);
  await db.run(
    `INSERT INTO feature_flags (id, tenant_id, flag_key, enabled, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, flag_key) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
    [crypto.randomUUID(), tenantId, key, enabled ? 1 : 0, new Date().toISOString()],
  );
}

export interface TenantSettings {
  invoiceFooter: string;
  invoicePrefix: string;
  defaultPaymentTermsDays: number;
  taxEnabled: boolean;
  defaultTaxCodeId: string | null;
  lateFeePercent: number;
  reminderDays: number[];
  dateFormat: string;
  fiscalYearStartMonth: number;
  autoNumbering: boolean;
  approvalThreshold: number;
  logoUrl?: string | null;
}

export const DEFAULT_SETTINGS: TenantSettings = {
  invoiceFooter: 'Thank you for your business.',
  invoicePrefix: 'INV',
  defaultPaymentTermsDays: 30,
  taxEnabled: true,
  defaultTaxCodeId: null,
  lateFeePercent: 0,
  reminderDays: [3, 7, 14],
  dateFormat: 'YYYY-MM-DD',
  fiscalYearStartMonth: 1,
  autoNumbering: true,
  approvalThreshold: 0,
  logoUrl: null,
};

export function readSettings(raw: string | null | undefined): TenantSettings {
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<TenantSettings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export interface TenantContext {
  id: string;
  name: string;
  slug: string;
  base_currency: string;
  industry: string;
  plan: string;
  status: string;
  is_sandbox: number;
  fiscal_year_start_month: number;
  settings_json: string | null;
}

export async function loadTenant(db: DB, tenantId: string): Promise<TenantContext> {
  const tenant = await db.get<TenantContext>('SELECT * FROM tenants WHERE id = ? AND deleted_at IS NULL', [tenantId]);
  if (!tenant) throw notFound('Company not found');
  if (tenant.status === 'suspended') throw forbidden('This company is suspended. Contact support.');
  return tenant;
}
