/**
 * Copyright (c) 2026 Ronan LE MEILLAT - SCTG Development
 * License: AGPL-3.0-or-later
 */

/**
 * Pure helpers for the marketplace admin page (/admin/marketplaces): API
 * types, config form <-> PATCH body conversion, client-side validation that
 * mirrors the backend schemas, and parsing of the OAuth return redirect.
 *
 * Backend: GET  /v1/admin/marketplace/channels
 *          PATCH /v1/admin/marketplace/channels/:id/config
 *          POST /v1/marketplace/connect/:platform
 *          POST /v1/marketplace/:id/orders/import
 *          POST /v1/marketplace/:id/sync/products
 */

export type MarketplacePlatform = "ebay" | "etsy" | "amazon";

/** Platforms whose connect flow is implemented on the backend. */
export const CONNECTABLE_PLATFORMS = ["ebay", "etsy"] as const;
export type ConnectablePlatform = (typeof CONNECTABLE_PLATFORMS)[number];

export const PLATFORM_LABELS: Record<MarketplacePlatform, string> = {
  ebay: "eBay",
  etsy: "Etsy",
  amazon: "Amazon",
};

export interface ChannelSummary {
  id: string;
  platform: MarketplacePlatform;
  status: "active" | "paused" | "error" | string;
  externalShopId: string | null;
  config: Record<string, unknown>;
  connected: boolean;
  listingReady: boolean;
  lastOrderImportAt: string | null;
  lastJob: {
    type: string;
    status: string | null;
    error: string | null;
    updatedAt: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrderImportResponse {
  fetched: number;
  imported: unknown[];
  skipped: unknown[];
  failed: unknown[];
  shortfalls: unknown[];
  unmatchedSkus: unknown[];
}

// ─── Config form ─────────────────────────────────────────────────────────────

/** Every field is a string (the raw input value); "" means "not set". */
export interface EtsyConfigForm {
  default_carrier: string;
  taxonomy_id: string;
  shipping_profile_id: string;
  readiness_state_id: string;
  return_policy_id: string;
  who_made: "" | "i_did" | "someone_else" | "collective";
  when_made: string;
  is_supply: "" | "true" | "false";
}

export interface EbayConfigForm {
  marketplace_id: string;
  content_language: string;
  default_carrier: string;
  category_id: string;
  fulfillment_policy_id: string;
  payment_policy_id: string;
  return_policy_id: string;
  merchant_location_key: string;
}

export type ConfigForm = EtsyConfigForm | EbayConfigForm;

const ETSY_LISTING_FIELDS = [
  "taxonomy_id",
  "shipping_profile_id",
  "readiness_state_id",
  "return_policy_id",
  "who_made",
  "when_made",
  "is_supply",
] as const;
const ETSY_INT_FIELDS = new Set([
  "taxonomy_id",
  "shipping_profile_id",
  "readiness_state_id",
  "return_policy_id",
]);

const EBAY_TOP_FIELDS = [
  "marketplace_id",
  "content_language",
  "default_carrier",
] as const;
const EBAY_LISTING_FIELDS = [
  "category_id",
  "fulfillment_policy_id",
  "payment_policy_id",
  "return_policy_id",
  "merchant_location_key",
] as const;

/** Fields the backend needs before the channel can create listings. */
export const REQUIRED_FOR_LISTING: Record<
  ConnectablePlatform,
  readonly string[]
> = {
  etsy: ["taxonomy_id", "shipping_profile_id"],
  ebay: [
    "category_id",
    "fulfillment_policy_id",
    "payment_policy_id",
    "return_policy_id",
    "merchant_location_key",
  ],
};

const str = (v: unknown): string =>
  v === undefined || v === null ? "" : String(v);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

export function etsyFormFromConfig(
  config: Record<string, unknown>,
): EtsyConfigForm {
  const d = obj(config.listing_defaults);

  return {
    default_carrier: str(config.default_carrier),
    taxonomy_id: str(d.taxonomy_id),
    shipping_profile_id: str(d.shipping_profile_id),
    readiness_state_id: str(d.readiness_state_id),
    return_policy_id: str(d.return_policy_id),
    who_made: str(d.who_made) as EtsyConfigForm["who_made"],
    when_made: str(d.when_made),
    is_supply: d.is_supply === undefined ? "" : d.is_supply ? "true" : "false",
  };
}

export function ebayFormFromConfig(
  config: Record<string, unknown>,
): EbayConfigForm {
  const l = obj(config.listing);

  return {
    marketplace_id: str(config.marketplace_id),
    content_language: str(config.content_language),
    default_carrier: str(config.default_carrier),
    category_id: str(l.category_id),
    fulfillment_policy_id: str(l.fulfillment_policy_id),
    payment_policy_id: str(l.payment_policy_id),
    return_policy_id: str(l.return_policy_id),
    merchant_location_key: str(l.merchant_location_key),
  };
}

export function formFromConfig(
  platform: ConnectablePlatform,
  config: Record<string, unknown>,
): ConfigForm {
  return platform === "etsy"
    ? etsyFormFromConfig(config)
    : ebayFormFromConfig(config);
}

/** Field → error key (an i18n key). Mirrors the backend zod schemas. */
export function validateConfigForm(
  platform: ConnectablePlatform,
  form: ConfigForm,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const f = form as unknown as Record<string, string>;

  if (f.default_carrier && f.default_carrier.trim().length > 64)
    errors.default_carrier = "admin-marketplaces-error-too-long";

  if (platform === "etsy") {
    for (const k of ETSY_INT_FIELDS) {
      if (f[k] && !/^[1-9]\d*$/.test(f[k].trim()))
        errors[k] = "admin-marketplaces-error-positive-int";
    }
    if (
      f.when_made &&
      !/^(made_to_order|\d{4}_\d{4}|before_\d{4}|\d{4}s)$/.test(
        f.when_made.trim(),
      )
    ) {
      errors.when_made = "admin-marketplaces-error-when-made";
    }
  } else {
    if (f.marketplace_id && !/^EBAY_[A-Z_]{2,}$/.test(f.marketplace_id.trim()))
      errors.marketplace_id = "admin-marketplaces-error-marketplace-id";
    if (
      f.content_language &&
      !/^[a-z]{2}-[A-Z]{2}$/.test(f.content_language.trim())
    ) {
      errors.content_language = "admin-marketplaces-error-content-language";
    }
    for (const k of EBAY_LISTING_FIELDS)
      if (f[k] && f[k].trim().length > 128)
        errors[k] = "admin-marketplaces-error-too-long";
  }

  return errors;
}

function fieldValue(
  platform: ConnectablePlatform,
  key: string,
  raw: string,
): unknown {
  const v = raw.trim();

  if (v === "") return null; // cleared → backend deletes the key
  if (platform === "etsy" && ETSY_INT_FIELDS.has(key)) return Number(v);
  if (platform === "etsy" && key === "is_supply") return v === "true";

  return v;
}

/**
 * PATCH body with only the fields that changed from `original`. Cleared
 * fields are sent as null. Returns null when nothing changed.
 */
export function buildConfigPatch(
  platform: ConnectablePlatform,
  form: ConfigForm,
  original: ConfigForm,
): Record<string, unknown> | null {
  const f = form as unknown as Record<string, string>;
  const o = original as unknown as Record<string, string>;
  const changed = (k: string) => (f[k] ?? "").trim() !== (o[k] ?? "").trim();

  const patch: Record<string, unknown> = {};
  const nested: Record<string, unknown> = {};

  const [top, listing, nestedKey] =
    platform === "etsy"
      ? [["default_carrier"], ETSY_LISTING_FIELDS, "listing_defaults"]
      : [EBAY_TOP_FIELDS, EBAY_LISTING_FIELDS, "listing"];

  for (const k of top) if (changed(k)) patch[k] = fieldValue(platform, k, f[k]);
  for (const k of listing)
    if (changed(k)) nested[k] = fieldValue(platform, k, f[k]);
  if (Object.keys(nested).length > 0) patch[nestedKey] = nested;

  return Object.keys(patch).length > 0 ? patch : null;
}

/** Which required listing fields are still empty in the form. */
export function missingListingFields(
  platform: ConnectablePlatform,
  form: ConfigForm,
): string[] {
  const f = form as unknown as Record<string, string>;

  return REQUIRED_FOR_LISTING[platform].filter((k) => !f[k]?.trim());
}

// ─── OAuth return ────────────────────────────────────────────────────────────

export interface OAuthReturn {
  platform: string;
  result: "connected" | "denied" | "error";
  error: string | null;
  channelId: string | null;
}

/** The backend callback redirects to return_to?marketplace=…&result=…[&error=…][&channelId=…]. */
export function readOAuthReturn(search: string): OAuthReturn | null {
  const p = new URLSearchParams(search);
  const platform = p.get("marketplace");
  const result = p.get("result");

  if (
    !platform ||
    (result !== "connected" && result !== "denied" && result !== "error")
  )
    return null;

  return {
    platform,
    result,
    error: p.get("error"),
    channelId: p.get("channelId"),
  };
}

/** Query params the OAuth return adds; removed from the URL once shown. */
export const OAUTH_RETURN_PARAMS = [
  "marketplace",
  "result",
  "error",
  "channelId",
] as const;

/** i18n key for an OAuth return. */
export function oauthReturnMessageKey(r: OAuthReturn): string {
  if (r.result === "connected") return "admin-marketplaces-connected";
  if (r.result === "denied") return "admin-marketplaces-connect-denied";
  if (r.error === "shop_mismatch")
    return "admin-marketplaces-connect-shop-mismatch";

  return "admin-marketplaces-connect-failed";
}

/** Where the marketplace sends the admin back to (must be an allowed origin on the backend). */
export function connectReturnUrl(origin: string, basePath: string): string {
  return `${origin}${basePath.replace(/\/+$/, "")}/admin/marketplaces`;
}

export function summarizeImport(r: OrderImportResponse) {
  return {
    fetched: r.fetched ?? 0,
    imported: r.imported?.length ?? 0,
    skipped: r.skipped?.length ?? 0,
    failed: r.failed?.length ?? 0,
    shortfalls: r.shortfalls?.length ?? 0,
    unmatched: r.unmatchedSkus?.length ?? 0,
  };
}

/** SQLite datetime('now') values are UTC without a zone ("2026-11-22 10:00:00"). */
export function parseServerDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const d = new Date(iso);

  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatServerDate(
  value: string | null | undefined,
  locale?: string,
): string {
  const d = parseServerDate(value);

  return d ? d.toLocaleString(locale) : "—";
}

/** How often the page refreshes while a queued job is pending/in progress. */
export const JOB_POLL_INTERVAL_MS = 5000;

export function hasRunningJob(channels: ChannelSummary[]): boolean {
  return channels.some(
    (c) =>
      c.lastJob?.status === "pending" || c.lastJob?.status === "in_progress",
  );
}

/** useSecuredApi throws `HTTP <status>` with no body. */
export function isConflictError(err: unknown): boolean {
  return err instanceof Error && /\bHTTP 409\b/.test(err.message);
}
