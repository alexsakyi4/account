# Architecture

## Shape of the system

LedgerLine is a single TypeScript codebase with three deployable pieces:

```
┌──────────────┐      ┌──────────────────────────┐      ┌───────────────────┐
│  Browser SPA │─────►│  Fastify API (stateless) │─────►│  PostgreSQL       │
│ React 19     │ HTTP │  15 feature modules      │ SQL  │  51 tables        │
└──────────────┘      │  services: ledger, PDF,  │      └───────────────────┘
                      │  OCR, audit, email, S3   │      ┌───────────────────┐
                      └───────────┬──────────────┘─────►│  Object storage   │
                                  │                    └───────────────────┘
                      ┌───────────▼──────────────┐
                      │  Worker (same image)     │
                      │  webhooks · recurring    │
                      │  reminders · schedules   │
                      └──────────────────────────┘
```

* **Stateless API.** No request state is kept in memory, so replicas can be added or
  removed freely behind a load balancer. Sessions live in the database, uploads in the
  storage service, and the only local directory is `UPLOAD_DIR` (mount it on shared
  storage, or set `STORAGE_DRIVER=s3`).
* **Worker.** `startWorker()` runs inside the API process for single-container
  deployments, or as its own Deployment with `WORKER_MODE=standalone` in Kubernetes.
  Jobs are claimed from the `jobs` table, so several workers can run concurrently.
* **One image, two roles.** `npm run build` produces `dist/server.js` (bundled with
  esbuild, dependencies external) and `web/dist`. In production the API serves the SPA
  with a history fallback and long-lived caching for hashed assets.

## Directory layout

```
server/src/
  app.ts                 Fastify factory: helmet, CORS, rate limits, multipart, /**
  index.ts               Boot: validate config → migrate → optional seed → listen → worker
  config.ts              Environment parsing + production guardrails
  db/                    Driver abstraction, migration runner, demo seed
  modules/               HTTP surface, one file per bounded context
  services/              Domain logic reused by modules and the worker
  domain/reports.ts      Report definitions and aggregation queries
  lib/                   Crypto, money, CSV, errors, validation, pagination
  jobs/worker.ts         Due-work loop (webhooks, recurring, reminders, schedules)
shared/
  roles.ts               Roles, permissions, labels — the single RBAC source of truth
  money.ts               Minor-unit conversion and currency formatting
web/src/
  lib/                   Typed fetch client, session context, formatters, queries
  components/            Design system, app shell, document composer
  pages/                 One component per route, lazy-loaded
db/migrations/           Ordered, immutable SQL migrations
tests/                   unit/ integration/ e2e/
```

## Request lifecycle

1. `onRequest` assigns a request id and evaluates the rate-limit bucket (user id when
   authenticated, IP otherwise).
2. `preHandler` authenticates an `Authorization: Bearer` access token or `X-Api-Key`.
   It resolves the tenant from the token, or from `X-Tenant-Id` when the user belongs to
   more than one company, and rejects mismatched memberships with 403.
3. The route handler validates the body with Zod, checks the permission with
   `requirePermission(role, 'invoices:write')`, and calls a service function.
4. Services write domain rows and the matching journal entry inside a transaction-like
   sequence, then append an audit record (`before`/`after`, actor, IP, user agent) and
   enqueue any webhook deliveries.
5. Errors are normalised to `{ error: { code, message, details }, requestId }`; 5xx
   responses never include stack traces or SQL.

## Posting model

Double-entry with a single source of truth: `journal_entries` + `journal_lines`, where
debits and credits are stored as positive minor units and the entry carries
`total_debit = total_credit`. Business documents (`invoices`, `bills`, `payments`,
`expenses`, payroll runs, inventory adjustments) link to the entry they produced.

| Event | Debit | Credit |
| --- | --- | --- |
| Invoice issued | Accounts receivable | Income (+ tax payable) |
| Payment received | Bank / undeposited funds | Accounts receivable |
| Bill entered | Expense / inventory | Accounts payable |
| Bill paid | Accounts payable | Bank |
| Credit memo | Income (−) / tax payable (−) | Accounts receivable |
| Inventory sale | Cost of goods sold | Inventory |
| Payroll run | Salaries expense | Payroll liabilities |

Postings are refused when the fiscal period containing the entry date is closed, when
debits and credits differ, or when a referenced account belongs to another tenant.

## Multi-tenancy

Every table that holds company data carries `tenant_id`. Queries are always filtered by
the tenant resolved from the authenticated membership; there is no query path that takes
a tenant id from the request body. Cross-tenant access returns 404 rather than 403 so
the existence of another company's records is not disclosed. The audit log, onboarding
progress, feature flags, sessions, API keys and webhooks are all tenant-scoped.

Platform-level administration (`is_platform_admin`) is a separate flag on the user, not a
membership role: it only unlocks `/admin/*`, and support access to a tenant is a
time-boxed, audited impersonation token.

## Money and rounding

All monetary columns are integers in the smallest currency unit. `shared/money.ts`
provides `toMinor` (half away from zero, so `-10.005 → -1001`), `fromMinor`,
`minorToInput` and `formatMoney`. Tax is computed per line from basis points, rounded
once per line, and the document total is the sum of rounded lines — the same rule used
by the reports, which keeps the ledger and the document footers in agreement.

## Extending it

* **A new endpoint** — add a route to the relevant module, a Zod schema, a permission
  check, and a service function; then run `npm run openapi` to refresh the spec.
* **A new report** — add a definition to `server/src/domain/reports.ts`; the web report
  page picks it up from `/reports/definitions`, including CSV/PDF export and scheduling.
* **A new optional module** — add a key to `FEATURE_FLAGS` (server) and a `Flagged`
  route in `web/src/App.tsx`. Flags default per tenant and are editable in Settings.
* **A new role or permission** — edit `shared/roles.ts` only; the API and the UI both
  read from it.

## Known limits

* Bank feeds ship as statement import plus a signed webhook ingestion endpoint rather
  than a live aggregator integration; Plaid credentials are read but the link flow is
  provider-side work.
* Email is delivered through an HTTP relay (`SMTP_URL`) and otherwise captured in the
  database for inspection; no vendor-specific SDK is bundled.
* Payroll covers gross-to-net with configurable progressive bands, statutory lines and
  payslip PDFs; it is not a filing engine for any jurisdiction.
* PDF rendering uses PDFKit with an embedded Helvetica family — non-Latin document text
  needs a custom font file (see `server/src/services/pdf.ts`).
