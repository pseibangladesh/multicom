import { describe, it, expect } from 'vitest';
import { getDb } from '../src/db';
import { ebayClientForChannel, parseChannelConfig, resolveListingConfig } from '../src/lib/marketplace/channel';
import { createMerchantDb } from './helpers/merchant-db';

const FULL = {
  category_id: '15687',
  fulfillment_policy_id: 'fp',
  payment_policy_id: 'pp',
  return_policy_id: 'rp',
  merchant_location_key: 'wh-1',
};

describe('channel config', () => {
  it('parses config_json defensively', () => {
    expect(parseChannelConfig('{"default_carrier":"USPS"}')).toEqual({ default_carrier: 'USPS' });
    expect(parseChannelConfig('not json')).toEqual({});
    expect(parseChannelConfig('[1]')).toEqual({});
    expect(parseChannelConfig(null)).toEqual({});
  });

  it('builds listing settings from config_json', () => {
    expect(resolveListingConfig({ listing: FULL })).toEqual({
      categoryId: '15687',
      fulfillmentPolicyId: 'fp',
      paymentPolicyId: 'pp',
      returnPolicyId: 'rp',
      merchantLocationKey: 'wh-1',
    });
  });

  it('uses the location-key fallback but stays unlisted while account-specific IDs are missing', () => {
    const { merchant_location_key: _omit, ...noLocation } = FULL;
    expect(resolveListingConfig({ listing: noLocation })?.merchantLocationKey).toBe('default');
    expect(resolveListingConfig({ listing: { category_id: '1' } })).toBeNull();
    expect(resolveListingConfig({})).toBeNull();
  });

  it('builds a client from the channel row and refuses inactive or non-eBay channels', () => {
    const db = getDb(createMerchantDb().merchant as never);
    const tokens = { getAccessToken: async () => 't', refresh: async () => 't' };
    const client = ebayClientForChannel(
      db,
      {},
      { id: 'ch1', platform: 'ebay', status: 'active', config: { marketplace_id: 'EBAY_GB', environment: 'sandbox', listing: FULL } },
      { tokens }
    );
    expect(client.config).toMatchObject({ marketplaceId: 'EBAY_GB', environment: 'sandbox', listing: { categoryId: '15687' } });

    expect(() => ebayClientForChannel(db, {}, { id: 'c', platform: 'ebay', status: 'paused', config: {} }, { tokens })).toThrow(/not active/);
    expect(() => ebayClientForChannel(db, {}, { id: 'c', platform: 'etsy', status: 'active', config: {} }, { tokens })).toThrow(/not an eBay/);
  });
});
