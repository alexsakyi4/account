import type { FastifyRequest } from 'fastify';
import type { DB } from '../db/driver.js';
import { sha256, verifyToken } from '../lib/crypto.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { config } from '../config.js';
import {
  getFlags,
  loadTenant,
  permissionsFor,
  requirePermission,
  type Permission,
  type Role,
  type TenantContext,
} from '../services/tenancy.js';

export interface AuthContext {
  user: { id: string; email: string; name: string; is_platform_admin: number; totp_enabled: number };
  tenantId: string;
  tenant: TenantContext;
  role: Role;
  permissions: Permission[];
  flags: Record<string, boolean>;
  authType: 'jwt' | 'api_key' | 'system';
}

declare module 'fastify' {
  interface FastifyRequest {
    ctx?: AuthContext;
    db: DB;
  }
  interface FastifyInstance {
    db: DB;
  }
}

function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim();
  return null;
}

async function resolveApiKey(db: DB, token: string): Promise<{ userId: string; tenantId: string; role: Role } | null> {
  if (!token.startsWith('ll_')) return null;
  const hash = sha256(token);
  const row = await db.get<{ id: string; tenant_id: string; created_by: string; role: string; revoked_at: string | null }>(
    'SELECT * FROM api_keys WHERE key_hash = ?',
    [hash],
  );
  if (!row || row.revoked_at) return null;
  await db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [new Date().toISOString(), row.id]);
  return { userId: row.created_by, tenantId: row.tenant_id, role: (row.role as Role) ?? 'bookkeeper' };
}

export async function authenticate(req: FastifyRequest): Promise<void> {
  const db = req.db;
  const token = bearer(req);
  if (!token) throw unauthorized();

  let userId: string | null = null;
  let tenantId: string | null = null;
  let role: Role | null = null;
  let authType: 'jwt' | 'api_key' = 'jwt';

  if (token.startsWith('ll_')) {
    const key = await resolveApiKey(db, token);
    if (!key) throw unauthorized('Invalid API key');
    userId = key.userId;
    tenantId = key.tenantId;
    role = key.role;
    authType = 'api_key';
  } else {
    const payload = verifyToken(token);
    if (!payload || payload.typ !== 'access' || !payload.sub) throw unauthorized('Session expired');
    userId = payload.sub;
    tenantId = (payload.tid as string) ?? null;
    role = (payload.role as Role) ?? null;
  }

  const user = await db.get<{ id: string; email: string; name: string; is_platform_admin: number; totp_enabled: number; status: string }>(
    'SELECT id, email, name, is_platform_admin, totp_enabled, status FROM users WHERE id = ?',
    [userId],
  );
  if (!user || user.status !== 'active') throw unauthorized('Account is not active');

  const headerTenant = req.headers['x-tenant-id'];
  if (typeof headerTenant === 'string' && headerTenant && headerTenant !== tenantId) {
    const membership = await db.get<{ role: string }>(
      "SELECT role FROM memberships WHERE user_id = ? AND tenant_id = ? AND status = 'active'",
      [userId, headerTenant],
    );
    if (!membership) throw forbidden('You do not have access to that company');
    tenantId = headerTenant;
    role = membership.role as Role;
  }

  if (!tenantId) {
    const membership = await db.get<{ tenant_id: string; role: string }>(
      "SELECT tenant_id, role FROM memberships WHERE user_id = ? AND status = 'active' ORDER BY created_at LIMIT 1",
      [userId],
    );
    if (!membership) throw forbidden('No company is linked to this account');
    tenantId = membership.tenant_id;
    role = membership.role as Role;
  } else {
    const membership = await db.get<{ role: string }>(
      "SELECT role FROM memberships WHERE user_id = ? AND tenant_id = ? AND status = 'active'",
      [userId, tenantId],
    );
    if (!membership) throw forbidden('You do not have access to that company');
    role = membership.role as Role;
  }

  const tenant = await loadTenant(db, tenantId);
  req.ctx = {
    user,
    tenantId,
    tenant,
    role: role as Role,
    permissions: permissionsFor(role as Role),
    flags: await getFlags(db, tenantId),
    authType,
  };
}

export function requireAuth(permission?: Permission) {
  return async (req: FastifyRequest): Promise<void> => {
    await authenticate(req);
    if (permission && req.ctx) requirePermission(req.ctx.role, permission);
  };
}

export function adminOnly(req: FastifyRequest): void {
  if (!req.ctx) throw unauthorized();
  if (req.ctx.role !== 'admin' && !req.ctx.user.is_platform_admin) throw forbidden('Administrator access required');
}

export function platformAdminOnly(req: FastifyRequest): void {
  if (!req.ctx?.user.is_platform_admin) throw forbidden('Platform administrator access required');
}

export function appUrl(path = ''): string {
  return `${config.appUrl.replace(/\/$/, '')}${path}`;
}
