/**
 * Vercel serverless entry point.
 *
 * Vercel hands us a raw Node request/response pair; Fastify already knows how
 * to serve those via its underlying server, so the app is built once per
 * function instance and reused for warm invocations. Schema migrations are
 * applied on first boot, and the demo sandbox is seeded when SEED_DEMO=true and
 * the database is empty.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/src/app.js';
import { ensureDatabase } from '../server/src/db/bootstrap.js';
import { createDb } from '../server/src/db/driver.js';

let booting: Promise<FastifyInstance> | null = null;

async function boot(): Promise<FastifyInstance> {
  const db = createDb();
  const result = await ensureDatabase(db);
  if (result.migrated.length) console.log(`[bootstrap] applied ${result.migrated.join(', ')}`);
  if (result.seeded) console.log('[bootstrap] seeded the demo sandbox');
  const app = await buildApp({ db });
  await app.ready();
  return app;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (!booting) {
      booting = boot().catch((err) => {
        booting = null;
        throw err;
      });
    }
    const app = await booting;
    app.server.emit('request', req, res);
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 503;
      res.setHeader('content-type', 'application/json');
    }
    res.end(
      JSON.stringify({
        error: { code: 'bootstrap_failed', message: err instanceof Error ? err.message : 'Database unavailable' },
      }),
    );
  }
}
