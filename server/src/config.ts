import 'dotenv/config';
import { createHash } from 'node:crypto';
import path from 'node:path';

const env = process.env;

function bool(v: string | undefined, fallback = false): boolean {
  if (v == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

/** Deterministic development secret: keeps local demos working without setup,
 *  while production refuses to boot without real secrets (see validate()). */
function devSecret(name: string, length = 48): string {
  return createHash('sha256').update(`ledgerline-dev:${name}`).digest('hex').slice(0, length);
}

export const config = {
  env: env.NODE_ENV ?? 'development',
  isProd: env.NODE_ENV === 'production',
  port: Number(env.PORT ?? 4000),
  host: env.HOST ?? '0.0.0.0',
  databaseUrl: env.DATABASE_URL ?? `sqlite:${path.join(process.cwd(), 'data/ledgerline.db')}`,
  jwtSecret: env.JWT_SECRET ?? devSecret('jwt'),
  encryptionKey: env.ENCRYPTION_KEY ?? devSecret('encryption'),
  accessTokenTtl: Number(env.ACCESS_TOKEN_TTL ?? 900),
  refreshTokenTtl: Number(env.REFRESH_TOKEN_TTL ?? 60 * 60 * 24 * 30),
  appUrl: env.APP_URL ?? 'http://localhost:5173',
  apiUrl: env.API_URL ?? 'http://localhost:4000',
  uploadDir: env.UPLOAD_DIR ?? path.join(process.cwd(), 'uploads'),
  maxUploadBytes: Number(env.MAX_UPLOAD_BYTES ?? 10 * 1024 * 1024),
  corsOrigins: (env.CORS_ORIGINS ?? '*').split(',').map((s) => s.trim()),
  stripeSecretKey: env.STRIPE_SECRET_KEY ?? '',
  plaidClientId: env.PLAID_CLIENT_ID ?? '',
  plaidSecret: env.PLAID_SECRET ?? '',
  smtpUrl: env.SMTP_URL ?? '',
  ocrProvider: env.OCR_PROVIDER ?? 'local',
  require2faForAdmins: bool(env.REQUIRE_2FA_FOR_ADMINS, env.NODE_ENV === 'production'),
  seedDemo: bool(env.SEED_DEMO, false),
  logLevel: env.LOG_LEVEL ?? 'info',
  jobsIntervalMs: Number(env.JOBS_INTERVAL_MS ?? 15_000),
  /** Set on Vercel/Netlify-style platforms where there is no long-lived process. */
  serverless: Boolean(env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME || env.NETLIFY),
  /** Shared secret that authorises the scheduler to run due jobs. */
  cronSecret: env.CRON_SECRET ?? '',
};

/** Fail fast on missing security-critical configuration in production. */
export function validateConfig(): string[] {
  const problems: string[] = [];
  if (config.isProd) {
    if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) problems.push('JWT_SECRET must be >= 32 chars');
    if (!env.ENCRYPTION_KEY || env.ENCRYPTION_KEY.length < 32) problems.push('ENCRYPTION_KEY must be >= 32 chars');
    if (config.corsOrigins.includes('*')) problems.push('CORS_ORIGINS must not be "*" in production');
    if (!env.DATABASE_URL) problems.push('DATABASE_URL is required in production');
    if (!env.APP_URL?.startsWith('https://')) problems.push('APP_URL must use https in production');
  }
  return problems;
}
