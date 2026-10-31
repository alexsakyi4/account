-- ============================================================================
-- LedgerLine — core schema
-- Portable SQL: works on SQLite (development / demo) and PostgreSQL (production).
--
-- Conventions
--   * All primary keys are application-generated UUIDv4 strings (TEXT/UUID).
--   * Monetary values are stored as BIGINT **minor units** (cents). Never floats.
--   * Timestamps are ISO-8601 UTC strings, which sort lexicographically.
--   * Booleans are INTEGER 0/1 so the same DDL works on both engines.
--   * Every tenant-owned table carries tenant_id and is indexed by it. Row level
--     isolation is enforced in the data-access layer (see server/src/db/tenant.ts).
-- ============================================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- ---------------------------------------------------------------- tenancy ---
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  legal_name TEXT,
  industry TEXT NOT NULL DEFAULT 'general',
  base_currency TEXT NOT NULL DEFAULT 'USD',
  fiscal_year_start_month INTEGER NOT NULL DEFAULT 1,
  plan TEXT NOT NULL DEFAULT 'trial',
  status TEXT NOT NULL DEFAULT 'active',          -- active|suspended|deleted
  is_sandbox INTEGER NOT NULL DEFAULT 0,
  trial_ends_at TEXT,
  phone TEXT,
  email TEXT,
  website TEXT,
  address_json TEXT,
  settings_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_recovery_json TEXT,
  is_platform_admin INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  locale TEXT NOT NULL DEFAULT 'en-US',
  last_login_at TEXT,
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,                              -- admin|accountant|bookkeeper|employee
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_tenant ON memberships(tenant_id);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  plan TEXT NOT NULL,
  status TEXT NOT NULL,                            -- trialing|active|past_due|canceled
  seats INTEGER NOT NULL DEFAULT 1,
  price_cents BIGINT NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  current_period_start TEXT,
  current_period_end TEXT,
  provider TEXT,
  provider_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subs_tenant ON subscriptions(tenant_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tenant_id TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  family_id TEXT NOT NULL,
  user_agent TEXT,
  ip TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS password_resets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT '*',
  role TEXT NOT NULL DEFAULT 'bookkeeper',
  created_by TEXT,
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys(tenant_id);

-- ------------------------------------------------------------ audit trail ---
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  seq INTEGER NOT NULL,
  actor_id TEXT,
  actor_email TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  summary TEXT,
  before_json TEXT,
  after_json TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  prev_hash TEXT,
  hash TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_audit_tenant_seq ON audit_logs(tenant_id, seq);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(tenant_id, entity_type, entity_id);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT,
  title TEXT NOT NULL,
  body TEXT,
  level TEXT NOT NULL DEFAULT 'info',
  link TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(tenant_id, user_id);

CREATE TABLE IF NOT EXISTS feature_flags (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  flag_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  config_json TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, flag_key)
);

CREATE TABLE IF NOT EXISTS onboarding_progress (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  completed_at TEXT,
  data_json TEXT,
  UNIQUE (tenant_id, step_key)
);

-- -------------------------------------------------------------- accounting ---
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,                               -- asset|liability|equity|income|expense
  subtype TEXT,
  parent_id TEXT,
  description TEXT,
  is_system INTEGER NOT NULL DEFAULT 0,             -- referenced by the posting engine
  system_key TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  currency TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, code)
);
CREATE INDEX IF NOT EXISTS idx_accounts_tenant ON accounts(tenant_id, type);
CREATE INDEX IF NOT EXISTS idx_accounts_parent ON accounts(tenant_id, parent_id);

CREATE TABLE IF NOT EXISTS fiscal_periods (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',              -- open|closed|locked
  closed_at TEXT,
  closed_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, start_date, end_date)
);
CREATE INDEX IF NOT EXISTS idx_periods_tenant ON fiscal_periods(tenant_id);

CREATE TABLE IF NOT EXISTS journal_entries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  entry_no INTEGER NOT NULL,
  date TEXT NOT NULL,
  memo TEXT,
  source_type TEXT NOT NULL DEFAULT 'manual',        -- invoice|bill|payment|expense|payroll|bank|adjusting|opening|reversal
  source_id TEXT,
  status TEXT NOT NULL DEFAULT 'posted',             -- posted|void
  currency TEXT NOT NULL,
  fx_rate REAL NOT NULL DEFAULT 1,
  reversal_of TEXT,
  created_by TEXT,
  posted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, entry_no)
);
CREATE INDEX IF NOT EXISTS idx_je_tenant_date ON journal_entries(tenant_id, date);
CREATE INDEX IF NOT EXISTS idx_je_source ON journal_entries(tenant_id, source_type, source_id);

CREATE TABLE IF NOT EXISTS journal_lines (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  description TEXT,
  debit BIGINT NOT NULL DEFAULT 0,
  credit BIGINT NOT NULL DEFAULT 0,
  contact_id TEXT,
  tax_code_id TEXT,
  currency TEXT NOT NULL,
  amount_ccy BIGINT NOT NULL DEFAULT 0,
  fx_rate REAL NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_jl_entry ON journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS idx_jl_account ON journal_lines(tenant_id, account_id);

-- --------------------------------------------------------------- contacts ---
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'customer',            -- customer|vendor|both
  name TEXT NOT NULL,
  company_name TEXT,
  email TEXT,
  phone TEXT,
  billing_address_json TEXT,
  shipping_address_json TEXT,
  payment_terms_days INTEGER NOT NULL DEFAULT 30,
  credit_limit BIGINT NOT NULL DEFAULT 0,
  tax_id TEXT,
  currency TEXT,
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  portal_token TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_tenant ON contacts(tenant_id, kind, is_active);

CREATE TABLE IF NOT EXISTS tax_codes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  rate_bp INTEGER NOT NULL DEFAULT 0,                -- basis points: 1500 = 15%
  tax_type TEXT NOT NULL DEFAULT 'vat',              -- vat|gst|sales|custom
  is_inclusive INTEGER NOT NULL DEFAULT 0,
  account_id TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS currencies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  symbol TEXT,
  is_base INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS exchange_rates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  base_currency TEXT NOT NULL,
  quote_currency TEXT NOT NULL,
  rate REAL NOT NULL,
  rate_date TEXT NOT NULL,
  source TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, base_currency, quote_currency, rate_date)
);

-- ------------------------------------------------------- invoice to cash ---
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'invoice',             -- invoice|credit_memo|estimate
  number TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'draft',             -- draft|sent|partial|paid|overdue|void|accepted|declined|converted
  currency TEXT NOT NULL,
  fx_rate REAL NOT NULL DEFAULT 1,
  subtotal BIGINT NOT NULL DEFAULT 0,
  discount_total BIGINT NOT NULL DEFAULT 0,
  tax_total BIGINT NOT NULL DEFAULT 0,
  total BIGINT NOT NULL DEFAULT 0,
  amount_paid BIGINT NOT NULL DEFAULT 0,
  balance BIGINT NOT NULL DEFAULT 0,
  memo TEXT,
  terms TEXT,
  po_number TEXT,
  template_id TEXT,
  estimate_id TEXT,
  recurring_id TEXT,
  sent_at TEXT,
  last_reminder_at TEXT,
  reminder_count INTEGER NOT NULL DEFAULT 0,
  journal_entry_id TEXT,
  payment_link_token TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, kind, number)
);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant ON invoices(tenant_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_invoices_contact ON invoices(tenant_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_invoices_due ON invoices(tenant_id, due_date);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  item_id TEXT,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_price BIGINT NOT NULL DEFAULT 0,
  amount BIGINT NOT NULL DEFAULT 0,
  discount_bp INTEGER NOT NULL DEFAULT 0,
  account_id TEXT,
  tax_code_id TEXT,
  tax_amount BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_inv_lines ON invoice_lines(tenant_id, invoice_id);

CREATE TABLE IF NOT EXISTS invoice_templates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  accent_color TEXT NOT NULL DEFAULT '#0f766e',
  layout TEXT NOT NULL DEFAULT 'modern',
  footer_text TEXT,
  show_logo INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recurring_invoices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'monthly',        -- weekly|monthly|quarterly|yearly
  interval_count INTEGER NOT NULL DEFAULT 1,
  next_date TEXT NOT NULL,
  end_date TEXT,
  template_json TEXT NOT NULL,
  auto_send INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',            -- active|paused|ended
  last_invoice_id TEXT,
  last_run_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recurring_tenant ON recurring_invoices(tenant_id, status, next_date);

CREATE TABLE IF NOT EXISTS invoice_reminders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  reminder_type TEXT NOT NULL DEFAULT 'overdue',
  channel TEXT NOT NULL DEFAULT 'email',
  status TEXT NOT NULL DEFAULT 'sent',
  sent_at TEXT NOT NULL,
  message TEXT
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'receipt',        -- receipt|disbursement
  number TEXT NOT NULL,
  contact_id TEXT,
  date TEXT NOT NULL,
  amount BIGINT NOT NULL,
  currency TEXT NOT NULL,
  fx_rate REAL NOT NULL DEFAULT 1,
  method TEXT NOT NULL DEFAULT 'bank_transfer',     -- card|ach|bank_transfer|cash|check|other
  reference TEXT,
  deposit_account_id TEXT,
  status TEXT NOT NULL DEFAULT 'completed',         -- pending|completed|failed|voided
  provider TEXT NOT NULL DEFAULT 'manual',          -- manual|stripe|adyen|offline
  provider_ref TEXT,
  provider_fee BIGINT NOT NULL DEFAULT 0,
  tax_amount BIGINT NOT NULL DEFAULT 0,
  journal_entry_id TEXT,
  notes TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_tenant ON payments(tenant_id, direction, status);

CREATE TABLE IF NOT EXISTS payment_applications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  invoice_id TEXT,
  bill_id TEXT,
  amount BIGINT NOT NULL,
  applied_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pay_apps ON payment_applications(tenant_id, payment_id);

-- ---------------------------------------------------- bills and expenses ---
CREATE TABLE IF NOT EXISTS bills (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  number TEXT NOT NULL,
  vendor_id TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'draft',             -- draft|open|scheduled|partial|paid|void|overdue
  currency TEXT NOT NULL,
  fx_rate REAL NOT NULL DEFAULT 1,
  subtotal BIGINT NOT NULL DEFAULT 0,
  tax_total BIGINT NOT NULL DEFAULT 0,
  total BIGINT NOT NULL DEFAULT 0,
  amount_paid BIGINT NOT NULL DEFAULT 0,
  balance BIGINT NOT NULL DEFAULT 0,
  memo TEXT,
  scheduled_payment_date TEXT,
  journal_entry_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, number)
);
CREATE INDEX IF NOT EXISTS idx_bills_tenant ON bills(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_bills_vendor ON bills(tenant_id, vendor_id);

CREATE TABLE IF NOT EXISTS bill_lines (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  bill_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  item_id TEXT,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_price BIGINT NOT NULL DEFAULT 0,
  amount BIGINT NOT NULL DEFAULT 0,
  account_id TEXT,
  tax_code_id TEXT,
  tax_amount BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_bill_lines ON bill_lines(tenant_id, bill_id);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  number TEXT NOT NULL,
  contact_id TEXT,
  employee_id TEXT,
  date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted',         -- draft|submitted|approved|rejected|reimbursed|posted
  currency TEXT NOT NULL,
  subtotal BIGINT NOT NULL DEFAULT 0,
  tax_total BIGINT NOT NULL DEFAULT 0,
  total BIGINT NOT NULL DEFAULT 0,
  memo TEXT,
  payment_method TEXT,
  receipt_attachment_id TEXT,
  ocr_json TEXT,
  journal_entry_id TEXT,
  approved_by TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, number)
);
CREATE INDEX IF NOT EXISTS idx_expenses_tenant ON expenses(tenant_id, status);

CREATE TABLE IF NOT EXISTS expense_lines (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  expense_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  tax_code_id TEXT,
  description TEXT,
  amount BIGINT NOT NULL DEFAULT 0,
  tax_amount BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_expense_lines ON expense_lines(tenant_id, expense_id);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  storage_key TEXT NOT NULL,
  sha256 TEXT,
  uploaded_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments(tenant_id, entity_type, entity_id);

-- --------------------------------------------------------------- banking ---
CREATE TABLE IF NOT EXISTS bank_accounts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  account_id TEXT NOT NULL,
  bank_name TEXT,
  mask TEXT,
  currency TEXT NOT NULL,
  opening_balance BIGINT NOT NULL DEFAULT 0,
  current_balance BIGINT NOT NULL DEFAULT 0,
  provider TEXT NOT NULL DEFAULT 'manual',          -- manual|csv|plaid|saltedge
  provider_ref TEXT,
  last_import_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bank_accounts_tenant ON bank_accounts(tenant_id);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  bank_account_id TEXT NOT NULL,
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  payee TEXT,
  amount BIGINT NOT NULL,                           -- signed: + money in, - money out
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unmatched',         -- unmatched|matched|excluded|reconciled
  match_type TEXT,                                  -- payment|journal|invoice|rule|manual
  matched_entity_id TEXT,
  journal_entry_id TEXT,
  import_batch TEXT,
  external_id TEXT,
  memo TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, bank_account_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_bank_tx ON bank_transactions(tenant_id, bank_account_id, status, date);

CREATE TABLE IF NOT EXISTS bank_rules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  match_field TEXT NOT NULL DEFAULT 'description',  -- description|payee|amount
  match_op TEXT NOT NULL DEFAULT 'contains',        -- contains|equals|starts_with
  match_value TEXT NOT NULL,
  tx_direction TEXT NOT NULL DEFAULT 'any',         -- any|credit|debit
  amount_min BIGINT,
  amount_max BIGINT,
  target_type TEXT NOT NULL DEFAULT 'journal',      -- journal|exclude
  target_account_id TEXT,
  auto_apply INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bank_rules_tenant ON bank_rules(tenant_id, is_active, priority);

CREATE TABLE IF NOT EXISTS reconciliations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  bank_account_id TEXT NOT NULL,
  start_date TEXT,
  end_date TEXT NOT NULL,
  statement_ending_balance BIGINT NOT NULL DEFAULT 0,
  beginning_balance BIGINT NOT NULL DEFAULT 0,
  cleared_balance BIGINT NOT NULL DEFAULT 0,
  difference BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',              -- open|completed
  completed_at TEXT,
  completed_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recon_tenant ON reconciliations(tenant_id, bank_account_id, status);

CREATE TABLE IF NOT EXISTS reconciliation_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  reconciliation_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  cleared_amount BIGINT NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (reconciliation_id, transaction_id)
);

-- ------------------------------------------------------------- inventory ---
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  item_type TEXT NOT NULL DEFAULT 'inventory',      -- inventory|service|non_inventory
  sales_price BIGINT NOT NULL DEFAULT 0,
  purchase_cost BIGINT NOT NULL DEFAULT 0,
  income_account_id TEXT,
  expense_account_id TEXT,
  inventory_asset_account_id TEXT,
  tax_code_id TEXT,
  quantity_on_hand REAL NOT NULL DEFAULT 0,
  reorder_point REAL NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, sku)
);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  date TEXT NOT NULL,
  movement_type TEXT NOT NULL,                      -- purchase|sale|adjustment|opening
  quantity REAL NOT NULL,
  unit_cost BIGINT NOT NULL DEFAULT 0,
  total_cost BIGINT NOT NULL DEFAULT 0,
  reference_type TEXT,
  reference_id TEXT,
  journal_entry_id TEXT,
  memo TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inv_mov ON inventory_movements(tenant_id, item_id, date);

-- --------------------------------------------------------------- payroll ---
CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT,
  employee_no TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  pay_type TEXT NOT NULL DEFAULT 'salary',          -- salary|hourly
  pay_rate BIGINT NOT NULL DEFAULT 0,               -- annual cents or hourly cents
  pay_frequency TEXT NOT NULL DEFAULT 'monthly',
  tax_id TEXT,
  hire_date TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  address_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, employee_no)
);

CREATE TABLE IF NOT EXISTS timesheets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  work_date TEXT NOT NULL,
  hours REAL NOT NULL DEFAULT 0,
  project TEXT,
  billable INTEGER NOT NULL DEFAULT 0,
  rate BIGINT NOT NULL DEFAULT 0,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'submitted',         -- draft|submitted|approved|rejected
  approved_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_timesheets ON timesheets(tenant_id, employee_id, work_date);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  pay_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',             -- draft|approved|paid
  gross BIGINT NOT NULL DEFAULT 0,
  tax_total BIGINT NOT NULL DEFAULT 0,
  deductions_total BIGINT NOT NULL DEFAULT 0,
  net_total BIGINT NOT NULL DEFAULT 0,
  journal_entry_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payroll_lines (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  hours REAL NOT NULL DEFAULT 0,
  gross BIGINT NOT NULL DEFAULT 0,
  income_tax BIGINT NOT NULL DEFAULT 0,
  social_tax BIGINT NOT NULL DEFAULT 0,
  medicare BIGINT NOT NULL DEFAULT 0,
  deductions BIGINT NOT NULL DEFAULT 0,
  net BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_payroll_lines ON payroll_lines(tenant_id, run_id);

-- ------------------------------------------- integrations and automation ---
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhooks_tenant ON webhooks(tenant_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  webhook_id TEXT NOT NULL,
  event TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',           -- pending|delivered|failed
  response_code INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS report_schedules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  report_type TEXT NOT NULL,
  name TEXT NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'monthly',
  params_json TEXT,
  recipients TEXT,
  format TEXT NOT NULL DEFAULT 'csv',
  next_run_at TEXT NOT NULL,
  last_run_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,                               -- accounts|customers|vendors|invoices|bills|bank|journal
  filename TEXT,
  mapping_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending',           -- pending|running|completed|failed
  dry_run INTEGER NOT NULL DEFAULT 1,
  total_rows INTEGER NOT NULL DEFAULT 0,
  stats_json TEXT,
  errors_json TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_import_jobs ON import_jobs(tenant_id, status);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  job_type TEXT NOT NULL,
  payload_json TEXT,
  status TEXT NOT NULL DEFAULT 'queued',            -- queued|running|done|failed
  run_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, run_at);

CREATE TABLE IF NOT EXISTS gdpr_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT,
  request_type TEXT NOT NULL,                       -- export|erase|rectify
  status TEXT NOT NULL DEFAULT 'pending',
  result_json TEXT,
  requested_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS counters (
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  ip TEXT,
  success INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(email, created_at);
