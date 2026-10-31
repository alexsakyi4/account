# Security overview

This document describes what the code actually does. Where a control depends on
deployment choices (TLS, backups, key custody), it says so explicitly instead of
assuming the platform provides it.

## Authentication

| Mechanism | Detail |
| --- | --- |
| Passwords | scrypt (N=16384, r=8, p=1, 64-byte key), per-user 16-byte salt, NFKC normalised, constant-time compare. Never logged. |
| Access tokens | HS256 JWT, 15 minutes, carrying `sub`, `tid`, `role`, `typ: access`. |
| Refresh tokens | Opaque random strings stored hashed in `sessions`; 30 days; **rotate on every use** — replaying a rotated token revokes the session. |
| Sessions | `GET /auth/sessions` lists device/IP/user-agent; `DELETE /auth/sessions/:id` revokes; logout revokes the current one. |
| Two-factor | TOTP (RFC 6238, 30 s, 6 digits) with a ±1 step window; enrolment returns an `otpauth://` URL. `REQUIRE_2FA_FOR_ADMINS=true` blocks admin sessions until enrolment. |
| API keys | `ll_` prefixed, only the SHA-256 hash is stored; shown once on creation; revocable per key; scoped to one tenant and to a role (`bookkeeper` by default). |
| Password reset | Single-use token with expiry, delivered by email relay; token hash stored, not the token. |
| Login throttling | Failed attempts recorded in `login_attempts`; global rate limit 600 req/min per user (per IP before login). |

## Authorisation

The permission catalogue lives in `shared/roles.ts` and is used by the API guards and the
UI. There is exactly one implementation, so an action hidden in the UI is also refused by
the API.

### RBAC matrix

| Permission | Admin | Accountant | Bookkeeper | Employee |
| --- | :-: | :-: | :-: | :-: |
| `company:manage` | ✓ | | | |
| `users:manage` | ✓ | | | |
| `billing:manage` | ✓ | | | |
| `data:export` | ✓ | ✓ | | |
| `accounts:write` | ✓ | ✓ | | |
| `journal:write` | ✓ | ✓ | | |
| `invoices:write` | ✓ | ✓ | ✓ | |
| `bills:write` | ✓ | ✓ | ✓ | |
| `payments:write` | ✓ | ✓ | ✓ | |
| `banking:write` | ✓ | ✓ | ✓ | |
| `reports:read` | ✓ | ✓ | ✓ | |
| `payroll:manage` | ✓ | ✓ | | |
| `timesheets:approve` | ✓ | ✓ | | |
| `inventory:manage` | ✓ | ✓ | ✓ | |
| `import:write` | ✓ | ✓ | ✓ | |
| `audit:read` | ✓ | ✓ | | |
| `integrations:manage` | ✓ | ✓ | | |
| `expenses:submit` | ✓ | ✓ | ✓ | ✓ |
| `timesheets:submit` | ✓ | ✓ | ✓ | ✓ |

Platform administration is a separate `is_platform_admin` flag: it unlocks `/admin/*`
but confers no permission inside a customer's ledger. Support access uses
`POST /admin/tenants/:id/impersonate`, which issues a 15-minute token and writes an audit
entry naming the operator.

Role changes, membership removal, 2FA toggles, API key creation and webhook changes are
all audited with actor, IP and user agent.

### Tenant isolation

Tenant identity comes from the authenticated membership, never from the request body.
Where a user has several memberships, `X-Tenant-Id` selects one and is validated against
`memberships`. Lookups are filtered by `tenant_id` and return 404 (not 403) when a record
belongs to another tenant. `tests/integration/security.test.ts` asserts this for invoices,
contacts, reports and attachments.

## Transport and headers

* TLS 1.2+ at the ingress (`deploy/nginx/ledgerline.conf`) with HSTS preload, HTTP→HTTPS.
* Helmet in production: CSP `default-src 'self'`, `object-src 'none'`,
  `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`.
* CORS restricted to an explicit allowlist; `*` is a startup error in production.
* Cookies are not used for API auth (Bearer header only), so the app is not exposed to
  CSRF on state-changing routes.
* Request ids are returned on every response and in error bodies for correlation.

## Data protection

| Data | Protection |
| --- | --- |
| Passwords | scrypt hash, per-user salt |
| Refresh tokens, API keys, reset tokens | SHA-256 hash at rest, single display at creation |
| TOTP secrets | AES-256-GCM with `ENCRYPTION_KEY` |
| Webhook signing secrets | Random 24-byte secret, shown once, stored in `webhooks.secret` — protect the database/volume with storage-level encryption |
| Ledger and documents | Encrypted at rest via the database/volume encryption you configure (LUKS/EBS/RDS) — the app does not double-encrypt rows |
| Receipts/uploads | Stored outside the web root; served only through `GET /attachments/:id` after tenant + auth checks; MIME type recorded; size capped |
| Logs | No passwords, tokens, card data or full request bodies |

PCI DSS: card data never transits this server. Checkout is a hosted provider session; the
application stores only provider references and the trailing four digits. This keeps the
merchant in SAQ A scope.

GDPR: `POST /gdpr/export` produces a machine-readable export of the subject's data;
`POST /gdpr/erase` anonymises personal fields while preserving legally required financial
records and the audit chain; every request is recorded in `gdpr_requests` with status.

## Audit trail

`audit_logs` stores one row per write with tenant, actor (user id, email, role), action,
entity type/id, before/after JSON, IP, user agent and timestamp. Each row embeds
`prev_hash` and `hash = sha256(prev_hash + canonical(entry))`, so deleting or editing an
entry breaks the chain. `GET /audit/verify` walks the chain and reports the first
inconsistency; `GET /audit/export` returns CSV for auditors. The log is append-only in
application code — grant the runtime database role INSERT/SELECT only (no UPDATE/DELETE)
on `audit_logs` in production.

## Input handling and OWASP Top 10 mapping

| Risk | Control |
| --- | --- |
| A01 Broken access control | Single RBAC source, permission check on every mutating route, tenant-scoped queries, 404 for cross-tenant reads |
| A02 Cryptographic failures | scrypt, HS256 with ≥32-byte secret, AES-256-GCM, hashed tokens, HSTS, TLS 1.2+ |
| A03 Injection | Parameterised SQL everywhere (`?` placeholders via the driver); no string-built SQL from user input; Zod validation of bodies/params/query |
| A04 Insecure design | Locked fiscal periods, balanced-entry enforcement, immutable audit chain, sandbox/demo separation |
| A05 Security misconfiguration | Production config validation (secrets, CORS, https), helmet defaults, no directory listing, container runs non-root with read-only rootfs and dropped capabilities |
| A06 Vulnerable components | `npm audit --audit-level=high` in CI, dependency review on PRs, CodeQL, minimal dependency surface (Node crypto only — no bcrypt/jwt libs) |
| A07 Identification/authentication failures | Throttled logins, rotating refresh tokens, session revocation, TOTP for admins, no user enumeration on reset |
| A08 Integrity failures | Hash-chained audit log, signed webhooks, image digests, reproducible builds in CI |
| A09 Logging/monitoring failures | Structured request logs with ids, audit trail, `/api/v1/health`, admin health view, webhook delivery failures tracked |
| A10 SSRF | Outbound HTTP is limited to configured webhook URLs and provider endpoints; no user-supplied URL is fetched server-side except webhook test targets, which require `integrations:manage` |

Uploads are validated by MIME type and size (`MAX_UPLOAD_BYTES`, 10 MiB default) and
stored with generated names; the original filename is sanitised to `[A-Za-z0-9._-]`.

## Operational security

* Rotate `JWT_SECRET` to invalidate every session; rotate `ENCRYPTION_KEY` only together
  with re-encrypting the TOTP secrets it protects.
* Least privilege database role: no DDL at runtime, no UPDATE/DELETE on `audit_logs`.
* Backups encrypted with a KMS-managed key; restore tested quarterly.
* Dependency updates monthly, emergency patch within 72 h for critical advisories.
* Access reviews quarterly; joiners/movers/leavers reflected in `memberships` the same day.
* Incident response: detect (alerts on 5xx rate, auth failure spikes, audit-verify
  failures) → contain (revoke sessions/keys, rotate secrets) → eradicate → recover →
  post-incident review within five business days.

## Reporting a vulnerability

Email the maintainers with reproduction steps and impact. Do not open a public issue for
security reports. We aim to acknowledge within two business days and to fix critical
issues within 72 hours.
