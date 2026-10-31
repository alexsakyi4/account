/** Minimal forward-only migration runner shared by SQLite and PostgreSQL. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from './driver.js';

export function migrationsDir(): string {
  const candidates = [
    path.resolve(process.cwd(), 'db/migrations'),
    path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../db/migrations'),
    path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../db/migrations'),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new Error('Could not locate db/migrations');
}

export async function migrate(db: DB): Promise<string[]> {
  const dir = migrationsDir();
  await db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const applied = new Set((await db.all<{ version: string }>('SELECT version FROM schema_migrations')).map((r) => r.version));
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(path.join(dir, file), 'utf8');
    await db.tx(async (tx) => {
      await tx.exec(sql);
      await tx.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [file, new Date().toISOString()]);
    });
    ran.push(file);
  }
  return ran;
}

if (process.argv[1]?.includes('migrate')) {
  const { createDb } = await import('./driver.js');
  const db = createDb();
  const applied = await migrate(db);
  console.log(applied.length ? `Applied ${applied.length} migration(s): ${applied.join(', ')}` : 'Schema is up to date');
  await db.close();
}
