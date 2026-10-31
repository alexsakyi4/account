/**
 * Schema bootstrap for environments that boot the API lazily (serverless
 * functions, first container start). Applies pending migrations from disk when
 * the repository is present, otherwise from the build-time bundle, and seeds
 * the demo sandbox once when SEED_DEMO=true and the database is empty.
 */
import { config } from '../config.js';
import type { DB } from './driver.js';
import { migrate, migrationsDir } from './migrate.js';
import { BUNDLED_MIGRATIONS } from './migrations.generated.js';

export interface BootstrapResult {
  migrated: string[];
  seeded: boolean;
  dialect: DB['dialect'];
}

function hasMigrationsOnDisk(): boolean {
  try {
    migrationsDir();
    return true;
  } catch {
    return false;
  }
}

async function migrateFromBundle(db: DB): Promise<string[]> {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(
    (await db.all<{ version: string }>('SELECT version FROM schema_migrations')).map((row) => row.version),
  );
  const ran: string[] = [];
  for (const migration of BUNDLED_MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    await db.tx(async (tx) => {
      await tx.exec(migration.sql);
      await tx.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [
        migration.version,
        new Date().toISOString(),
      ]);
    });
    ran.push(migration.version);
  }
  return ran;
}

export async function ensureDatabase(db: DB): Promise<BootstrapResult> {
  const migrated = hasMigrationsOnDisk() ? await migrate(db) : await migrateFromBundle(db);

  let seeded = false;
  if (config.seedDemo) {
    const existing = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tenants');
    if (Number(existing?.n ?? 0) === 0) {
      const { seedDemo } = await import('./seed.js');
      await seedDemo(db);
      seeded = true;
    }
  }
  return { migrated, seeded, dialect: db.dialect };
}
