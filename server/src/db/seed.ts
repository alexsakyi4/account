/**
 * Idempotent demo seed: a platform administrator, a training sandbox company
 * with realistic sample data, and a demo login you can share for evaluations.
 *
 *   ADMIN_EMAIL / ADMIN_PASSWORD  (default admin@ledgerline.app / ChangeMe123!)
 *   DEMO_EMAIL  / DEMO_PASSWORD   (default demo@ledgerline.app  / DemoPass123!)
 */
import type { DB } from './driver.js';
import { newId } from './driver.js';
import { hashPassword } from '../lib/crypto.js';
import { provisionCompany } from '../services/provisioning.js';

export async function seedDemo(db: DB): Promise<{ adminEmail: string; demoEmail: string; tenantId: string }> {
  const now = new Date().toISOString();
  const adminEmail = (process.env.ADMIN_EMAIL ?? 'admin@ledgerline.app').toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD ?? 'ChangeMe123!';
  const demoEmail = (process.env.DEMO_EMAIL ?? 'demo@ledgerline.app').toLowerCase();
  const demoPassword = process.env.DEMO_PASSWORD ?? 'DemoPass123!';

  let admin = await db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', [adminEmail]);
  if (!admin) {
    const id = newId();
    await db.run(
      `INSERT INTO users (id, email, name, password_hash, is_platform_admin, status, created_at, updated_at)
       VALUES (?, ?, 'Platform Administrator', ?, 1, 'active', ?, ?)`,
      [id, adminEmail, await hashPassword(adminPassword), now, now],
    );
    admin = { id };
  } else {
    await db.run('UPDATE users SET is_platform_admin = 1 WHERE id = ?', [admin.id]);
  }

  let demoUser = await db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', [demoEmail]);
  if (!demoUser) {
    const id = newId();
    await db.run(
      `INSERT INTO users (id, email, name, password_hash, status, created_at, updated_at)
       VALUES (?, ?, 'Alex Mensah', ?, 'active', ?, ?)`,
      [id, demoEmail, await hashPassword(demoPassword), now, now],
    );
    demoUser = { id };
  }

  const existing = await db.get<{ id: string }>('SELECT t.id FROM tenants t JOIN memberships m ON m.tenant_id = t.id WHERE t.slug = ?', ['lakeside-trading']);
  if (existing) {
    return { adminEmail, demoEmail, tenantId: existing.id };
  }

  const tenantId = await provisionCompany(db, {
    name: 'Lakeside Trading Co.',
    industry: 'retail',
    currency: 'USD',
    adminUserId: demoUser.id,
    adminEmail: demoEmail,
    isSandbox: true,
    withSampleData: true,
    plan: 'growth',
  });
  await db.run("UPDATE tenants SET is_sandbox = 1, slug = 'lakeside-trading' WHERE id = ?", [tenantId]);
  await db.run("UPDATE subscriptions SET status = 'active', plan = 'growth', price_cents = 4900 WHERE tenant_id = ?", [tenantId]);

  return { adminEmail, demoEmail, tenantId };
}

if (process.argv[1]?.includes('seed')) {
  const { createDb } = await import('./driver.js');
  const { migrate } = await import('./migrate.js');
  const db = createDb();
  await migrate(db);
  const result = await seedDemo(db);
  console.log('Seeded:', result);
  await db.close();
}
