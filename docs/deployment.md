# Deployment guide

## 1. Configuration

All configuration is environment variables read once at boot (`server/src/config.ts`).
Copy `.env.example` and set at minimum:

| Variable | Required in production | Notes |
| --- | --- | --- |
| `NODE_ENV` | yes | `production` enables secure cookies/headers, strict CSP, config validation, `require2faForAdmins` default |
| `DATABASE_URL` | yes | `postgres://user:pass@host:5432/ledgerline?sslmode=require`; `sqlite:/path/file.db` for single-node installs |
| `JWT_SECRET` | yes | ≥ 32 chars — `openssl rand -hex 32`; rotating it invalidates all sessions |
| `ENCRYPTION_KEY` | yes | ≥ 32 chars — encrypts provider secrets (AES-256-GCM); rotating it requires re-entering those secrets |
| `APP_URL` | yes | Must be `https://…`; used in emails, payment links and CORS defaults |
| `CORS_ORIGINS` | yes | Comma-separated allowlist. `*` is rejected in production |
| `UPLOAD_DIR` | recommended | Persistent volume for receipts; `/data/uploads` in the image |
| `REQUIRE_2FA_FOR_ADMINS` | recommended | Defaults to `true` when `NODE_ENV=production` |
| `SEED_DEMO` | no | `true` loads the demo sandbox; leave `false` in production |
| `ACCESS_TOKEN_TTL` / `REFRESH_TOKEN_TTL` | no | Seconds; defaults 900 / 2 592 000 |
| `MAX_UPLOAD_BYTES` | no | Default 10 MiB |
| `JOBS_INTERVAL_MS` | no | Worker tick, default 15 000 |
| `WORKER_MODE` | no | `off` disables the in-process worker, `standalone` is used by the worker Deployment |
| `LOG_LEVEL` | no | `info` by default |

Optional integrations: `STRIPE_SECRET_KEY`, `PAYMENT_WEBHOOK_SECRET`, `PLAID_CLIENT_ID`,
`PLAID_SECRET`, `SMTP_URL` (HTTP relay for transactional email), `OCR_PROVIDER`
(`local` text extraction, or `http` + `OCR_ENDPOINT` + `OCR_API_KEY` for images).

The process **refuses to start** when a production requirement is missing, rather than
silently falling back to a development secret.

## 2. Database

Migrations run automatically on boot (ordered files in `db/migrations/`, recorded in
`schema_migrations`). To run them out of band:

```bash
DATABASE_URL=postgres://… npm run db:migrate
```

For PostgreSQL, create the database and a least-privilege role first:

```sql
CREATE ROLE ledgerline LOGIN PASSWORD '…';
CREATE DATABASE ledgerline OWNER ledgerline;
```

Backups: nightly logical dump plus WAL archiving. Restore is exercised quarterly; see
the restore test step in [soc2-controls.md](soc2-controls.md#availability).

SQLite remains supported for single-container installs and evaluations. It is not
suitable for multiple API replicas — use PostgreSQL for anything horizontally scaled.

## 3. Docker Compose (single host)

```bash
export JWT_SECRET=$(openssl rand -hex 32)
export ENCRYPTION_KEY=$(openssl rand -hex 32)
export POSTGRES_PASSWORD=$(openssl rand -hex 24)
docker compose up --build -d
docker compose logs -f app
```

The stack starts PostgreSQL 16, Redis 7 (reserved for future queue work) and the app on
port 4000. Data lives in named volumes `pgdata`, `appdata`. The container health check
probes `/api/v1/health`.

## 4. Kubernetes

`deploy/k8s/` contains:

| File | Purpose |
| --- | --- |
| `namespace.yaml` | `ledgerline` namespace with restricted pod-security labels |
| `configmap.yaml` / `secret.yaml` | Non-secret config; secret template (create the real one out of band) |
| `deployment.yaml` | 3 API replicas, non-root, read-only root filesystem, probes, resource limits |
| `worker-deployment.yaml` | Background worker with `WORKER_MODE=standalone` |
| `service.yaml` / `ingress.yaml` | ClusterIP service and TLS ingress (cert-manager) |
| `hpa.yaml` / `pdb.yaml` | CPU-based autoscaling 3→12 and a disruption budget of 2 |
| `networkpolicy.yaml` | Default-deny with explicit ingress from the ingress controller, egress to 5432/443/53 |
| `pvc.yaml` | 20 GiB volume for uploads |

```bash
kubectl apply -f deploy/k8s/namespace.yaml
kubectl -n ledgerline create secret generic ledgerline-secrets \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)" \
  --from-literal=ENCRYPTION_KEY="$(openssl rand -hex 32)"
kubectl apply -f deploy/k8s/
kubectl -n ledgerline rollout status deployment/ledgerline
```

Notes:
* The manifests reference `ghcr.io/ledgerline/app:1.0.0`; retag to your registry or set
  the image in your overlay. CI publishes `ghcr.io/<owner>/<repo>:<sha>`.
* `readOnlyRootFilesystem: true` means uploads must go to the mounted volume (already
  `/data`) and `TMPDIR` must stay writable — the base image's `/tmp` is an emptyDir in
  clusters that enforce read-only root; add one if you mount it explicitly.
* Rolling updates start a new pod, wait for readiness, then terminate the old one
  (`maxUnavailable: 0`). In-flight requests drain for the default termination grace
  period; the app closes the server on SIGTERM.
* The worker Deployment runs the same image with `WORKER_MODE=standalone`. Exactly one or
  more replicas are safe: jobs are claimed per row, so duplicates are avoided.

## 4b. Vercel (serverless)

The same codebase runs on Vercel as a static SPA plus one Node function. SQLite and the
local uploads directory are not available there, so the deployment needs a PostgreSQL
database (Supabase, Neon, RDS…) and object storage for receipts.

```
Browser ──► Vercel CDN (web/dist)          api/index.js (Node 22/26 function)
                    │                              │
                    └──── /api/v1/* ───────────────┤
                                                   └──► PostgreSQL (pooler)
```

What the repository already provides:

| File | Purpose |
| --- | --- |
| `api/index.js` | The deployed function (built from `serverless/entry.ts` by `npm run build:vercel`) |
| `serverless/entry.ts` | Fastify handler for Node functions: builds the app once per warm instance |
| `server/src/db/bootstrap.ts` | Applies pending migrations (from disk or the build-time bundle) and seeds the sandbox when `SEED_DEMO=true` and the database is empty |
| `vercel.json` | Build command, output directory, rewrites, security headers, cron |
| `scripts/build-vercel.mjs` | Vite build + migration inlining + function bundling |

Setup:

1. **Database** — create a Postgres project. Use the **connection pooler** string
   (port 6543, user `postgres.<project-ref>`) because Vercel functions have no IPv4 route
   to the direct database host. Add `?sslmode=require`.
2. **Environment variables** (Production and Preview):

   | Key | Value |
   | --- | --- |
   | `DATABASE_URL` | `postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres?sslmode=require` |
   | `JWT_SECRET` / `ENCRYPTION_KEY` | 32+ random characters each (`openssl rand -hex 32`) |
   | `APP_URL` | `https://<project>.vercel.app` |
   | `CORS_ORIGINS` | same origin as `APP_URL` |
   | `NODE_ENV` | `production` |
   | `SEED_DEMO` | `true` for a demo instance, otherwise `false` |
   | `CRON_SECRET` | random string; authorises the scheduler route |
   | `PG_POOL_MAX` | `5` (each instance keeps a small pool) |
   | `REQUIRE_2FA_FOR_ADMINS` | `true` in real production, `false` for demos |

3. **Deploy** the branch (Vercel builds `npm run build:vercel`, serves `web/dist`, and
   routes `/api/*` to the function). The first request after a cold start applies the
   schema and, when the database is empty, seeds the demo company — expect that first
   request to take a few seconds.
4. **Scheduler** — there is no long-lived worker. `vercel.json` declares a daily cron that
   calls `/api/v1/cron/jobs`; on paid plans change the schedule to every few minutes.
   The route requires `Authorization: Bearer $CRON_SECRET` (Vercel Cron sends it
   automatically) and runs webhook delivery, recurring invoices, reminders and scheduled
   reports.

Constraints to plan around:

* **No persistent disk.** Receipt uploads return `501 storage_unavailable` until
  `STORAGE_DRIVER=s3` is implemented in `server/src/services/storage.ts` (upload to any
  S3-compatible bucket). Everything else — invoices, bills, reports, PDFs (streamed, not
  stored) — works.
* **Cold starts** build the Fastify app and open a pool per instance; the pool is capped
  by `PG_POOL_MAX`. Use the pooler's transaction mode, which the driver's `BEGIN`/`COMMIT`
  transactions support.
* **No background worker inside the request path** — reliability of reminders and
  recurring invoices depends on the cron schedule actually firing.
* **Function size** stays small because dependencies are external and installed from
  `package.json`; `api/index.js` is only the bundled application code.

## 5. TLS and reverse proxy

Terminate TLS at the ingress (recommended) or use `deploy/nginx/ledgerline.conf`:

* HTTP → HTTPS redirect, TLS 1.2/1.3 only, modern cipher list.
* HSTS (2 years, includeSubDomains, preload), `X-Content-Type-Options`,
  `X-Frame-Options: DENY`, `Referrer-Policy`.
* Hashed assets under `/assets/` cached for a year; HTML and `/api/` marked `no-store`.
* `client_max_body_size 12m` to match the upload limit.

The app applies helmet itself as well, so a misconfigured proxy cannot silently remove
the CSP/HSTS headers.

## 6. Scaling and performance

* API replicas are stateless; scale on CPU or p95 latency. The dashboard query is a
  handful of indexed aggregates and stays well under the 2-second budget on the seeded
  dataset; verify on your own data with `EXPLAIN ANALYZE` on `journal_lines` and
  `bank_transactions` before launch.
* Add indexes for any tenant with > 1 M journal lines:
  `(tenant_id, account_id, created_at)` and `(tenant_id, date)` are the hot paths.
* Run at least one worker; more workers increase throughput for webhook fan-out.
* Keep `pageSize` defaults modest; accounts allow up to 300 rows per page for tree views.
* Uploads are streamed to disk with a size cap and a single-file limit per request.

## 7. Zero-downtime checklist

1. Migrations must be backwards compatible (add columns/tables, never drop in the same
   release that stops using them).
2. Build and push the image; deploy to staging; run `npm test` and the Playwright suite.
3. Roll out the API (`maxUnavailable: 0`), then the worker.
4. Smoke test: `GET /api/v1/health`, sign in, open the dashboard, create a draft invoice,
   run `/reports/trial-balance`.
5. Watch error rate and p95 for 15 minutes; roll back with `kubectl rollout undo` if the
   error budget is breached.

## 8. Operations runbook

| Symptom | First checks |
| --- | --- |
| 503 from the load balancer | pod readiness (`/api/v1/health`), database reachability, `schema_migrations` row count |
| Slow dashboard | slow-query log, missing indexes, worker competing for IO, tenant with a very large journal |
| Webhooks stuck `pending` | worker running (`WORKER_MODE`), outbound egress allowed, `webhook_deliveries.next_attempt_at` |
| Emails not sent | `SMTP_URL` unset → messages captured in the `notifications` table by design |
| Login loop / 401s | clock skew (JWT `iat`/`exp`), `JWT_SECRET` changed between replicas, `REQUIRE_2FA_FOR_ADMINS` blocking admin login |
| Uploads failing | `UPLOAD_DIR` permissions, volume full, `MAX_UPLOAD_BYTES` vs proxy limit |
| Reports disagree with documents | a period was locked after posting, or a line used a different tax code — check the invoice's journal entry |

Escalation and evidence-retention steps are in [soc2-controls.md](soc2-controls.md).
