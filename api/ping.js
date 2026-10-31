// TEMPORARY diagnostic endpoint — deleted once the deployment is verified.
import pg from 'pg';
import { poolConfig } from '../server/src/db/driver.js';

export default async function handler(_req, res) {
  const out = { ok: true, node: process.version, nodeEnv: process.env.NODE_ENV ?? null };
  try {
    const cfg = poolConfig(process.env.DATABASE_URL ?? '');
    out.sslmode = /sslmode=([a-z-]+)/i.exec(cfg.connectionString ?? '')?.[1] ?? 'none';
    const client = new pg.Client(cfg);
    await client.connect();
    const r = await client.query("select count(*)::int as tables from information_schema.tables where table_schema = 'public'");
    out.db = { connected: true, tables: r.rows[0].tables };
    await client.end();
  } catch (err) {
    out.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(out));
}
