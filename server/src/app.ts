import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { config } from './config.js';
import type { DB } from './db/driver.js';
import { AppError } from './lib/errors.js';
import { registerRoutes } from './routes/index.js';

export interface BuildOptions {
  db: DB;
  logger?: boolean | object;
}

export async function buildApp({ db, logger }: BuildOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger ?? {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body.password', 'req.body.refreshToken'],
    },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    genReqId: () => crypto.randomUUID(),
  });

  app.decorate('db', db);
  app.decorateRequest('db', null as unknown as DB);
  app.addHook('onRequest', async (req: FastifyRequest) => {
    req.db = db;
  });

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: config.isProd
      ? {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:', 'blob:'],
            connectSrc: ["'self'"],
            objectSrc: ["'none'"],
            frameAncestors: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
          },
        }
      : false,
    crossOriginEmbedderPolicy: false,
    hsts: config.isProd ? { maxAge: 63_072_000, includeSubDomains: true, preload: true } : false,
  });

  await app.register(fastifyCors, {
    origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-Id', 'X-Api-Key', 'Idempotency-Key'],
    exposedHeaders: ['X-Request-Id', 'RateLimit-Remaining'],
  });

  await app.register(fastifyRateLimit, {
    global: true,
    max: config.isProd ? 600 : 5000,
    timeWindow: '1 minute',
    allowList: (req) => req.url.startsWith('/api/v1/health'),
    keyGenerator: (req) => (req as FastifyRequest & { ctx?: { user: { id: string } } }).ctx?.user.id ?? req.ip,
  });

  await app.register(fastifyMultipart, {
    limits: { fileSize: config.maxUploadBytes, files: 1 },
  });

  // Uploaded files are never exposed as a public directory: receipts are streamed by
  // GET /attachments/:id after a tenant + permission check.

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details ?? undefined },
        requestId: req.id,
      });
    }
    const fastifyError = error as { statusCode?: number; code?: string; message?: string };
    if (fastifyError.statusCode && fastifyError.statusCode < 500) {
      return reply.code(fastifyError.statusCode).send({
        error: { code: fastifyError.code ?? 'bad_request', message: fastifyError.message ?? 'Bad request' },
        requestId: req.id,
      });
    }
    req.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({
      error: { code: 'internal_error', message: 'Something went wrong on our side. The incident has been logged.' },
      requestId: req.id,
    });
  });

  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send({ error: { code: 'not_found', message: `No route for ${req.method} ${req.url}` } });
    }
    return reply.code(404).type('text/plain').send('Not found');
  });

  app.get('/api/v1/health', async () => ({
    status: 'ok',
    version: '1.0.0',
    time: new Date().toISOString(),
    database: db.dialect,
  }));

  await app.register(
    async (scope) => {
      await registerRoutes(scope);
    },
    { prefix: '/api/v1' },
  );

  /**
   * Scheduler entry point. Serverless platforms have no long-lived worker, so
   * an external scheduler (Vercel Cron, Kubernetes CronJob, GitHub Actions)
   * pokes this route. The shared secret keeps it closed to the public while
   * still allowing a GET so platform cron jobs can call it directly.
   */
  app.route({
    method: ['GET', 'POST'],
    url: '/api/v1/cron/jobs',
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      if (!config.cronSecret) {
        return reply.code(503).send({ error: { code: 'cron_disabled', message: 'CRON_SECRET is not configured' } });
      }
      const header = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? req.headers['x-cron-secret'];
      if (typeof header !== 'string' || header !== config.cronSecret) {
        return reply.code(401).send({ error: { code: 'unauthorized', message: 'Invalid cron secret' } });
      }
      const { runDueWork } = await import('./jobs/worker.js');
      const stats = await runDueWork(db);
      return { ok: true, ...stats, ranAt: new Date().toISOString() };
    },
  });

  // Single-page application hosting (production image serves the built web app).
  // Serverless deployments serve the SPA from the CDN instead.
  const webDist = path.resolve(process.cwd(), 'web/dist');
  if (!config.serverless && existsSync(webDist)) {
    // Imported lazily: @fastify/static pulls in an ESM-only dependency that the
    // serverless runtime refuses to require(), and the CDN serves the SPA there.
    const { default: fastifyStatic } = await import('@fastify/static');
    await app.register(fastifyStatic, { root: webDist, prefix: '/', decorateReply: false, wildcard: false });
    app.get('/*', async (req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Unknown API route' } });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
