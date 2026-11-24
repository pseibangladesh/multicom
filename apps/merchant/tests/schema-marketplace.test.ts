/**
 * Keeps the SCHEMA constant and the inline migrations in agreement for the
 * marketplace tables (CLAUDE.md: schema changes go in SCHEMA + migration + .sql).
 */
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from '../src/do';
import { createMerchantDb } from './helpers/merchant-db';

/** Created by migration 038 only; see the comment above the marketplace block in SCHEMA. */
const MIGRATION_ONLY_INDEXES = new Set(['uq_marketplace_orders_channel_external']);

function runSchemaOnly(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  // Same splitting as MerchantDO.ensureInitialized().
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) db.exec(stmt);
  return db;
}

function marketplaceTables(db: DatabaseSync): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'marketplace_%' ORDER BY name`).all() as Array<{ name: string }>).map(
    (r) => r.name
  );
}

/** Columns, FKs and indexes of every marketplace table, in comparable form. */
function snapshot(db: DatabaseSync, { skipIndexes = new Set<string>() } = {}) {
  return Object.fromEntries(
    marketplaceTables(db).map((t) => {
      const columns = db.prepare(`PRAGMA table_info("${t}")`).all();
      const fks = db.prepare(`PRAGMA foreign_key_list("${t}")`).all().map(({ id: _id, seq: _seq, ...fk }: any) => fk);
      const indexes = (db.prepare(`PRAGMA index_list("${t}")`).all() as Array<{ name: string; unique: number; origin: string }>)
        .filter((i) => !skipIndexes.has(i.name))
        .map((i) => ({
          // Autoindex names depend on creation order; key them by their columns instead.
          name: i.origin === 'c' ? i.name : `auto:${i.origin}`,
          unique: i.unique,
          columns: (db.prepare(`PRAGMA index_info("${i.name}")`).all() as Array<{ name: string }>).map((c) => c.name),
        }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return [t, { columns, fks, indexes }];
    })
  );
}

describe('SCHEMA marketplace tables', () => {
  it('creates every marketplace table on its own', () => {
    expect(marketplaceTables(runSchemaOnly())).toEqual(marketplaceTables(createMerchantDb().sqlite));
    expect(marketplaceTables(runSchemaOnly())).toHaveLength(8);
  });

  it('matches the shape the migrations produce (columns, FKs, indexes)', () => {
    const fromSchema = snapshot(runSchemaOnly());
    const live = snapshot(createMerchantDb().sqlite, { skipIndexes: MIGRATION_ONLY_INDEXES });
    expect(fromSchema).toEqual(live);
  });

  it('still gets the migration-only unique index on a fresh DO', () => {
    const { sqlite } = createMerchantDb();
    const idx = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'uq_marketplace_orders_channel_external'`).all();
    expect(idx).toHaveLength(1);
  });

  it('upgrades a DO that predates the marketplace tables to the same schema', () => {
    // Simulate a DO deployed before migration 037: no marketplace tables, no 037-039 records.
    const { sqlite } = createMerchantDb();
    sqlite.exec('PRAGMA foreign_keys = OFF');
    for (const t of marketplaceTables(sqlite)) sqlite.exec(`DROP TABLE "${t}"`);
    sqlite.exec(`DELETE FROM migrations WHERE name LIKE '037_marketplace_%' OR name LIKE '039_marketplace_%'
                 OR name IN ('038_marketplace_credentials_expires_at', '038_marketplace_orders_unique_external',
                             '038_marketplace_oauth_states', '038_marketplace_order_lines', '038_marketplace_webhook_events')`);
    sqlite.exec('PRAGMA foreign_keys = ON');

    const upgraded = createMerchantDb({}, sqlite); // boots a new MerchantDO on the old DB
    expect(snapshot(upgraded.sqlite)).toEqual(snapshot(createMerchantDb().sqlite));
  });

  it('booting twice is a no-op (SCHEMA is safe to re-run on a migrated DO)', () => {
    const { sqlite } = createMerchantDb();
    const before = snapshot(sqlite);
    expect(() => createMerchantDb({}, sqlite)).not.toThrow();
    expect(snapshot(sqlite)).toEqual(before);
  });
});
