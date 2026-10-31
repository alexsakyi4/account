# SOC 2 readiness — control matrix

This is a readiness package, not a certification. It maps the Trust Services Criteria we
can evidence today to the mechanism in this repository and the evidence an auditor would
sample. Owner roles are placeholders — assign named people before an audit window.

Legend: **Implemented** = code/config in this repo · **Process** = organisational step
with a documented cadence · **Config** = must be set in your environment.

## Common criteria (security)

| Ref | Criterion | Control | Type | Evidence | Owner |
| --- | --- | --- | --- | --- | --- |
| CC1.1 | Integrity and ethical values | Code review required on `main`; PR template lists security checks | Process | Git history, review approvals | Eng lead |
| CC1.4 | Competence | Onboarding checklist and role descriptions in `docs/onboarding.md`, `docs/admin-guide.md` | Process | Training records | People ops |
| CC2.1 | Information quality | OpenAPI spec regenerated in CI; schema migrations are immutable files | Implemented | CI log, `git diff docs/openapi.json` | Eng lead |
| CC2.2 | Internal communication | README, runbook, incident process documented | Process | Doc revision history | Eng lead |
| CC3.1 | Risk identification | Threat model in `docs/security.md` (OWASP mapping, tenant isolation) | Process | Annual review record | Security |
| CC4.1 | Monitoring of controls | CI on every PR: typecheck, 91 tests, OpenAPI drift, `npm audit`, CodeQL, gitleaks | Implemented | `.github/workflows/` runs | Eng lead |
| CC4.2 | Evaluation of deficiencies | Failed checks block merge; incidents get a follow-up ticket | Process | PR checks, ticket links | Eng lead |
| CC5.1 | Control selection | RBAC matrix, audit chain, rate limits documented | Implemented | `shared/roles.ts`, `docs/security.md` | Security |
| CC6.1 | Logical access | JWT + refresh rotation, sessions table, per-tenant membership, API keys hashed | Implemented | `server/src/modules/auth.ts`, `sessions` rows | Security |
| CC6.2 | Registration/authorisation | Invite-only membership changes with `users:manage`; role changes audited | Implemented | `audit_logs` actions `user.*` | Eng lead |
| CC6.3 | Least privilege | Four roles, 19 permissions, single source of truth; platform admin separate from tenant roles | Implemented | `shared/roles.ts`, `tests/integration/security.test.ts` | Security |
| CC6.4 | Physical access | Cloud provider responsibility; volume encryption enabled | Config | Provider SOC 2 report | Ops |
| CC6.5 | Disposal | GDPR erasure endpoint anonymises PII; retention schedule below | Implemented + Process | `gdpr_requests` rows | DPO |
| CC6.6 | Boundary protection | Default-deny K8s network policy, ingress-only traffic, rate limiting, upload limits | Implemented + Config | `deploy/k8s/networkpolicy.yaml`, app config | Ops |
| CC6.7 | Transmission | TLS 1.2+/HSTS at ingress, no plaintext endpoints, secure webhook signing | Config | TLS scan, `deploy/nginx` | Ops |
| CC6.8 | Malicious software | Container runs non-root, read-only rootfs, dropped capabilities; dependency scanning | Implemented | Deployment manifests, CI | Ops |
| CC7.1 | Vulnerability detection | `npm audit --audit-level=high`, dependency review, CodeQL (weekly + PR) | Implemented | CI artifacts | Security |
| CC7.2 | Monitoring | Structured logs with request ids, `/health`, admin health & metrics, webhook failure tracking | Implemented | Log samples, `/admin/health` | Ops |
| CC7.3 | Incident evaluation | Runbook triage table in `docs/deployment.md` §8; audit-verify failure is a P1 | Process | Post-incident reports | Eng lead |
| CC7.4 | Incident response | Containment (revoke sessions/keys, rotate secrets) documented; 72 h critical patch target | Process | Incident records | Security |
| CC7.5 | Recovery | Backup + restore procedure, quarterly restore test | Config + Process | Restore test log | Ops |
| CC8.1 | Change management | PR + review + CI gates + rolling deploy with rollback; migrations backward compatible | Process | PR history, deployment logs | Eng lead |
| CC9.1 | Risk mitigation | Vendor review for Postgres/hosting/payment/bank providers | Process | Vendor list + reviews | Ops |
| CC9.2 | Vendor management | PCI scope minimisation via hosted checkout; provider secrets encrypted | Implemented | `services/`, `docs/security.md` | Security |

## Availability

| Ref | Control | Detail | Evidence |
| --- | --- | --- | --- |
| A1.1 | Capacity | HPA 3→12 on 65 % CPU, PDB minAvailable 2, stateless API | `deploy/k8s/hpa.yaml`, `pdb.yaml` |
| A1.2 | Recovery | Nightly logical dump + WAL/PITR; RPO ≤ 15 min, RTO ≤ 4 h targets | Backup config, restore test |
| A1.3 | Testing | Quarterly restore into a scratch environment, documented result | Restore log |
| A1.4 | Health | `/api/v1/health` readiness/liveness probes; container HEALTHCHECK | Manifests, `Dockerfile` |
| A1.5 | Incident handling | Severity matrix, on-call rotation, status page updates | Runbook |

## Confidentiality & privacy

| Ref | Control | Detail | Evidence |
| --- | --- | --- | --- |
| C1.1 | Confidentiality policy | Tenant isolation, RBAC, encryption in transit/at rest | Tests, config |
| C1.2 | Disposal | Erasure endpoint + retention schedule | `gdpr_requests` |
| P1.1 | Privacy notice | Not in repo — publish before launch | Website |
| P2.1 | Consent/notice | Purpose limitation: data used only for accounting functions | DPA |
| P3.1 | Collection limits | Only accounting-necessary fields collected | Schema review |
| P4.1 | Use limitation | No ad-tech or third-party analytics in the app | Dependency review |
| P5.1 | Retention | Ledger 7 years (jurisdiction dependent), audit log 7 years, uploads 7 years, sessions 30 days, login attempts 90 days | Retention job/process |
| P6.1 | Access | `POST /gdpr/export` returns subject data as JSON | Endpoint + test |
| P7.1 | Correction | Admin can correct contact PII; corrections audited with before/after | `audit_logs` |
| P8.1 | Disclosure | Access is tenant-scoped; support access is time-boxed and audited | `/admin/tenants/:id/impersonate` |

## Processing integrity

| Ref | Control | Detail | Evidence |
| --- | --- | --- | --- |
| PI1.1 | Completeness/accuracy | Integer minor units, per-line tax rounding, balanced-entry enforcement | `shared/money.ts`, `tests/unit/*` |
| PI1.2 | Authorisation of processing | Postings only via authorised roles; closed periods reject writes | `requirePermission`, `period.closed` |
| PI1.3 | Timeliness | Worker runs every 15 s: recurring invoices, reminders, report schedules, webhooks | `server/src/jobs/worker.ts` |
| PI1.4 | Output completeness | Reports reconcile to the trial balance; CSV/PDF exports tested | `tests/integration/modules.test.ts` |
| PI1.5 | Storage integrity | Deterministic document totals, immutable journal entries (corrections by reversal), hash-chained audit | Journal service, audit chain |

## Evidence collection cadence

| Activity | Frequency | Artefact |
| --- | --- | --- |
| Access review (users, roles, API keys, platform admins) | Quarterly | Exported user list + sign-off |
| Audit-chain verification (`/audit/verify`) | Monthly | JSON result attached to ticket |
| Restore test | Quarterly | Restore log with row counts and hash spot-check |
| Dependency and image scan review | Monthly | `npm audit` + registry scan report |
| Penetration test | Annual | Report + remediation tracker |
| Incident review | Per incident | Post-incident report within 5 business days |
| Vendor review | Annual | Vendor questionnaire results |

## Gaps to close before an audit window

1. Named control owners and a signed policy set (information security, access control,
   change management, incident response, vendor management).
2. Centralised log retention (ship stdout to an append-only store with 1-year retention).
3. Alerting rules wired to an on-call channel (5xx spike, auth-failure spike, worker lag,
   audit-verify failure).
4. Automated retention job for sessions and login attempts.
5. Background-check and security-training records for staff with production access.
6. Formal change-management tickets linked to deployments (the repo currently evidences
   code review and CI, not approvals for infrastructure changes).
