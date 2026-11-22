/**
 * Runs the real MerchantDO (real SCHEMA + migrations) on node:sqlite, so tests
 * exercise the same tables and columns as production.
 */
import { DatabaseSync } from 'node:sqlite';
import { MerchantDO } from '../../src/do';

type Value = null | number | bigint | string | Uint8Array;

function toSqlValue(v: unknown): Value {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v as Value;
}

/** Mimics the DO SqlStorageCursor API used by MerchantDO and drizzle-orm/durable-sqlite. */
function cursor(columns: string[], arrays: unknown[][]) {
  const objects = arrays.map((a) => Object.fromEntries(columns.map((c, i) => [c, a[i]])));
  let i = 0;
  return {
    columnNames: columns,
    toArray: () => objects,
    one: () => objects[0],
    next: () => (i < objects.length ? { done: false, value: objects[i++] } : { done: true, value: undefined }),
    raw: () => ({ toArray: () => arrays }),
    [Symbol.iterator]: () => objects[Symbol.iterator](),
  };
}

function fakeSqlStorage(db: DatabaseSync) {
  return {
    exec(sql: string, ...params: unknown[]) {
      if (params.length === 0 && !/^\s*(select|with|pragma)\b/i.test(sql)) {
        db.exec(sql); // may contain several statements, like DO SqlStorage.exec
        return cursor([], []);
      }
      const stmt = db.prepare(sql);
      const args = params.map(toSqlValue);
      const columns = stmt.columns().map((c) => c.name);
      if (columns.length === 0) {
        stmt.run(...args);
        return cursor([], []);
      }
      // Execute once (RETURNING must not run twice), as arrays to keep duplicate column names.
      stmt.setReturnArrays(true);
      return cursor(columns, stmt.all(...args) as unknown as unknown[][]);
    },
  };
}

/**
 * @param sqlite Pass an existing database to boot a second MerchantDO on it
 *               (simulates a restart / re-running migrations on a deployed DO).
 */
export function createMerchantDb(env: Record<string, unknown> = {}, sqlite = new DatabaseSync(':memory:')) {
  const storage = {
    sql: fakeSqlStorage(sqlite),
    transactionSync<T>(fn: () => T): T {
      sqlite.exec('BEGIN');
      try {
        const result = fn();
        sqlite.exec('COMMIT');
        return result;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },
  };
  let ready: Promise<unknown> = Promise.resolve();
  const ctx = {
    storage,
    acceptWebSocket() {},
    // Like the runtime: run the constructor's init; `ready` resolves when it finishes.
    blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      const p = fn();
      ready = p;
      return p;
    },
  };
  const merchant = new MerchantDO(ctx as never, env as never);
  merchant.query('SELECT 1'); // runs SCHEMA + migrations
  return { merchant, sqlite, ready: () => ready };
}
