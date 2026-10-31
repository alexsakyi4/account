/**
 * Generates docs/openapi.json from the live Fastify route table.
 *
 * Run with `npm run openapi`. The document is committed so the hosted
 * `/api/v1/docs` explorer works without running a generator at boot.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { registerRoutes } from '../server/src/routes/index.js';

interface Captured {
  method: string;
  url: string;
}

const TAG_BY_SEGMENT: Record<string, { tag: string; noun: string }> = {
  auth: { tag: 'Authentication', noun: 'session' },
  accounts: { tag: 'Chart of Accounts', noun: 'account' },
  contacts: { tag: 'Contacts', noun: 'contact' },
  invoices: { tag: 'Invoices', noun: 'invoice' },
  'invoice-templates': { tag: 'Invoices', noun: 'invoice template' },
  'recurring-invoices': { tag: 'Invoices', noun: 'recurring invoice' },
  estimates: { tag: 'Invoices', noun: 'estimate' },
  bills: { tag: 'Bills & Expenses', noun: 'bill' },
  expenses: { tag: 'Bills & Expenses', noun: 'expense' },
  payments: { tag: 'Payments', noun: 'payment' },
  banking: { tag: 'Banking', noun: 'banking record' },
  journal: { tag: 'Journal', noun: 'journal entry' },
  'journal-entries': { tag: 'Journal', noun: 'journal entry' },
  reports: { tag: 'Reports', noun: 'report' },
  inventory: { tag: 'Inventory', noun: 'inventory record' },
  items: { tag: 'Inventory', noun: 'item' },
  payroll: { tag: 'Payroll', noun: 'payroll run' },
  employees: { tag: 'Payroll', noun: 'employee' },
  timesheets: { tag: 'Payroll', noun: 'timesheet' },
  settings: { tag: 'Settings', noun: 'setting' },
  currencies: { tag: 'Multi-currency & Tax', noun: 'currency' },
  'tax-codes': { tag: 'Multi-currency & Tax', noun: 'tax code' },
  imports: { tag: 'Import & Export', noun: 'import' },
  export: { tag: 'Import & Export', noun: 'export' },
  webhooks: { tag: 'Integrations', noun: 'webhook' },
  'api-keys': { tag: 'Integrations', noun: 'API key' },
  integrations: { tag: 'Integrations', noun: 'integration' },
  admin: { tag: 'Admin console', noun: 'tenant' },
  audit: { tag: 'Audit', noun: 'audit record' },
  activity: { tag: 'Audit', noun: 'activity' },
  gdpr: { tag: 'Privacy (GDPR)', noun: 'data subject request' },
  security: { tag: 'Security', noun: 'security setting' },
  onboarding: { tag: 'Onboarding', noun: 'onboarding step' },
  periods: { tag: 'Accounting periods', noun: 'period' },
  notifications: { tag: 'Notifications', noun: 'notification' },
  attachments: { tag: 'Attachments', noun: 'attachment' },
  users: { tag: 'Users & Roles', noun: 'user' },
  company: { tag: 'Settings', noun: 'company' },
  flags: { tag: 'Settings', noun: 'feature flag' },
  subscription: { tag: 'Billing', noun: 'subscription' },
  usage: { tag: 'Billing', noun: 'usage summary' },
  public: { tag: 'Public', noun: 'public invoice' },
};

const VERBS: Array<[RegExp, (noun: string) => string, string]> = [
  [/\/post$/, (n) => `Post ${article(n)} ${n} to the ledger`, 'Posts the document and creates a balanced journal entry.'],
  [/\/void$/, (n) => `Void ${article(n)} ${n}`, 'Reverses the document without deleting history.'],
  [/\/send$/, (n) => `Send ${article(n)} ${n} by email`, 'Queues the document email and returns the delivery status.'],
  [/\/remind$/, (n) => `Send a payment reminder for ${article(n)} ${n}`, 'Sends a reminder email and records it against the invoice.'],
  [/\/approve$/, (n) => `Approve ${article(n)} ${n}`, 'Moves the record into an approved state and emits a webhook event.'],
  [/\/reject$/, (n) => `Reject ${article(n)} ${n}`, 'Marks the record rejected with an optional reason.'],
  [/\/convert$/, (n) => `Convert ${article(n)} ${n}`, 'Creates the downstream document while keeping a link to the source.'],
  [/\/duplicate$/, (n) => `Duplicate ${article(n)} ${n}`, 'Copies the document into a fresh draft.'],
  [/\/reverse$/, (n) => `Reverse ${article(n)} ${n}`, 'Creates a mirror-image entry dated on the reversal date.'],
  [/\/adjust$/, (n) => `Adjust ${article(n)} ${n}`, 'Records a quantity or valuation adjustment with an audit trail.'],
  [/\/match$/, (n) => `Match ${article(n)} ${n}`, 'Links a bank transaction to a payment or journal entry.'],
  [/\/bulk$/, (n) => `Bulk update ${n}s`, 'Applies an action to many records in one call.'],
  [/\/clear$/, (n) => `Clear ${n} lines`, 'Marks the selected statement lines as reconciled.'],
  [/\/complete$/, (n) => `Complete ${article(n)} ${n}`, 'Locks the reconciliation; refuses to close while a difference remains.'],
  [/\/connect$/, (n) => `Connect ${article(n)} ${n} to a bank feed`, 'Starts a Plaid/SaltEdge link session for the account.'],
  [/\/import$/, (n) => `Import a statement into ${article(n)} ${n}`, 'Accepts a CSV or provider payload of statement lines.'],
  [/\/auto-match$/, (n) => `Run auto-match rules`, 'Suggests matches using amounts, dates, payees and saved rules.'],
  [/\/preview$/, (n) => `Preview ${article(n)} ${n}`, 'Dry-runs the file and reports per-row errors without writing.'],
  [/\/execute$/, (n) => `Execute ${article(n)} ${n}`, 'Writes the validated rows and returns a batch summary.'],
  [/\/export$/, (n) => `Export ${n} data`, 'Streams CSV/PDF output for the requested range.'],
  [/\/publish$/, (n) => `Publish ${article(n)} ${n}`, 'Unlocks reporting for the period after close.'],
  [/\/generate$/, (n) => `Generate ${n}s`, 'Creates the next set of accounting periods.'],
  [/\/pay$/, (n) => `Pay ${article(n)} ${n}`, 'Records the payroll disbursement journal entry.'],
  [/\/setup$/, (n) => `Start 2FA enrolment`, 'Returns a TOTP secret and otpauth:// URI.'],
  [/\/enable$/, (n) => `Enable 2FA`, 'Confirms the TOTP code and stores recovery codes.'],
  [/\/disable$/, (n) => `Disable 2FA`, 'Requires a fresh TOTP code before removal.'],
  [/\/verify$/, (n) => `Verify a one-time code`, 'Validates a TOTP or recovery code.'],
  [/\/invite$/, (n) => `Invite ${article(n)} ${n}`, 'Sends a signed invitation scoped to the tenant and role.'],
  [/\/test$/, (n) => `Send a test ${n} delivery`, 'Delivers a ping payload to every active endpoint.'],
  [/\/checkout$/, (n) => `Start checkout for ${article(n)} ${n}`, 'Creates a provider session; card data never touches LedgerLine.'],
  [/\/statement$/, (n) => `Get ${article(n)} ${n} statement`, 'Returns opening balance, activity and closing balance.'],
  [/\/impersonate$/, (n) => `Impersonate ${article(n)} ${n}`, 'Issues a short-lived support token, recorded in the audit trail.'],
  [/\/apply-template$/, (n) => `Apply an ${n} template`, 'Seeds the chart of accounts from an industry template.'],
  [/\/rate$/, (n) => `Get an exchange rate`, 'Returns the stored rate for a currency pair.'],
  [/\/portal-link$/, (n) => `Create a customer portal link for ${article(n)} ${n}`, 'Issues a scoped token for the customer statement portal.'],
  [/\/reset$/, (n) => `Reset ${n}`, 'Clears progress and restarts the walkthrough.'],
  [/\/change$/, (n) => `Change ${article(n)} ${n}`, 'Switches the tenant plan and recalculates the next invoice.'],
  [/\/read$/, (n) => `Mark ${article(n)} ${n} as read`, 'Updates the notification read flag.'],
  [/\/erase$/, (n) => `Erase personal data`, 'Anonymises personal data while retaining immutable financial records.'],
  [/\/verify-2fa$/, (n) => `Step up with 2FA`, 'Issues an elevated session token for sensitive actions.'],
  [/\/accept-invite$/, (n) => `Accept an invitation`, 'Creates the membership and returns session tokens.'],
  [/\/switch-tenant$/, (n) => `Switch tenants`, 'Re-issues tokens scoped to another tenant the user belongs to.'],
  [/\/login$/, (n) => `Log in`, 'Returns an access token and rotating refresh token cookie.'],
  [/\/demo$/, (n) => `Log in to the sample company`, 'Issues a read-only sandbox session for the demo tenant.'],
  [/\/logout$/, (n) => `Log out`, 'Revokes the current session and refresh token family.'],
  [/\/refresh$/, (n) => `Refresh a session`, 'Rotates the refresh token and detects reuse.'],
  [/\/register$/, (n) => `Create a company account`, 'Provisions a tenant, chart of accounts, defaults and an admin user.'],
  [/\/password$/, (n) => `Change the account password`, 'Requires the current password and revokes other sessions.'],
];

const SCHEMA_FOR_BODY: Record<string, string> = {
  'POST /auth/register': 'RegisterRequest',
  'POST /auth/login': 'LoginRequest',
  'POST /invoices': 'InvoiceInput',
  'PATCH /invoices/{id}': 'InvoiceInput',
  'POST /bills': 'BillInput',
  'POST /contacts': 'ContactInput',
  'PATCH /contacts/{id}': 'ContactInput',
  'POST /accounts': 'AccountInput',
  'POST /payments': 'PaymentInput',
  'POST /expenses': 'ExpenseInput',
  'POST /journal-entries': 'JournalEntryInput',
  'POST /items': 'ItemInput',
  'POST /webhooks': 'WebhookInput',
  'POST /reports/schedules': 'ReportScheduleInput',
  'POST /imports/preview': 'ImportRequest',
  'POST /imports/execute': 'ImportRequest',
};

const RESPONSE_FOR: Record<string, string> = {
  'POST /auth/register': 'AuthSession',
  'POST /auth/login': 'AuthSession',
  'POST /auth/refresh': 'AuthSession',
  'POST /auth/demo': 'AuthSession',
  'POST /auth/accept-invite': 'AuthSession',
  'POST /auth/switch-tenant': 'AuthSession',
  'GET /auth/me': 'Me',
  'POST /invoices': 'CreatedDocument',
  'GET /invoices/{id}': 'Invoice',
  'POST /bills': 'CreatedDocument',
  'GET /bills/{id}': 'Bill',
  'GET /contacts/{id}': 'Contact',
  'GET /accounts': 'AccountList',
  'GET /reports/{type}': 'Report',
  'GET /reports/dashboard': 'Dashboard',
  'POST /webhooks': 'CreatedWebhook',
  'POST /payments': 'CreatedPayment',
};

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

function singular(word: string): string {
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

function operationMeta(method: string, url: string): { tag: string; summary: string; description: string } {
  const segments = url.replace('/api/v1/', '').split('/');
  const first = segments[0];
  const known = TAG_BY_SEGMENT[first] ?? { tag: 'General', noun: singular(first) };
  const hasId = segments.some((s) => s.startsWith(':'));
  const isCollection = segments.length === 1;
  const tail = url.split('/').pop() ?? '';
  for (const [pattern, summary, description] of VERBS) {
    if (pattern.test(url)) return { tag: known.tag, summary: summary(known.noun), description };
  }
  const noun = known.noun;
  if (method === 'GET') {
    if (url.includes('/pdf')) return { tag: known.tag, summary: `Download a ${noun} as PDF`, description: 'Returns a rendered PDF generated from the stored document.' };
    if (url.includes('/export')) return { tag: known.tag, summary: `Export ${noun}s`, description: 'Streams a CSV export compatible with spreadsheet and QuickBooks import tools.' };
    if (isCollection) return { tag: known.tag, summary: `List ${noun}s`, description: `Paginated ${noun} list with search and filters.` };
    if (hasId) return { tag: known.tag, summary: `Get ${article(noun)} ${noun}`, description: `Returns a single ${noun} with related lines and balances.` };
    return { tag: known.tag, summary: `Get ${noun} ${tail.replace(/-/g, ' ')}`, description: `Returns ${noun} ${tail.replace(/-/g, ' ')} data.` };
  }
  if (method === 'POST') {
    if (isCollection) return { tag: known.tag, summary: `Create ${article(noun)} ${noun}`, description: `Creates a ${noun} in the current tenant.` };
    return { tag: known.tag, summary: `Run ${noun} action`, description: `Performs the ${tail} action on the ${noun}.` };
  }
  if (method === 'PATCH' || method === 'PUT') return { tag: known.tag, summary: `Update ${article(noun)} ${noun}`, description: `Applies a partial update to the ${noun}.` };
  if (method === 'DELETE') return { tag: known.tag, summary: `Delete ${article(noun)} ${noun}`, description: `Removes the ${noun} where the accounting rules allow it.` };
  return { tag: known.tag, summary: `${method} ${url}`, description: '' };
}

function toOpenApiPath(url: string): string {
  return url.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

const schemas: Record<string, unknown> = {
  Error: {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          code: { type: 'string', examples: ['validation_error'] },
          message: { type: 'string' },
          details: { type: 'object', additionalProperties: true },
        },
      },
      requestId: { type: 'string', format: 'uuid' },
    },
  },
  Pagination: {
    type: 'object',
    properties: {
      page: { type: 'integer', minimum: 1, default: 1 },
      pageSize: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      q: { type: 'string', description: 'Free-text search across the primary fields.' },
    },
  },
  AuthSession: {
    type: 'object',
    required: ['accessToken', 'user', 'tenant'],
    properties: {
      accessToken: { type: 'string', description: 'Short-lived JWT (15 minutes).' },
      refreshToken: { type: 'string', description: 'Rotating refresh token; also set as an HttpOnly cookie.' },
      user: { $ref: '#/components/schemas/User' },
      tenant: { $ref: '#/components/schemas/Tenant' },
      role: { type: 'string', enum: ['admin', 'accountant', 'bookkeeper', 'employee'] },
      requires2fa: { type: 'boolean' },
    },
  },
  RegisterRequest: {
    type: 'object',
    required: ['companyName', 'name', 'email', 'password'],
    properties: {
      companyName: { type: 'string', minLength: 3, maxLength: 120 },
      name: { type: 'string', minLength: 3 },
      email: { type: 'string', format: 'email' },
      password: { type: 'string', minLength: 10, description: 'Must contain upper, lower, number and symbol.' },
      industry: { type: 'string', description: 'Selects the chart-of-accounts template.' },
      currency: { type: 'string', minLength: 3, maxLength: 3, default: 'USD' },
      country: { type: 'string' },
      sampleData: { type: 'boolean', default: false },
    },
  },
  LoginRequest: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', format: 'email' },
      password: { type: 'string' },
      totp: { type: 'string', description: 'Six-digit TOTP code when 2FA is enabled.' },
    },
  },
  Me: {
    type: 'object',
    properties: {
      user: { $ref: '#/components/schemas/User' },
      tenant: { $ref: '#/components/schemas/Tenant' },
      role: { type: 'string' },
      permissions: { type: 'array', items: { type: 'string' } },
      flags: { type: 'object', additionalProperties: { type: 'boolean' } },
    },
  },
  User: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      email: { type: 'string', format: 'email' },
      twoFactorEnabled: { type: 'boolean' },
      lastLoginAt: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  Tenant: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      currency: { type: 'string' },
      country: { type: 'string', nullable: true },
      plan: { type: 'string', enum: ['trial', 'starter', 'growth', 'scale'] },
      fiscalYearStart: { type: 'string', pattern: '^\\d{2}-\\d{2}$' },
      timezone: { type: 'string' },
    },
  },
  AccountInput: {
    type: 'object',
    required: ['code', 'name', 'type'],
    properties: {
      code: { type: 'string', maxLength: 12 },
      name: { type: 'string' },
      type: { type: 'string', enum: ['asset', 'liability', 'equity', 'income', 'expense'] },
      subtype: { type: 'string', nullable: true },
      parentId: { type: 'string', format: 'uuid', nullable: true },
      description: { type: 'string' },
      isActive: { type: 'boolean', default: true },
    },
  },
  Account: {
    allOf: [{ $ref: '#/components/schemas/AccountInput' }],
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      balance: { type: 'integer', description: 'Minor units in the tenant currency.' },
      systemKey: { type: 'string', nullable: true },
    },
  },
  AccountList: {
    type: 'object',
    properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Account' } } },
  },
  ContactInput: {
    type: 'object',
    required: ['name', 'kind'],
    properties: {
      name: { type: 'string' },
      kind: { type: 'string', enum: ['customer', 'vendor', 'both'] },
      email: { type: 'string', format: 'email', nullable: true },
      phone: { type: 'string', nullable: true },
      companyName: { type: 'string', nullable: true },
      paymentTermsDays: { type: 'integer', default: 30 },
      creditLimit: { type: 'integer', nullable: true, description: 'Minor units.' },
      currency: { type: 'string' },
      billingAddress: { type: 'object', additionalProperties: { type: 'string' } },
      taxId: { type: 'string', nullable: true },
      notes: { type: 'string' },
    },
  },
  Contact: {
    allOf: [{ $ref: '#/components/schemas/ContactInput' }],
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      openBalance: { type: 'integer' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  InvoiceLineInput: {
    type: 'object',
    required: ['description', 'quantity', 'unitPrice'],
    properties: {
      description: { type: 'string' },
      quantity: { type: 'number', exclusiveMinimum: 0 },
      unitPrice: { type: 'integer', description: 'Minor units per unit.' },
      accountId: { type: 'string', format: 'uuid', nullable: true },
      taxCodeId: { type: 'string', format: 'uuid', nullable: true },
      itemId: { type: 'string', format: 'uuid', nullable: true },
      discountBp: { type: 'integer', minimum: 0, maximum: 10000, description: 'Basis points (1000 = 10%).' },
    },
  },
  InvoiceInput: {
    type: 'object',
    required: ['contactId', 'issueDate', 'lines'],
    properties: {
      contactId: { type: 'string', format: 'uuid' },
      kind: { type: 'string', enum: ['invoice', 'credit_memo', 'estimate'], default: 'invoice' },
      issueDate: { type: 'string', format: 'date' },
      dueDate: { type: 'string', format: 'date', nullable: true },
      currency: { type: 'string', minLength: 3, maxLength: 3 },
      fxRate: { type: 'number', exclusiveMinimum: 0 },
      lines: { type: 'array', minItems: 1, items: { $ref: '#/components/schemas/InvoiceLineInput' } },
      memo: { type: 'string' },
      terms: { type: 'string' },
      poNumber: { type: 'string' },
      status: { type: 'string', enum: ['draft', 'sent'], default: 'draft' },
      autoPost: { type: 'boolean' },
      templateId: { type: 'string', format: 'uuid', nullable: true },
    },
  },
  Invoice: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      number: { type: 'string' },
      kind: { type: 'string' },
      status: { type: 'string', enum: ['draft', 'sent', 'partial', 'paid', 'overdue', 'void', 'converted'] },
      contactId: { type: 'string', format: 'uuid' },
      contactName: { type: 'string' },
      issueDate: { type: 'string', format: 'date' },
      dueDate: { type: 'string', format: 'date', nullable: true },
      subtotal: { type: 'integer' },
      taxTotal: { type: 'integer' },
      total: { type: 'integer' },
      amountPaid: { type: 'integer' },
      balance: { type: 'integer' },
      currency: { type: 'string' },
      lines: { type: 'array', items: { $ref: '#/components/schemas/InvoiceLineInput' } },
      publicToken: { type: 'string', nullable: true },
      journalEntryId: { type: 'string', format: 'uuid', nullable: true },
    },
  },
  CreatedDocument: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      number: { type: 'string' },
    },
  },
  BillInput: {
    type: 'object',
    required: ['vendorId', 'issueDate', 'lines'],
    properties: {
      vendorId: { type: 'string', format: 'uuid' },
      number: { type: 'string' },
      issueDate: { type: 'string', format: 'date' },
      dueDate: { type: 'string', format: 'date' },
      lines: { type: 'array', minItems: 1, items: { $ref: '#/components/schemas/InvoiceLineInput' } },
      status: { type: 'string', enum: ['draft', 'open'], default: 'draft' },
      memo: { type: 'string' },
      currency: { type: 'string' },
    },
  },
  Bill: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      number: { type: 'string' },
      vendorId: { type: 'string', format: 'uuid' },
      vendorName: { type: 'string' },
      status: { type: 'string', enum: ['draft', 'open', 'partial', 'paid', 'void'] },
      total: { type: 'integer' },
      balance: { type: 'integer' },
      dueDate: { type: 'string', format: 'date' },
      scheduledPaymentDate: { type: 'string', format: 'date', nullable: true },
    },
  },
  ExpenseInput: {
    type: 'object',
    required: ['date', 'lines'],
    properties: {
      date: { type: 'string', format: 'date' },
      contactId: { type: 'string', format: 'uuid', nullable: true },
      employeeId: { type: 'string', format: 'uuid', nullable: true },
      currency: { type: 'string' },
      lines: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            amount: { type: 'integer' },
            accountId: { type: 'string', format: 'uuid' },
            taxCodeId: { type: 'string', format: 'uuid', nullable: true },
            receiptUrl: { type: 'string', nullable: true },
          },
        },
      },
      status: { type: 'string', enum: ['draft', 'submitted', 'approved'] },
      memo: { type: 'string' },
    },
  },
  PaymentInput: {
    type: 'object',
    required: ['amount', 'method'],
    properties: {
      amount: { type: 'integer', description: 'Minor units.' },
      method: { type: 'string', enum: ['card', 'ach', 'bank_transfer', 'cash', 'check', 'other'] },
      direction: { type: 'string', enum: ['received', 'sent'] },
      invoiceId: { type: 'string', format: 'uuid', nullable: true },
      billId: { type: 'string', format: 'uuid', nullable: true },
      contactId: { type: 'string', format: 'uuid', nullable: true },
      depositAccountId: { type: 'string', format: 'uuid' },
      paymentDate: { type: 'string', format: 'date' },
      providerFee: { type: 'integer' },
      reference: { type: 'string' },
      idempotencyKey: { type: 'string' },
    },
  },
  CreatedPayment: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      status: { type: 'string' },
      clientSecret: { type: 'string', nullable: true, description: 'Provider token for the hosted payment page.' },
    },
  },
  JournalEntryInput: {
    type: 'object',
    required: ['date', 'lines'],
    properties: {
      date: { type: 'string', format: 'date' },
      memo: { type: 'string' },
      reference: { type: 'string' },
      lines: {
        type: 'array',
        minItems: 2,
        items: {
          type: 'object',
          required: ['accountId'],
          properties: {
            accountId: { type: 'string', format: 'uuid' },
            debit: { type: 'integer' },
            credit: { type: 'integer' },
            description: { type: 'string' },
            contactId: { type: 'string', format: 'uuid', nullable: true },
          },
        },
      },
    },
  },
  ItemInput: {
    type: 'object',
    required: ['sku', 'name'],
    properties: {
      sku: { type: 'string' },
      name: { type: 'string' },
      itemType: { type: 'string', enum: ['inventory', 'service', 'non_inventory'] },
      salesPrice: { type: 'integer' },
      purchaseCost: { type: 'integer' },
      incomeAccountId: { type: 'string', format: 'uuid', nullable: true },
      quantityOnHand: { type: 'number' },
      reorderPoint: { type: 'number', nullable: true },
    },
  },
  WebhookInput: {
    type: 'object',
    required: ['url', 'events'],
    properties: {
      url: { type: 'string', format: 'uri', description: 'HTTPS endpoint (HTTP allowed for local testing).' },
      events: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', examples: ['invoice.created', 'invoice.paid', 'payment.received', '*'] },
      },
    },
  },
  CreatedWebhook: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      secret: { type: 'string', description: 'HMAC-SHA256 signing secret (whsec_…). Shown once.' },
      note: { type: 'string' },
    },
  },
  ReportScheduleInput: {
    type: 'object',
    required: ['reportType', 'name', 'recipients'],
    properties: {
      reportType: { type: 'string', examples: ['profit-and-loss', 'balance-sheet', 'cash-flow', 'ar-aging', 'ap-aging', 'trial-balance'] },
      name: { type: 'string' },
      frequency: { type: 'string', enum: ['weekly', 'monthly', 'quarterly'], default: 'monthly' },
      recipients: { type: 'string', description: 'Comma-separated email addresses.' },
      format: { type: 'string', enum: ['csv', 'pdf'], default: 'csv' },
      from: { type: 'string', format: 'date' },
      to: { type: 'string', format: 'date' },
    },
  },
  ImportRequest: {
    type: 'object',
    required: ['kind', 'csv'],
    properties: {
      kind: { type: 'string', enum: ['accounts', 'customers', 'vendors', 'invoices', 'bills', 'journal', 'items', 'transactions'] },
      csv: { type: 'string', description: 'Raw CSV including the header row (QuickBooks headers are auto-mapped).' },
      mapping: { type: 'object', additionalProperties: { type: 'string' } },
      dryRun: { type: 'boolean' },
    },
  },
  Report: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      from: { type: 'string', format: 'date' },
      to: { type: 'string', format: 'date' },
      sections: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            label: { type: 'string' },
            lines: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  accountId: { type: 'string' },
                  code: { type: 'string' },
                  name: { type: 'string' },
                  amount: { type: 'integer' },
                },
              },
            },
            total: { type: 'integer' },
          },
        },
      },
    },
  },
  Dashboard: {
    type: 'object',
    properties: {
      cash: { type: 'integer' },
      receivables: { type: 'integer' },
      payables: { type: 'integer' },
      revenue: { type: 'integer' },
      expenses: { type: 'integer' },
      netProfit: { type: 'integer' },
      trend: { type: 'array', items: { type: 'object' } },
      tasks: { type: 'array', items: { type: 'object' } },
    },
  },
};

const securitySchemes = {
  bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
  apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
  tenantHeader: { type: 'apiKey', in: 'header', name: 'X-Tenant-Id' },
};

function buildBody(method: string, pathKey: string): Record<string, unknown> | undefined {
  if (!['POST', 'PATCH', 'PUT'].includes(method)) return undefined;
  if (pathKey.includes('/payment-preview') || pathKey.includes('/auto-match')) return undefined;
  const ref = SCHEMA_FOR_BODY[`${method} ${pathKey}`];
  return {
    required: true,
    content: {
      'application/json': {
        schema: ref ? { $ref: `#/components/schemas/${ref}` } : { type: 'object', additionalProperties: true },
      },
    },
  };
}

async function main(): Promise<void> {
  const app = Fastify({ logger: false });
  const routes: Captured[] = [];
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) routes.push({ method, url: route.url });
  });
  await app.register(async (scope) => registerRoutes(scope), { prefix: '/api/v1' });
  await app.ready();

  const paths: Record<string, Record<string, unknown>> = {};
  for (const { method, url } of routes) {
    if (method === 'HEAD') continue;
    if (url.includes('/openapi.json') || url.includes('/docs')) continue;
    const fullPath = toOpenApiPath(url);
    const openApiPath = fullPath.replace('/api/v1', '');
    const pathKey = openApiPath;
    const meta = operationMeta(method, url);
    const isPublic = url.startsWith('/api/v1/public') || url.includes('/auth/login') || url.includes('/auth/register') ||
      url.includes('/auth/demo') || url.includes('/auth/refresh') || url.includes('/auth/password/reset') ||
      url.includes('/webhooks/payments/');
    const parameters: unknown[] = [];
    for (const param of openApiPath.match(/\{[^}]+\}/g) ?? []) {
      parameters.push({
        name: param.slice(1, -1),
        in: 'path',
        required: true,
        schema: { type: 'string' },
      });
    }
    if (method === 'GET' && !parameters.some((p) => (p as { name: string }).name === 'id')) {
      parameters.push(
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
        { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
        { name: 'q', in: 'query', schema: { type: 'string' } },
      );
    }
    if (url.includes('/reports/{type}') || url.includes('/reports/:type')) {
      parameters.push(
        { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'basis', in: 'query', schema: { type: 'string', enum: ['accrual', 'cash'] } },
      );
    }
    const successRef = RESPONSE_FOR[`${method} ${pathKey}`];
    const operation: Record<string, unknown> = {
      tags: [meta.tag],
      summary: meta.summary,
      description: meta.description,
      operationId: `${method.toLowerCase()}${pathKey.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : '')).replace(/^./, (c) => c.toUpperCase())}`,
      parameters,
      responses: {
        '200': {
          description: 'Successful response',
          content: {
            'application/json': {
              schema: successRef ? { $ref: `#/components/schemas/${successRef}` } : { type: 'object', additionalProperties: true },
            },
          },
        },
        '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '401': { description: 'Missing or invalid credentials', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '403': { description: 'Role is not permitted to perform this action', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '404': { description: 'Resource not found in this tenant', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '429': { description: 'Rate limit exceeded', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    };
    const body = buildBody(method, pathKey);
    if (body) operation.requestBody = body;
    if (!isPublic) operation.security = [{ bearerAuth: [] }, { apiKeyAuth: [] }];
    paths[openApiPath] = { ...(paths[openApiPath] ?? {}), [method.toLowerCase()]: operation };
  }

  const spec = {
    openapi: '3.1.0',
    info: {
      title: 'LedgerLine API',
      version: '1.0.0',
      description: [
        'Multi-tenant double-entry accounting API: invoicing, bills and expenses, payments,',
        'banking and reconciliation, journals, inventory, payroll, reporting, imports and webhooks.',
        '',
        '**Authentication** — `POST /api/v1/auth/login` returns a 15-minute JWT. Send it as',
        '`Authorization: Bearer <token>`. Machine clients can use an `X-API-Key` instead.',
        'Every response carries `X-Request-Id`; errors use `{ error: { code, message } }`.',
        '',
        '**Tenancy** — every record is scoped to the tenant in the token. Requests may name a',
        'different tenant with `X-Tenant-Id` only when the user is a member of it.',
        '',
        '**Money** — all amounts are integers in the currency minor unit (cents). Dates are',
        'ISO-8601 (`YYYY-MM-DD`). Timestamps are UTC.',
        '',
        '**Idempotency** — send `Idempotency-Key` on `POST` requests that create money movements.',
      ].join('\n'),
      contact: { name: 'LedgerLine support', email: 'support@ledgerline.app' },
      license: { name: 'MIT' },
    },
    servers: [{ url: '/api/v1', description: 'Current host' }],
    tags: [
      'Authentication', 'Chart of Accounts', 'Contacts', 'Invoices', 'Bills & Expenses', 'Payments',
      'Banking', 'Journal', 'Reports', 'Inventory', 'Payroll', 'Multi-currency & Tax', 'Import & Export',
      'Integrations', 'Admin console', 'Audit', 'Privacy (GDPR)', 'Security', 'Onboarding',
      'Accounting periods', 'Notifications', 'Attachments', 'Users & Roles', 'Settings', 'Billing', 'Public',
    ].map((name) => ({ name })),
    components: {
      securitySchemes,
      schemas,
    },
    security: [{ bearerAuth: [] }],
    paths,
  };

  const out = path.resolve(process.cwd(), 'docs/openapi.json');
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(spec, null, 2)}\n`);
  const count = Object.values(paths).reduce((sum, ops) => sum + Object.keys(ops).length, 0);
  console.log(`Wrote ${out} — ${Object.keys(paths).length} paths, ${count} operations`);
  await app.close();
}

await main();
