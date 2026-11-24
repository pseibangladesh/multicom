/**
 * Confirms shipment of an imported marketplace order back on the marketplace.
 *
 * Carrier precedence: orders.tracking_carrier (set on the order) →
 * channel config default_carrier → EBAY_DEFAULT_CARRIER_FALLBACK.
 * Lines come from marketplace_order_lines, so eBay gets its own lineItemIds.
 */
import type { Database } from '../../db';
import { ApiError } from '../../types';
import { EBAY_DEFAULT_CARRIER_FALLBACK, type ChannelConfig } from './channel';
import type { ShipmentClient } from './types';

export async function pushShipment(
  db: Database,
  client: ShipmentClient,
  channel: { id: string; config: ChannelConfig },
  orderId: string,
): Promise<{ externalOrderId: string; carrier: string; trackingNumber: string; lines: number }> {
  const [order] = await db.query<{ channel_id: string | null; tracking_number: string | null; tracking_carrier: string | null }>(
    `SELECT channel_id, tracking_number, tracking_carrier FROM orders WHERE id = ?`,
    [orderId],
  );
  if (!order) throw ApiError.notFound('Order not found');
  if (order.channel_id !== channel.id) throw ApiError.invalidRequest('Order does not belong to this channel');
  if (!order.tracking_number) throw ApiError.invalidRequest('Order has no tracking number');

  const [mo] = await db.query<{ id: string; external_order_id: string }>(
    `SELECT id, external_order_id FROM marketplace_orders WHERE internal_order_id = ? AND channel_id = ?`,
    [orderId, channel.id],
  );
  if (!mo) throw ApiError.notFound('No marketplace order is linked to this order');

  const lines = await db.query<{ external_line_item_id: string; qty: number }>(
    `SELECT external_line_item_id, qty FROM marketplace_order_lines WHERE marketplace_order_id = ?`,
    [mo.id],
  );
  if (lines.length === 0) throw ApiError.invalidRequest('Marketplace order has no lines to ship');

  const carrier = order.tracking_carrier || channel.config.default_carrier || EBAY_DEFAULT_CARRIER_FALLBACK;
  await client.createShippingFulfillment({
    orderId: mo.external_order_id,
    trackingNumber: order.tracking_number,
    shippingCarrierCode: carrier,
    lineItems: lines.map((l) => ({ lineItemId: l.external_line_item_id, quantity: l.qty })),
  });

  await db.run(`UPDATE marketplace_orders SET status = 'FULFILLED', updated_at = datetime('now') WHERE id = ?`, [mo.id]);
  return { externalOrderId: mo.external_order_id, carrier, trackingNumber: order.tracking_number, lines: lines.length };
}
