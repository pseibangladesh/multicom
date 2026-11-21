/**
 * Copyright (c) 2026 Ronan LE MEILLAT
 * License: AGPL-3.0-or-later
 *
 * Store metadata utilities for managing customer preferences.
 * Handles normalization and retrieval of store-specific metadata.
 *
 * D1 stores preferences in customers.metadata (replaces Auth0 user_metadata).
 */

/**
 * Normalize store URL for use as a metadata key.
 * Replaces dots, colons, and slashes with underscores for safe key usage.
 *
 * @param storeUrl - The store URL to normalize (e.g., "https://store.example.com/")
 * @returns Normalized key (e.g., "https___store_example_com") or undefined
 */
export const normalizeStoreUrl = (storeUrl?: string): string | undefined => {
  if (!storeUrl) return undefined;
  const normalized = storeUrl
    .replace(/\/$/, "") // Remove trailing slash
    .replace(/[:./]/g, "_"); // Replace dots, colons, and slashes with underscores

  return normalized || undefined;
};

/**
 * Extract store-specific metadata from customer metadata.
 * Falls back to root-level metadata for backward compatibility.
 *
 * @param metadata - The customer metadata object
 * @param storeUrl - Optional store URL to use as key
 * @returns Store metadata object or the parent metadata if no store URL
 */
export const getStoreMetadata = (metadata: any, storeUrl?: string): any => {
  if (!metadata || typeof metadata !== "object") return undefined;

  const normalizedUrl = normalizeStoreUrl(storeUrl);

  if (
    normalizedUrl &&
    metadata[normalizedUrl] &&
    typeof metadata[normalizedUrl] === "object"
  ) {
    return metadata[normalizedUrl];
  }

  return metadata;
};
