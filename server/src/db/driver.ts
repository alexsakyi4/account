/**
 * Database access layer.
 *
 * One portable SQL dialect is used so the same schema and queries run against
 * SQLite (zero-dependency local development / demo) and PostgreSQL (production).
 *
 *   * placeholders are written as `?` and rewritten to `$1..$n` for PostgreSQL
 *   * money is BIGINT minor units, booleans INTEGER 0/1, timestamps ISO-8601 text
 *   * transactions are scoped with AsyncLocalStorage so repository calls nested
 *     anywhere below `db.tx()` automatically join the open transaction
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { DatabaseSync as SqliteDatabase } from 'node:sqlite';
import pg from 'pg';

/**
 * `node:sqlite` is loaded on demand so a PostgreSQL-only deployment (Vercel,
 * managed containers) never touches it — the module is experimental in some
 * Node builds and simply may not exist there.
 */
type SqliteCtor = new (filename: string) => SqliteDatabase;
function loadSqlite(): SqliteCtor {
  const require = createRequire(import.meta.url);
  try {
    return (require('node:sqlite') as { DatabaseSync: SqliteCtor }).DatabaseSync;
  } catch {
    throw new Error(
      'SQLite is unavailable in this runtime. Set DATABASE_URL to a PostgreSQL connection string.',
    );
  }
}

export type Dialect = 'sqlite' | 'postgres';

/**
 * PostgreSQL pool options.
 *
 * `pg` 8.23 parses `sslmode=require` as libpq's *verify-full*: the server
 * certificate is checked against the system trust store. Hosted providers
 * (Supabase, Neon, RDS proxies…) sign with their own CA, so a plain
 * `?sslmode=require` URL fails with "self-signed certificate in certificate
 * chain" even though the connection would be encrypted.
 *
 * We keep the historical meaning of the modes that only promise encryption —
 * `require`, `prefer` and `verify-ca` (without `sslrootcert`) become
 * `sslmode=no-verify`: still TLS, certificate chain not pinned. Set
 * `PG_SSL_VERIFY_STRICT=true` (and pass `sslrootcert`/`sslcert` in the URL) to
 * get full verification, which is what `sslmode=verify-full` always does.
 */
export function poolConfig(url: string): pg.PoolConfig {
  const strict = /^(1|true|yes|on)$/i.test(process.env.PG_SSL_VERIFY_STRICT ?? '');
  const unverified = /[?&]sslmode=(require|prefer|verify-ca)\b/i;
  const hasRootCert = /[?&]sslrootcert=/i.test(url);
  const connectionString =
    !strict && !hasRootCert && unverified.test(url)
      ? url.replace(unverified, (match) => match.replace(/=(require|prefer|verify-ca)$/i, '=no-verify'))
      : url;
  return { connectionString, max: Number(process.env.PG_POOL_MAX ?? 10) };
}

export type Param = unknown;

export interface DB {
  dialect: Dialect;
  all<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<T | undefined>;
  run(sql: string, params?: Param[]): Promise<number>;
  exec(sql: string): Promise<void>;
  tx<T>(fn: (db: DB) => Promise<T>): Promise<T>;
  /** Escape hatch for engine specific DDL such as `SELECT 1`. */
  raw<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<T[]>;
  close(): Promise<void>;
}

const txStore = new AsyncLocalStorage<DB>();

function normalise(params: Param[] = []): Array<string | number | bigint | null | Uint8Array> {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p as string | number | bigint | null;
  });
}

export function toPgSql(sql: string): string {
  let i = 0;
  let out = '';
  let inSingle = false;
  for (let c = 0; c < sql.length; c += 1) {
    const ch = sql[c];
    if (ch === "'") inSingle = !inSingle;
    if (ch === '?' && !inSingle) {
      i += 1;
      out += `$${i}`;
    } else {
      out += ch;
    }
  }
  return out;
}

class SqliteDb implements DB {
  readonly dialect: Dialect = 'sqlite';
  private inner: SqliteDatabase;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(filename: string) {
    const DatabaseSync = loadSqlite();
    this.inner = new DatabaseSync(filename);
    this.inner.exec('PRAGMA journal_mode = WAL;');
    this.inner.exec('PRAGMA foreign_keys = ON;');
    this.inner.exec('PRAGMA busy_timeout = 5000;');
  }

  private get scope(): DB {
    return txStore.getStore() ?? this;
  }

  /** Serialises every operation: SQLite has a single writer and no isolation
   *  between overlapping async call stacks. Ops are synchronous so the window
   *  being locked is tiny. Nested calls inside a transaction run directly. */
  private locked<T>(fn: () => T): Promise<T> {
    if (txStore.getStore()) return Promise.resolve(fn());
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  all<T>(sql: string, params: Param[] = []): Promise<T[]> {
    return this.locked(() => this.inner.prepare(sql).all(...normalise(params)) as T[]);
  }

  async get<T>(sql: string, params: Param[] = []): Promise<T | undefined> {
    const rows = await this.all<T>(sql, params);
    return rows[0];
  }

  run(sql: string, params: Param[] = []): Promise<number> {
    return this.locked(() => {
      const res = this.inner.prepare(sql).run(...normalise(params));
      return Number(res.changes);
    });
  }

  exec(sql: string): Promise<void> {
    return this.locked(() => {
      this.inner.exec(sql);
    });
  }

  async tx<T>(fn: (db: DB) => Promise<T>): Promise<T> {
    if (txStore.getStore()) return fn(txStore.getStore() as DB);
    return this.locked(async () => {
      this.inner.exec('BEGIN IMMEDIATE');
      const scoped = Object.create(this) as DB;
      scoped.all = this.all.bind(this);
      scoped.get = this.get.bind(this);
      scoped.run = this.run.bind(this);
      scoped.exec = this.exec.bind(this);
      scoped.tx = async (inner) => inner(txStore.getStore() ?? scoped);
      try {
        const result = await txStore.run(scoped, () => fn(scoped));
        this.inner.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          this.inner.exec('ROLLBACK');
        } catch {
          /* already rolled back */
        }
        throw err;
      }
    });
  }

  raw<T>(sql: string, params: Param[] = []): Promise<T[]> {
    return this.all<T>(sql, params);
  }

  async close(): Promise<void> {
    this.inner.close();
  }
}

class PostgresDb implements DB {
  readonly dialect: Dialect = 'postgres';
  private pool: pg.Pool;

  constructor(url: string) {
    // Money fits comfortably in a double, and consumers expect numbers.
    pg.types.setTypeParser(20, (v) => Number(v));
    this.pool = new pg.Pool(poolConfig(url));
  }

  private client(): pg.Pool | pg.PoolClient {
    return txStore.getStore() && (txStore.getStore() as unknown as { client?: pg.PoolClient }).client
      ? ((txStore.getStore() as unknown as { client: pg.PoolClient }).client)
      : this.pool;
  }

  async all<T>(sql: string, params: Param[] = []): Promise<T[]> {
    const res = await this.client().query(toPgSql(sql), normalise(params));
    return res.rows as T[];
  }

  async get<T>(sql: string, params: Param[] = []): Promise<T | undefined> {
    const rows = await this.all<T>(sql, params);
    return rows[0];
  }

  async run(sql: string, params: Param[] = []): Promise<number> {
    const res = await this.client().query(toPgSql(sql), normalise(params));
    return Number(res.rowCount ?? 0);
  }

  async exec(sql: string): Promise<void> {
    await this.client().query(sql);
  }

  async tx<T>(fn: (db: DB) => Promise<T>): Promise<T> {
    if (txStore.getStore()) return fn(txStore.getStore() as DB);
    const client = await this.pool.connect();
    const scoped = Object.create(this) as DB;
    Object.assign(scoped, { client });
    scoped.all = this.all.bind(this);
    scoped.get = this.get.bind(this);
    scoped.run = this.run.bind(this);
    scoped.exec = this.exec.bind(this);
    scoped.tx = async (inner) => inner(txStore.getStore() ?? scoped);
    scoped.raw = (sql, params) => this.raw(sql, params);
    try {
      await client.query('BEGIN');
      const result = await txStore.run(scoped, () => fn(scoped));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async raw<T>(sql: string, params: Param[] = []): Promise<T[]> {
    return this.all<T>(sql, params);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

let singleton: DB | null = null;

export function createDb(urlOverride?: string): DB {
  if (singleton && !urlOverride) return singleton;
  const url = urlOverride ?? process.env.DATABASE_URL ?? '';
  if (url.startsWith('postgres')) {
    singleton = new PostgresDb(url);
  } else {
    const file = url.replace(/^sqlite:/, '') || './data/ledgerline.db';
    singleton = new SqliteDb(file);
  }
  return singleton;
}

export function setDb(db: DB): void {
  singleton = db;
}

export function newId(): string {
  return randomUUID();
}
