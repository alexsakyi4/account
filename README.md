# LedgerLine

LedgerLine is a multi-tenant, double-entry accounting platform for small and mid-sized
businesses. It covers the full day-to-day cycle — quotes and invoices through to cash,
vendor bills through to payment, bank feeds and reconciliation, month-end close and
financial reporting — with role-based access control, an immutable audit trail, and a
REST API plus webhooks for integration work.

Everything in this repository is original code and original design. LedgerLine offers
**functional parity and CSV interoperability** with mainstream small-business accounting
tools; it contains no third-party trademarks, logos, UI assets or proprietary code.

```
web (React 19 + Vite + Tailwind)  ──HTTP──►  Fastify 5 API  ──►  SQLite (dev) / PostgreSQL (prod)
        ▲                                        │
        └────────── static bundle served by the API in production ◄┘
```

## Contents

| Area | Where |
| --- | --- |
| API (Fastify, 15 modules, 183 documented operations) | `server/src/` |
| Web app (React 19, TypeScript, Tailwind 4) | `web/src/` |
| Shared roles, permissions and money helpers | `shared/` |
| Schema (51 tables) and migration runner | `db/migrations/`, `server/src/db/` |
| OpenAPI 3.1 specification | `docs/openapi.json` |
| Unit, integration and browser tests | `tests/` |
| Docker, Kubernetes, nginx, CI | `Dockerfile`, `docker-compose.yml`, `deploy/`, `.github/workflows/` |
| Documentation | `docs/` |

Start with [docs/user-guide.md](docs/user-guide.md) if you want to use the product,
[docs/admin-guide.md](docs/admin-guide.md) if you run it for a company, and
[docs/deployment.md](docs/deployment.md) if you are putting it on a server.

## Quick start

Requirements: Node.js 22+ (npm 10+). No external database, cache or paid service is
needed for local development.

```bash
npm install
cp .env.example .env          # optional; safe defaults work out of the box
npm run setup                 # create the SQLite schema and load the demo sandbox
npm run dev                   # API on :4000, web on :5173
```

Open <http://localhost:5173> and sign in with the seeded demo company:

| Email | Password | What it is |
| --- | --- | --- |
| `demo@ledgerline.app` | `DemoPass123!` | Administrator of “Lakeside Trading Co.”, a training sandbox containing invoices, bills, bank transactions and an open reconciliation |
| `admin@ledgerline.app` | `ChangeMe123!` | Platform administrator: tenant console, billing plans, support access |

Registering a new company gives you a clean ledger, a 7-step onboarding checklist, and
an industry chart-of-accounts template. Change both seeded passwords before exposing an
instance to a network — production mode refuses to start with weak secrets, but the seed
credentials themselves are only as safe as your environment.

### Useful scripts

```bash
npm run dev            # API + web with reload
npm run dev:api        # API only (tsx watch)
npm run dev:web        # Vite only
npm run typecheck      # API, shared, tests, web (project references)
npm run typecheck:web  # web app only
npm test               # Vitest: unit + integration
npm run test:e2e       # Playwright (needs `npx playwright install --with-deps chromium`)
npm run build          # esbuild API bundle + Vite web bundle
npm start              # run the built server (also serves web/dist)
npm run db:migrate     # apply pending SQL migrations
npm run db:seed        # idempotent demo seed
npm run openapi        # regenerate docs/openapi.json from the live route table
```

`npm run lint` is an alias of the typecheck: the project treats `tsc --noEmit` in strict
mode as the linter, so there is no separate ESLint configuration to keep in sync.

## What is implemented

**Ledger core** — hierarchical chart of accounts with seven industry templates, balanced
journal entries, fiscal periods with lock/publish, trial balance, and automatic postings
for every business document. Money is stored as integer minor units end to end; rounding
is half away from zero, never float arithmetic.

**Accounts receivable** — invoices, estimates, credit memos, recurring schedules,
reminder emails, partial payments, custom document templates, and a public payment link
per invoice (`/pay/:token`). Statements per customer.

**Accounts payable** — vendor bills with line-level accounts and tax, payment scheduling
runs, expense claims with receipt upload and OCR-assisted amount extraction.

**Banking** — accounts, statement CSV import with column mapping, auto-match rules
(amount, date window, description pattern, contact), a reconciliation workspace with
bulk actions and a live difference figure, and bank feed webhook ingestion.

**Reporting** — profit & loss, balance sheet, cash flow, trial balance, A/R and A/P
aging, general ledger, sales by customer, purchases by vendor, tax summary; CSV export,
scheduled email delivery, and a dashboard with cash, receivables, payables and trend.

**Payments** — receipts and disbursements with applications against invoices/bills,
provider checkout through Stripe when configured, offline methods, fees and voids.
Card data never reaches this server, which keeps PCI DSS scope to SAQ A.

**Optional modules behind feature flags** — inventory (items, SKUs, weighted-average
COGS, adjustments, valuation), payroll (employees, runs, payslips), timesheets, approvals.

**Platform** — four roles enforced in one place (`shared/roles.ts`) on the API and reused
in the UI, hash-chained audit log with verification and CSV export, tenant
administration console, plan mix and MRR reporting, support impersonation with a
15-minute token, GDPR export/erasure requests, API keys, signed webhooks, onboarding
checklist and a training sandbox.

## Roles at a glance

| Role | Can do |
| --- | --- |
| Administrator | Everything, plus company settings, users, billing, data export, integrations |
| Accountant | Full ledger: journal entries, chart of accounts, reconciliation, reports, imports |
| Bookkeeper | Invoices, bills, payments, expenses, bank reconciliation, inventory |
| Employee | Submit expenses and timesheets only |

Detailed permission matrix: [docs/security.md](docs/security.md#rbac-matrix).

## Testing

```bash
npm test                                   # 14 files, 91 tests
npx playwright install --with-deps chromium   # needs egress to the Playwright CDN
npm run dev                                # in another shell: API + web
E2E_NO_SERVER=1 E2E_BASE_URL=http://localhost:5173 npx playwright test --reporter=list
```

Without `E2E_NO_SERVER`, Playwright starts `npm run dev` itself. Specs live in
`tests/e2e/`: the sign-in flow and keyboard shortcuts, the invoice → payment → bill →
statement import → reconciliation journey, a rejected unbalanced journal entry, invoice
voiding, and accessibility/responsive checks.

Coverage highlights: money rounding and tax maths, CSV parsing/quoting, OCR extraction,
journal balance invariants, tenant isolation (cross-tenant reads return 404), RBAC
denials, TOTP enrolment, closed-period posting, refresh-token rotation, import
preview/execute for every supported kind, worker jobs (recurring invoices, reminders,
report schedules, webhook delivery), and browser journeys from invoice to cash to bill
payment to reconciliation.

## API

The REST API is versioned under `/api/v1`, documented in OpenAPI 3.1
([docs/openapi.json](docs/openapi.json)) and summarised in [docs/api.md](docs/api.md).
Every request is scoped to a tenant by the membership carried in the JWT and, where a
user belongs to several companies, the `X-Tenant-Id` header. Outbound webhooks are
queued in a transactional outbox, retried with backoff, and HMAC-SHA256 signed.

## Security posture

TLS termination and HSTS at the edge, strict CSP and helmet headers, scrypt password
hashing, short-lived access tokens with rotating refresh sessions, TOTP two-factor for
administrators, AES-256-GCM encryption for TOTP secrets at rest, per-user and
per-IP rate limiting, upload size/type limits, no cross-tenant query paths, hash-chained
audit trail, and documented incident-response and access-review procedures.
See [docs/security.md](docs/security.md) and the SOC 2 control matrix in
[docs/soc2-controls.md](docs/soc2-controls.md).

## Deployment

`Dockerfile` builds one image that serves the API and the compiled web app;
`docker-compose.yml` runs it with PostgreSQL; `deploy/k8s/` contains namespace,
deployment, worker, service, ingress, HPA, PDB and network-policy manifests;
`deploy/nginx/` contains a TLS reverse-proxy profile. CI typechecks, runs the test
suites, builds the bundles, verifies the OpenAPI file is current, builds the image, and
runs `npm audit` + CodeQL + secret scanning.

Step-by-step: [docs/deployment.md](docs/deployment.md).

## Project conventions

- Money: integer minor units in the database and API (`amount: 125000` = 1250.00).
- Timestamps: ISO-8601 UTC strings; accounting dates are `YYYY-MM-DD`.
- Lists: `{ data: [...], pagination: { page, pageSize, total, totalPages, hasMore } }`.
- Singles: wrapped by name, e.g. `{ invoice, lines }`, `{ bill, lines }`.
- Errors: `{ error: { code, message, details? }, requestId }` with 4xx/5xx status.
- The SQL dialect is selected by `DATABASE_URL`; queries are written for both SQLite and
  PostgreSQL through a tiny driver abstraction (`server/src/db/driver.ts`).

## Licence

Proprietary — all rights reserved by the repository owner. Third-party dependencies keep
their own licences; run `npm ls --all` for the current tree.
