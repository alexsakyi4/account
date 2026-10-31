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
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

export type Dialect = 'sqlite' | 'postgres';
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
  private inner: DatabaseSync;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(filename: string) {
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
    this.pool = new pg.Pool({ connectionString: url, max: Number(process.env.PG_POOL_MAX ?? 10) });
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
