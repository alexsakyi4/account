/**
 * Vercel serverless entry point.
 *
 * Vercel hands us a raw Node request/response pair; Fastify already knows how
 * to serve those via its underlying server, so the app is built once per
 * function instance and reused for warm invocations. Schema migrations are
 * applied on first boot, and the demo sandbox is seeded when SEED_DEMO=true and
 * the database is empty.
 *
 * The application modules are imported dynamically inside the boot promise so a
 * configuration or database problem surfaces as a readable 503 from this
 * handler instead of an opaque FUNCTION_INVOCATION_FAILED from the platform.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../server/src/db/driver.js';

interface Bootstrapper {
  ensureDatabase(db: DB): Promise<{ migrated: string[]; seeded: boolean }>;
}

interface DriverModule {
  createDb(): DB;
}

interface AppModule {
  buildApp(options: { db: DB }): Promise<FastifyInstance>;
}

let booting: Promise<FastifyInstance> | null = null;

async function boot(): Promise<FastifyInstance> {
  const [bootstrap, driver, appModule] = await Promise.all([
    import('../server/src/db/bootstrap.js') as Promise<Bootstrapper>,
    import('../server/src/db/driver.js') as Promise<DriverModule>,
    import('../server/src/app.js') as Promise<AppModule>,
  ]);
  const db = driver.createDb();
  const result = await bootstrap.ensureDatabase(db);
  if (result.migrated.length) console.log(`[bootstrap] applied ${result.migrated.join(', ')}`);
  if (result.seeded) console.log('[bootstrap] seeded the demo sandbox');
  const app = await appModule.buildApp({ db });
  await app.ready();
  return app;
}

function describe(err: unknown): { message: string; detail?: string } {
  const message = err instanceof Error ? err.message : String(err);
  const debug = ['1', 'true', 'yes', 'on'].includes((process.env.BOOTSTRAP_DEBUG ?? '').toLowerCase());
  if (!debug || !(err instanceof Error) || !err.stack) return { message };
  return { message, detail: err.stack.split('\n').slice(0, 8).join('\n') };
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (!booting) {
      booting = boot().catch((err: unknown) => {
        booting = null;
        throw err;
      });
    }
    const app = await booting;
    app.server.emit('request', req, res);
  } catch (err) {
    console.error('[bootstrap] failed', err);
    if (!res.headersSent) {
      res.statusCode = 503;
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
    }
    res.end(
      JSON.stringify({
        error: { code: 'bootstrap_failed', message: 'The service is starting up. Retry in a moment.' },
        debug: describe(err),
      }),
    );
  }
}
