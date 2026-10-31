# Administrator guide

Two kinds of administrator exist in LedgerLine:

* **Company administrator** (`admin` membership role) — runs one company's settings,
  users, billing, periods, integrations and data.
* **Platform administrator** (`users.is_platform_admin`) — operates the service: tenant
  list, plan mix and MRR, suspension, support access, platform health and the platform
  audit view.

Most people will only ever be the first. The second is granted by the seed
(`ADMIN_EMAIL`) or by a database change, and is deliberately separate from tenant roles so
that support staff cannot read a customer's ledger without an audited impersonation token.

## Part 1 — Running a company

### 1.1 Invite users and assign roles

**Settings → Users & roles** → *Invite user*. The invitee gets a single-use link
(`/accept-invite?token=…`, 7-day expiry). Choose the role at invite time; you can change it
later from the same screen.

| Role | Typical person | Can |
| --- | --- | --- |
| Administrator | Owner, finance lead | Everything: company settings, users, billing, data export |
| Accountant | External or in-house accountant | Journal entries, chart of accounts, reconciliation, payroll, reports, imports |
| Bookkeeper | Day-to-day clerk | Invoices, bills, payments, expenses, bank reconciliation, inventory |
| Employee | Everyone else | Submit expenses and timesheets |

Rules of thumb: give reporting access through the accountant role (`reports:read` is
included); bookkeepers cannot change the chart of accounts or lock periods; employees
cannot see company-wide figures at all. Removing a member is immediate — their sessions
are revoked on the next request because membership is checked per request.

### 1.2 Company profile, currency and tax

**Settings → Company** holds legal name, address, fiscal-year start, currency, invoice
defaults (terms, footer, numbering prefix) and the training-mode sandbox label.
**Settings → Taxes** manages tax codes (name, rate in basis points, jurisdiction, whether
prices include tax). **Settings → Currencies** adds currencies and exchange rates, with a
converter used by multi-currency documents; rates are stored historically so older
documents keep the rate they were posted with.

### 1.3 Feature flags

**Settings → Features** toggles modules per company: `inventory`, `payroll`,
`multi_currency`, `bank_feeds`, `recurring_invoices`, `expense_ocr`, `timesheets`,
`approvals`, `api_access`. Payroll and approvals are off by default; inventory is on.
A disabled module disappears from navigation and its page shows a "module switched off"
notice, so a company that does not run payroll never sees it — the underlying REST routes stay permission-gated
rather than flag-gated, which keeps integrations working when a flag is toggled.

### 1.4 Periods and month-end close

**Settings → Periods & close** lists fiscal periods. *Generate* creates monthly periods
for the fiscal year; *Publish* marks a month final and blocks new postings dated inside
it; *Reopen* (audited) is the exception path. Recommended routine:

1. Reconcile every bank account to a zero difference.
2. Review A/R and A/P aging; chase anything older than your policy threshold.
3. Post adjusting entries (accruals, depreciation, inventory, payroll accruals).
4. Review the trial balance and P&L against expectations.
5. Publish and lock the period; export the statements to your archive.

### 1.5 Audit trail and security

**Settings → Audit** lists every write with actor, IP and before/after values.
*Verify chain* walks the hash chain and reports the number of verified entries or the
first inconsistency; *Export CSV* produces evidence for an auditor. A broken chain is an
incident — treat it as P1 and follow the runbook in the security document.

**Settings → Security** shows 2FA posture per user, active sessions, and lets you enforce
two-factor for administrators. Sessions can be revoked individually. Rotating a user's
password does not end existing sessions — revoke them explicitly.

### 1.6 Billing

**Settings → Billing** shows the current plan, seat count and price. Plans are Trial (5
seats, free), Starter ($19/mo, 5 seats), Growth ($49/mo, 15 seats), Accounting firm
($129/mo, 100 seats). Changing a plan is audited and updates both `subscriptions` and the tenant
record. Card collection is handled by the payment provider; LedgerLine stores plan state
and provider references only.

Seats are enforced at invite time against the plan limit — upgrading is one click, and
downgrading is refused while the company has more members than the target plan allows.
Trial accounts start with five seats so an owner can add a bookkeeper and an accountant
without paying first.

### 1.7 Integrations

**Settings → Integrations** manages API keys and webhooks.

* API keys are shown once, carry a role (bookkeeper by default), and can be revoked at any
  time; last use is tracked.
* Webhooks subscribe to named events, must use HTTPS in production, and are signed with
  `x-ledgerline-signature` (`HMAC-SHA256(secret, "<timestamp>.<body>")`). Delivery history
  shows response codes, attempts and payloads; failed deliveries retry with backoff and
  stop after six attempts.
* Bank feed connection is configured per bank account (aggregator credentials come from
  the environment). Without an aggregator, use statement import.

### 1.8 Data, privacy and export

* **Import & export** — CSV import for accounts, customers, vendors, items, invoices, bills,
  journals and bank statements; full export as CSV bundle plus JSON. See
  [quickbooks-csv.md](quickbooks-csv.md).
* **Settings → Data & privacy** — GDPR subject export (JSON) and erasure request. Erasure
  anonymises personal data on contacts and users, keeps financial records required by law,
  and records the request with a status you can report back to the data subject.
* **Audit export** — CSV for the auditor, capped at 10 000 rows per call; filter by date in
  the reporting layer if you need more.

### 1.9 Access reviews (quarterly)

1. Export the user list (`GET /users`) and compare against HR/contractor records.
2. Remove leavers and downgrade role changes; confirm no shared logins.
3. Review API keys: revoke anything without an owner; check `last_used_at`.
4. Review platform administrators (`is_platform_admin`) — should be a short list.
5. Run *Verify chain* in Audit, and record the result with the review.
6. Attach the export to the compliance folder.

## Part 2 — Running the platform

Sign in with a platform administrator account and open `/admin`. Tenant administrators
without the platform flag see a friendly explanation instead of data.

### 2.1 Metrics

`/admin` shows total tenants, active/trialing/suspended counts, signups in the last 30
days, MRR (sum of active plan prices), plan mix, and service health (database, worker last
tick, schema version). Metrics are read-only.

### 2.2 Tenants

The tenant table supports search by name or email and filters by status and plan. Each row
opens a detail view with the owner, creation date, plan and seat usage.

* **Suspend** — sets `status = suspended` with a reason; users of that tenant can no longer
  authenticate into it. Use for non-payment or abuse. Every action is audited with the
  operator's identity.
* **Change plan** — see billing above; platform operators can also do this when a
  customer's card fails but you want to extend service.
* **Support access** — issues a 15-minute impersonation token attributable to your account
  in the tenant's audit log. Never share it, never use it without a support ticket
  reference, and prefer asking the customer to reproduce the issue first.

### 2.3 Health and incident response

`GET /admin/health` reports database connectivity, migration state and worker heartbeat.
Alert on: `/api/v1/health` failing for two consecutive probes, 5xx rate above 1 %,
worker heartbeat older than two intervals, audit-chain verification failure, or a queue of
`failed` webhook deliveries.

On-call triage:

1. Confirm the blast radius (one tenant vs all) using `/admin/tenants` and health.
2. Check recent deploys; roll back if the error rate started with a release.
3. For credential-related incidents, revoke sessions/API keys and rotate `JWT_SECRET`.
4. Write the timeline; post-incident review within five business days.

### 2.4 Data handling duties

* Backups: nightly dump + PITR, encrypted, restore tested quarterly.
* Tenant deletion requests: export data (`POST /gdpr/export` as the tenant admin), confirm
  in writing, then remove the tenant and its storage prefix; retain the audit row for the
  deletion itself.
* Do not copy production data into staging. Use the seeded sandbox instead.

### 2.5 What platform administrators cannot do

* Read a tenant's ledger or documents without an audited impersonation token.
* Change a tenant's chart of accounts, journal entries or bank data.
* Bypass the audit trail — every platform action on a tenant writes an entry into that
  tenant's chain *and* the platform audit view.

Those boundaries are what make the support-access model defensible to an auditor: the
capability exists, but it is deliberate, time-boxed and recorded.
