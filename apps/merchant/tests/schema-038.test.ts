/**
 * Migration 038 end state, checked against the real MerchantDO schema.
 * The migration runner swallows SQL errors, so these assertions are what
 * catches a step that silently failed.
 */
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createMerchantDb } from './helpers/merchant-db';

type Merchant = ReturnType<typeof createMerchantDb>['merchant'];

const columns = (m: Merchant, table: string) =>
  m.query<{ name: string }>(`PRAGMA table_info("${table}")`).map((c) => c.name);
const foreignKeys = (m: Merchant, table: string) =>
  m.query<{ from: string; table: string; on_delete: string }>(`PRAGMA foreign_key_list("${table}")`);
const tableExists = (m: Merchant, name: string) =>
  m.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, [name]).length === 1;

function seedChannel(m: Merchant, id = 'ch1') {
  m.run(`INSERT INTO marketplace_channels (id, platform, store_id) VALUES (?, 'ebay', 'default')`, [id]);
}

describe('migration 038', () => {
  it('records every 038 step as applied', () => {
    const { merchant } = createMerchantDb();
    const applied = merchant.query<{ name: string }>(`SELECT name FROM migrations WHERE name LIKE '038_%'`).map((r) => r.name);
    expect(applied.sort()).toEqual(
      [
        '038_marketplace_credentials_expires_at',
        '038_marketplace_oauth_states',
        '038_marketplace_order_lines',
        '038_marketplace_orders_unique_external',
        '038_marketplace_webhook_events',
        '038_orders_channel_id',
        '038_orders_updated_at',
        '038_orders_updated_at_triggers',
        '038_products_updated_at',
        '038_products_updated_at_triggers',
        '038_variants_updated_at',
        '038_variants_updated_at_triggers',
      ].sort()
    );
  });

  it.each(['products', 'variants', 'orders'])('adds updated_at to %s', (table) => {
    const { merchant } = createMerchantDb();
    expect(columns(merchant, table)).toContain('updated_at');
  });

  it('sets updated_at on insert and bumps it on update (triggers)', () => {
    const { merchant } = createMerchantDb();
    merchant.run(`INSERT INTO products (id, title, created_at) VALUES ('p1', 'Tee', '2020-01-01 00:00:00')`);
    expect(merchant.query<any>(`SELECT updated_at FROM products WHERE id = 'p1'`)[0].updated_at).toBe('2020-01-01 00:00:00');

    merchant.run(`UPDATE products SET title = 'Tee v2' WHERE id = 'p1'`);
    const bumped = merchant.query<any>(`SELECT updated_at FROM products WHERE id = 'p1'`)[0].updated_at;
    expect(bumped > '2020-01-01 00:00:00').toBe(true);

    // An explicit updated_at in the UPDATE is kept, not overwritten.
    merchant.run(`UPDATE products SET title = 'v3', updated_at = '2030-01-01 00:00:00' WHERE id = 'p1'`);
    expect(merchant.query<any>(`SELECT updated_at FROM products WHERE id = 'p1'`)[0].updated_at).toBe('2030-01-01 00:00:00');
  });

  it('adds orders.channel_id referencing marketplace_channels', () => {
    const { merchant } = createMerchantDb();
    expect(columns(merchant, 'orders')).toContain('channel_id');
    expect(foreignKeys(merchant, 'orders')).toContainEqual(
      expect.objectContaining({ from: 'channel_id', table: 'marketplace_channels' })
    );
  });

  it('adds marketplace_credentials.expires_at', () => {
    const { merchant } = createMerchantDb();
    expect(columns(merchant, 'marketplace_credentials')).toContain('expires_at');
  });

  it('rejects a duplicate (channel_id, external_order_id) in marketplace_orders', () => {
    const { merchant } = createMerchantDb();
    seedChannel(merchant);
    const insert = (id: string) =>
      merchant.run(
        `INSERT INTO marketplace_orders (id, channel_id, external_order_id, status, raw_payload) VALUES (?, 'ch1', 'EXT-1', 'NEW', '{}')`,
        [id]
      );
    insert('mo1');
    expect(() => insert('mo2')).toThrow(/UNIQUE/);
  });

  it('keeps the sync job CHECK: real job types pass, "pending" is rejected', () => {
    const { merchant } = createMerchantDb();
    seedChannel(merchant);
    const insert = (id: string, jobType: string) =>
      merchant.run(`INSERT INTO marketplace_sync_jobs (id, channel_id, job_type) VALUES (?, 'ch1', ?)`, [id, jobType]);
    expect(() => insert('j1', 'push_products')).not.toThrow();
    expect(() => insert('j2', 'push_inventory')).not.toThrow();
    expect(() => insert('j3', 'pending')).toThrow(/CHECK/);
  });

  it('creates marketplace_oauth_states, cascading from its channel', () => {
    const { merchant } = createMerchantDb();
    expect(tableExists(merchant, 'marketplace_oauth_states')).toBe(true);
    expect(columns(merchant, 'marketplace_oauth_states')).toEqual(
      expect.arrayContaining(['state', 'platform', 'channel_id', 'code_verifier', 'return_to', 'expires_at'])
    );
    expect(foreignKeys(merchant, 'marketplace_oauth_states')).toContainEqual(
      expect.objectContaining({ table: 'marketplace_channels', on_delete: 'CASCADE' })
    );
  });

  it('creates marketplace_order_lines linked to marketplace_orders and order_items', () => {
    const { merchant } = createMerchantDb();
    const fks = foreignKeys(merchant, 'marketplace_order_lines');
    expect(fks).toContainEqual(expect.objectContaining({ from: 'marketplace_order_id', table: 'marketplace_orders', on_delete: 'CASCADE' }));
    expect(fks).toContainEqual(expect.objectContaining({ from: 'order_item_id', table: 'order_items' }));
  });

  it('creates marketplace_webhook_events with (platform, external_event_id) unique', () => {
    const { merchant } = createMerchantDb();
    const insert = (id: string) =>
      merchant.run(
        `INSERT INTO marketplace_webhook_events (id, platform, external_event_id, payload) VALUES (?, 'ebay', 'evt-1', '{}')`,
        [id]
      );
    insert('w1');
    expect(() => insert('w2')).toThrow(/UNIQUE/);
  });

  it('039 adds orders.tracking_carrier and marketplace_order_lines.inventory_deducted', () => {
    const { merchant } = createMerchantDb();
    expect(columns(merchant, 'orders')).toContain('tracking_carrier');
    expect(columns(merchant, 'marketplace_order_lines')).toContain('inventory_deducted');
  });

  it('is safe to boot twice on the same database (restart of a deployed DO)', () => {
    const sqlite = new DatabaseSync(':memory:');
    createMerchantDb({}, sqlite);
    const { merchant } = createMerchantDb({}, sqlite);
    expect(columns(merchant, 'orders').filter((c) => c === 'updated_at')).toHaveLength(1);
    expect(merchant.query(`SELECT name FROM migrations WHERE name = '038_orders_channel_id'`)).toHaveLength(1);
  });
});
