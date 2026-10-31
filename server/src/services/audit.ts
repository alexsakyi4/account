/**
 * Immutable, tamper-evident audit trail.
 *
 * Entries are append-only and chained: each row's hash covers the previous
 * row's hash plus a canonical serialisation of the entry, so removing or
 * editing history is detectable (`verifyChain`). The API never exposes mutate
 * or delete operations for this table and `ledgerline_app` has no UPDATE/DELETE
 * grant on it in production (see deploy/postgres/roles.sql).
 */
import type { DB } from '../db/driver.js';
import { newId } from '../db/driver.js';
import { sha256 } from '../lib/crypto.js';

export interface AuditActor {
  id: string | null;
  email: string | null;
  role: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditInput {
  tenantId: string | null;
  actor: AuditActor;
  action: string;
  entityType: string;
  entityId?: string | null;
  summary?: string;
  before?: unknown;
  after?: unknown;
}

function canonical(value: unknown):string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function recordAudit(db: DB, input: AuditInput): Promise<void> {
  const tenantId = input.tenantId ?? 'platform';
  const last = await db.get<{ seq: number; hash: string }>(
    'SELECT seq, hash FROM audit_logs WHERE tenant_id = ? ORDER BY seq DESC LIMIT 1',
    [tenantId],
  );
  const seq = Number(last?.seq ?? 0) + 1;
  const prevHash = last?.hash ?? 'GENESIS';
  const createdAt = new Date().toISOString();
  const id = newId();
  const body = canonical({
    id,
    tenantId,
    seq,
    actorId: input.actor.id,
    actorEmail: input.actor.email,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    summary: input.summary ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
    createdAt,
    prevHash,
  });
  const hash = sha256(body);
  await db.run(
    `INSERT INTO audit_logs (id, tenant_id, seq, actor_id, actor_email, actor_role, action, entity_type, entity_id,
       summary, before_json, after_json, ip, user_agent, created_at, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      tenantId,
      seq,
      input.actor.id,
      input.actor.email,
      input.actor.role,
      input.action,
      input.entityType,
      input.entityId ?? null,
      input.summary ?? null,
      input.before ? JSON.stringify(input.before) : null,
      input.after ? JSON.stringify(input.after) : null,
      input.actor.ip ?? null,
      input.actor.userAgent ?? null,
      createdAt,
      prevHash,
      hash,
    ],
  );
}

export function recomputeHash(row: {
  id: string;
  tenant_id: string;
  seq: number;
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  summary: string | null;
  before_json: string | null;
  after_json: string | null;
  created_at: string;
  prev_hash: string | null;
}): string {
  return sha256(
    canonical({
      id: row.id,
      tenantId: row.tenant_id,
      seq: row.seq,
      actorId: row.actor_id,
      actorEmail: row.actor_email,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      summary: row.summary,
      before: row.before_json ? JSON.parse(row.before_json) : null,
      after: row.after_json ? JSON.parse(row.after_json) : null,
      createdAt: row.created_at,
      prevHash: row.prev_hash,
    }),
  );
}

/** Verifies both the hash chain and each row's content hash. */
export async function verifyChain(db: DB, tenantId: string): Promise<{ valid: boolean; entries: number; brokenAt?: number }> {
  const rows = await db.all<{
    id: string;
    tenant_id: string;
    seq: number;
    hash: string;
    prev_hash: string | null;
    actor_id: string | null;
    actor_email: string | null;
    action: string;
    entity_type: string;
    entity_id: string | null;
    summary: string | null;
    before_json: string | null;
    after_json: string | null;
    created_at: string;
  }>('SELECT * FROM audit_logs WHERE tenant_id = ? ORDER BY seq ASC', [tenantId]);
  let prev = 'GENESIS';
  for (const row of rows) {
    if (row.prev_hash !== prev) return { valid: false, entries: rows.length, brokenAt: row.seq };
    if (recomputeHash(row) !== row.hash) return { valid: false, entries: rows.length, brokenAt: row.seq };
    prev = row.hash;
  }
  return { valid: true, entries: rows.length };
}
