import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config, validateConfig } from './config.js';
import { buildApp } from './app.js';
import { createDb } from './db/driver.js';
import { migrate } from './db/migrate.js';
import { startWorker } from './jobs/worker.js';

async function main(): Promise<void> {
  const problems = validateConfig();
  if (problems.length) {
    console.error('Invalid configuration:\n - ' + problems.join('\n - '));
    process.exit(1);
  }

  await mkdir(config.uploadDir, { recursive: true });
  if (config.databaseUrl.startsWith('sqlite:')) {
    const file = config.databaseUrl.replace(/^sqlite:/, '');
    await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  }
  const db = createDb();
  const applied = await migrate(db);
  if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);

  if (config.seedDemo) {
    const { seedDemo } = await import('./db/seed.js');
    const result = await seedDemo(db);
    console.log('[seed]', result);
  }

  const app = await buildApp({ db });
  await app.listen({ port: config.port, host: config.host });
  console.log(`LedgerLine API listening on http://${config.host}:${config.port} (${db.dialect})`);

  if (process.env.WORKER_MODE !== 'off') {
    startWorker(db);
    console.log(`Background worker started (every ${config.jobsIntervalMs}ms)`);
  }

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down`);
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal startup error', err);
  process.exit(1);
});
