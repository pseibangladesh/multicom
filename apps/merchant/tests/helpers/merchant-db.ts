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

function fakeSqlStorage(db: DatabaseSync) {
  return {
    exec(sql: string, ...params: unknown[]) {
      let rows: unknown[] = [];
      if (params.length === 0 && !/^\s*(select|with|pragma)\b/i.test(sql)) {
        db.exec(sql); // may contain several statements, like DO SqlStorage.exec
      } else {
        const stmt = db.prepare(sql);
        const args = params.map(toSqlValue);
        if (stmt.columns().length > 0) rows = stmt.all(...args);
        else stmt.run(...args);
      }
      return { toArray: () => rows.map((r) => ({ ...(r as object) })) };
    },
  };
}

export function createMerchantDb(env: Record<string, unknown> = {}) {
  const sqlite = new DatabaseSync(':memory:');
  const ctx = { storage: { sql: fakeSqlStorage(sqlite) }, acceptWebSocket() {} };
  const merchant = new MerchantDO(ctx as never, env as never);
  merchant.query('SELECT 1'); // runs SCHEMA + migrations
  return { merchant, sqlite };
}
