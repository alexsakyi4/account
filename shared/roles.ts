/**
 * Single source of truth for roles and permissions. Imported by the API (for
 * authorisation) and by the web app (for hiding actions a role cannot perform),
 * so the two can never drift apart.
 */
export const ROLES = ['admin', 'accountant', 'bookkeeper', 'employee'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrator',
  accountant: 'Accountant',
  bookkeeper: 'Bookkeeper',
  employee: 'Employee',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: 'Billing, users, company settings, data export and the full ledger.',
  accountant: 'Full accounting: journal entries, reconciliation, reports and imports.',
  bookkeeper: 'Day-to-day bookkeeping: invoices, bills, payments and bank reconciliation.',
  employee: 'Submits expenses and timesheets; cannot see company-wide reports.',
};

export const PERMISSIONS = [
  'company:manage',
  'users:manage',
  'billing:manage',
  'data:export',
  'accounts:write',
  'journal:write',
  'invoices:write',
  'bills:write',
  'payments:write',
  'banking:write',
  'reports:read',
  'payroll:manage',
  'timesheets:approve',
  'inventory:manage',
  'expenses:submit',
  'timesheets:submit',
  'audit:read',
  'import:write',
  'integrations:manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: PERMISSIONS,
  accountant: [
    'data:export',
    'accounts:write',
    'journal:write',
    'invoices:write',
    'bills:write',
    'payments:write',
    'banking:write',
    'reports:read',
    'payroll:manage',
    'timesheets:approve',
    'inventory:manage',
    'expenses:submit',
    'timesheets:submit',
    'audit:read',
    'import:write',
    'integrations:manage',
  ],
  bookkeeper: [
    'invoices:write',
    'bills:write',
    'payments:write',
    'banking:write',
    'reports:read',
    'inventory:manage',
    'expenses:submit',
    'timesheets:submit',
    'import:write',
  ],
  employee: ['expenses:submit', 'timesheets:submit'],
};

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function permissionsFor(role: string): Permission[] {
  return isRole(role) ? [...ROLE_PERMISSIONS[role]] : [];
}

export function can(role: string, permission: Permission): boolean {
  return isRole(role) && ROLE_PERMISSIONS[role].includes(permission);
}
