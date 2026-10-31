// TEMPORARY diagnostic endpoint — deleted once the deployment is verified.
export default async function handler(_req, res) {
  const out = { ok: true, node: process.version, nodeEnv: process.env.NODE_ENV ?? null };
  try {
    const pg = (await import('pg')).default;
    out.pg = 'imported';
    if (process.env.DATABASE_URL) {
      const client = new pg.Client({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
      });
      await client.connect();
      const r = await client.query('select 1 as x, current_database() as db');
      out.db = { connected: true, db: r.rows[0].db };
      await client.end();
    } else {
      out.db = { connected: false, reason: 'DATABASE_URL missing' };
    }
  } catch (err) {
    out.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(out));
}
