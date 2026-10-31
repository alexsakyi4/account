# API guide

Base URL: `/api/v1` (production behind TLS). Machine-readable contract:
[`openapi.json`](openapi.json) — OpenAPI 3.1.0, 154 paths, 183 operations. Regenerate
with `npm run openapi` whenever routes change; CI fails if the file is stale.

Interactive exploration: import `docs/openapi.json` into Postman, Insomnia, or
<https://editor.swagger.io>.

## Authentication

Two credential types are accepted:

| Type | Header | Use |
| --- | --- | --- |
| Access token (JWT, HS256) | `Authorization: Bearer <token>` | Browser app and user scripts; 15-minute lifetime |
| API key | `X-Api-Key: ll_live_…` | Server-to-server integrations; scoped to a tenant, stored hashed |

```bash
curl -sX POST http://localhost:4000/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"demo@ledgerline.app","password":"DemoPass123!"}'
```

```json
{
  "accessToken": "eyJhbGciOi…",
  "refreshToken": "7f3c…",
  "expiresIn": 900,
  "session": { "user": { "id": "…", "email": "demo@ledgerline.app", "name": "Alex Mensah" },
               "tenant": { "id": "…", "name": "Lakeside Trading Co.", "currency": "USD", "is_sandbox": true },
               "role": "admin", "permissions": ["company:manage", "…"] }
}
```

* Refresh tokens rotate: `POST /auth/refresh` returns a new pair and revokes the old one.
  Reuse of a rotated token invalidates the family.
* `POST /auth/logout` revokes the current session; `GET /auth/sessions` lists active
  sessions and `DELETE /auth/sessions/:id` revokes one.
* Administrators can enrol TOTP with `POST /auth/2fa/setup` and confirm with
  `POST /auth/2fa/verify`; when `REQUIRE_2FA_FOR_ADMINS=true` a login without 2FA
  returns `twoFactorRequired: true` and the session is withheld.

## Tenancy

The token carries the tenant. A user who belongs to several companies passes
`X-Tenant-Id: <uuid>` to select one; the header must match an active membership or the
request fails with 403. `GET /auth/session` returns the memberships available.

## Conventions

* **Money** — integer minor units (`1250` = 12.50). No floats, no strings of digits.
* **Dates** — `YYYY-MM-DD` for accounting dates, ISO-8601 UTC for timestamps.
* **Lists** — `{ "data": [ … ], "pagination": { "page": 1, "pageSize": 25, "total": 132, "totalPages": 6, "hasMore": true } }`
  Query params: `page`, `pageSize` (max 300 for accounts, 100 elsewhere), `q`, `status`,
  `from`, `to`, `sort`.
* **Singles** — wrapped by resource: `{ "invoice": {…}, "lines": […] }`.
* **Errors** — `{ "error": { "code": "forbidden", "message": "…", "details": {…} }, "requestId": "req-…" }`.
  Codes: `bad_request`, `unauthorized`, `forbidden`, `not_found`, `conflict`,
  `validation_failed`, `rate_limited`, `internal_error`.
* **Rate limits** — 600 requests/minute per user (per IP before login); `429` includes
  `Retry-After`. Health checks are exempt.

## Endpoint map

| Group | Representative routes |
| --- | --- |
| Auth | `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/demo`, `/auth/2fa/*`, `/auth/sessions`, `/auth/accept-invite`, `/auth/switch-tenant` |
| Company | `GET/PATCH /company`, `GET /usage`, `PATCH /flags/:key`, `GET /security/overview`, `GET /users`, `POST /users/invite`, `PATCH /users/:id` |
| Accounts | `GET/POST/PATCH /accounts`, `/accounts/templates`, `POST /accounts/apply-template`, `GET /accounts/system-keys` |
| Journal | `GET/POST /journal-entries`, `POST /journal-entries/:id/{reverse,void}`, `GET /journal-entries/export`, `GET /periods`, `POST /periods/generate`, `POST /periods/:id/publish` |
| Sales | `GET/POST /invoices`, `POST /invoices/:id/{post,send,void,duplicate,convert,remind}`, `GET /invoices/:id/pdf`, `/recurring-invoices`, `/contacts/:id/statement`, `/contacts/:id/portal-link` |
| Purchases | `GET/POST /bills`, `POST /bills/:id/{post,void}`, `GET /bills/:id/pdf`, `POST /bills/pay-scheduled`, `GET/POST /expenses`, `POST /expenses/:id/{approve,reject,post}`, `/expenses/summary` |
| Payments | `GET/POST /payments`, `POST /payments/:id/void`, `/payments/summary`, `/payments/deposit`, `/payments/providers` |
| Banking | `GET/POST /banking/accounts`, `POST /banking/accounts/:id/{import,connect}`, `/banking/auto-match`, `/banking/rules`, `/banking/transactions`, `POST /banking/transactions/:id/match`, `/banking/transactions/bulk`, `GET/POST /banking/reconciliations`, `POST /banking/reconciliations/:id/{clear,complete}` |
| Reports | `GET /reports/definitions`, `GET /reports/:type`, `GET /reports/:type/export`, `GET/POST /reports/schedules`, `GET /reports/dashboard` |
| Inventory | `GET/POST /items`, `POST /items/:id/adjust`, `GET /inventory/valuation`, `/inventory/movements` (stock is received through bills) |
| Payroll | `GET/POST /employees`, `/timesheets`, `POST /timesheets/approve`, `GET/POST /payroll/runs`, `POST /payroll/runs/:id/{approve,pay}`, `GET /payroll/summary` |
| Settings | `GET/POST /tax-codes`, `GET /currencies`, `POST /currencies/rates`, `POST /currencies/convert`, `GET /audit/verify`, `GET /audit/export`, `POST /gdpr/export`, `POST /gdpr/erase`, `GET /gdpr/requests`, `GET /security/overview` |
| Integrations | `GET/POST /api-keys`, `DELETE /api-keys/:id`, `GET/POST /webhooks`, `DELETE /webhooks/:id`, `POST /webhooks/test`, `GET /webhooks/deliveries` |
| Imports | `GET /imports/templates`, `GET /imports/templates/:kind.csv`, `POST /imports/preview`, `POST /imports/execute`, `GET /imports/history` |
| Onboarding | `GET /onboarding`, `POST /onboarding/:step`, `POST /onboarding/reset` |
| Public | `GET /public/invoices/:token`, `POST /public/invoices/:token/checkout`, `POST /webhooks/payments/:provider` |
| Admin (platform) | `GET /admin/metrics`, `/admin/tenants`, `PATCH /admin/tenants/:id`, `POST /admin/tenants/:id/impersonate`, `/admin/plans`, `/admin/audit`, `/admin/health` |

`GET /health` reports database liveness and schema version and is deliberately
unauthenticated and rate-limit exempt.

## Worked example: invoice to cash

```bash
TOKEN=$(curl -sX POST localhost:4000/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"demo@ledgerline.app","password":"DemoPass123!"}' | jq -r .accessToken)
AUTH="authorization: Bearer $TOKEN"

# 1. Find the customer
curl -s "localhost:4000/api/v1/contacts?kind=customer&q=Harborline" -H "$AUTH"

# 2. Create and send an invoice (status: draft → sent posts the journal entry)
curl -sX POST localhost:4000/api/v1/invoices -H "$AUTH" -H 'content-type: application/json' \
  -d '{"contactId":"<customer-id>","issueDate":"2026-10-31","dueDate":"2026-11-30",
       "status":"sent","lines":[{"description":"Consulting","quantity":10,"unitPrice":15000}]}'

# 3. Apply a partial payment
curl -sX POST localhost:4000/api/v1/payments -H "$AUTH" -H 'content-type: application/json' \
  -d '{"direction":"receipt","contactId":"<customer-id>","date":"2026-10-31",
       "amount":50000,"method":"bank_transfer","applications":[{"invoiceId":"<invoice-id>","amount":50000}]}'

# 4. Confirm the ledger moved
curl -s "localhost:4000/api/v1/reports/trial-balance?from=2026-01-01&to=2026-10-31" -H "$AUTH"
```

## Webhooks

Create a subscription with `POST /webhooks {url, events}`. Deliveries are queued and sent
by the worker with retries and exponential backoff; each request carries

```
x-ledgerline-event: invoice.paid
x-ledgerline-signature: t=1767225600,v1=<hex hmac>
```

The signature is `HMAC-SHA256(secret, "<timestamp>.<raw body>")`, hex encoded; compare it
with a constant-time check and reject requests whose timestamp is more than five minutes
old. Retries back off exponentially (15 s, 30 s, 1 min … capped at 1 h) and stop after
six attempts. `POST /webhooks/test` sends a sample event to a URL you supply, and
`GET /webhooks/deliveries` lists attempts with response codes and payloads.

Events: `invoice.created`, `invoice.sent`, `invoice.paid`, `invoice.voided`,
`invoice.reminder`, `payment.received`, `bill.created`, `bill.paid`, `expense.submitted`,
`expense.approved`, `reconciliation.completed`, `period.closed`, `contact.created`,
`journal.posted`, `import.completed`, `report.generated`.

## Payments provider callback

`POST /webhooks/payments/:provider` verifies the provider signature when
`PAYMENT_WEBHOOK_SECRET` is set, then marks the intent settled and applies the payment.
Amounts are re-read from the provider payload, never from client-supplied values.
