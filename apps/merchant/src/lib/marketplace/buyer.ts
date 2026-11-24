/**
 * Marketplace buyers are created or merged into `customers` by email. Some
 * marketplaces hide the buyer's address behind a per-order relay (Amazon:
 * `xyz@marketplace.amazon.com`), or omit it. Merging on such an address would
 * either fail or fold unrelated buyers together, so those orders get a
 * deterministic per-order placeholder instead.
 */

/** Relay domains whose addresses do not identify a stable buyer. */
const MASKED_EMAIL_DOMAINS = ['marketplace.amazon.com', 'marketplace.amazon.co.uk', 'marketplace.amazon.de'];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function placeholderBuyerEmail(externalOrderId: string): string {
  const safeId = externalOrderId.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return `buyer-${safeId}@placeholder.local`;
}

export function isMaskedEmail(email: string): boolean {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  return MASKED_EMAIL_DOMAINS.includes(domain);
}

/** The email to create/merge the customer on. */
export function resolveBuyerEmail(email: string | null | undefined, externalOrderId: string): string {
  const trimmed = email?.trim().toLowerCase() ?? '';
  if (!EMAIL_RE.test(trimmed) || isMaskedEmail(trimmed)) return placeholderBuyerEmail(externalOrderId);
  return trimmed;
}
