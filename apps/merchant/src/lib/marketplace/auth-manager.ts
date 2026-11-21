/**
 * MIT License
 *
 * Copyright (c) 2025 ygwyg
 * Copyright (c) 2026 Ronan Le Meillat - SCTG Development
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { decrypt } from './crypto-utils';
import type { MarketCredential } from './types';

/**
 * Manages encrypted credentials for marketplace channels.
 *
 * Reads/writes from the `marketplace_credentials` table via the Durable Object SQL helper.
 * All tokens are stored encrypted with AES-GCM using the CRYPTOKEN passphrase.
 */

export type Database = {
  query: <T = unknown>(sql: string, params?: unknown[]) => Promise<T[]>;
  run: (sql: string, params?: unknown[]) => Promise<{ changes: number }>;
};

/**
 * Credential manager instance backed by a SQL database.
 */
export class CredentialManager {
  constructor(
    private db: Database,
    private encryptionKey: string,
  ) {}

  // ── Save credentials ────────────────────────────────────────────────────

  /**
   * Store (or update) an encrypted credential for a channel.
   * Uses INSERT OR REPLACE to handle upserts atomically.
   */
  async saveCredential(credential: {
    channelId: string;
    type: 'api_key' | 'oauth_token' | 'refresh_token';
    value: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const encrypted = await encryptForStorage(credential.value, this.encryptionKey);

    // Upsert: INSERT OR REPLACE on (channel_id, credential_type) unique constraint.
    await this.db.run(
      `INSERT INTO marketplace_credentials 
        (id, channel_id, credential_type, encrypted_value, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(channel_id, credential_type) DO UPDATE SET
          encrypted_value = excluded.encrypted_value,
          metadata = excluded.metadata,
          updated_at = datetime('now')`,
      [
        crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        credential.channelId,
        credential.type,
        encrypted,
        JSON.stringify(credential.metadata ?? {}),
      ],
    );
  }

  // ── Read credentials ────────────────────────────────────────────────────

  /**
   * Retrieve and decrypt a credential for a channel.
   * @returns The decrypted plaintext value, or null if not found.
   */
  async getSecret(
    channelId: string,
    type: 'api_key' | 'oauth_token' | 'refresh_token',
  ): Promise<string | null> {
    const rows = await this.db.query<MarketCredential>(
      `SELECT encrypted_value, metadata FROM marketplace_credentials 
       WHERE channel_id = ? AND credential_type = ?`,
      [channelId, type],
    );

    if (rows.length === 0) return null;

    const row = rows[0];
    try {
      return await decrypt(row.encryptedValue, this.encryptionKey);
    } catch {
      throw new Error(
        `Failed to decrypt ${type} for channel ${channelId}. Check encryption key.`,
      );
    }
  }

  /** Get all decrypted credentials for a channel. */
  async getChannelCredentials(channelId: string): Promise<Record<string, string>> {
    const types: Array<'api_key' | 'oauth_token' | 'refresh_token'> = [
      'api_key', 'oauth_token', 'refresh_token',
    ];

    const result: Record<string, string> = {};
    for (const type of types) {
      const value = await this.getSecret(channelId, type);
      if (value !== null) {
        result[type] = value;
      }
    }
    return result;
  }

  // ── Metadata ────────────────────────────────────────────────────────────

  /**
   * Get credential metadata without decrypting the value.
   * Useful for checking expiry timestamps.
   */
  async getMetadata(
    channelId: string,
    type: 'api_key' | 'oauth_token' | 'refresh_token',
  ): Promise<Record<string, unknown> | null> {
    const rows = await this.db.query<{ metadata: string }>(
      `SELECT metadata FROM marketplace_credentials 
       WHERE channel_id = ? AND credential_type = ?`,
      [channelId, type],
    );

    if (rows.length === 0) return null;
    return JSON.parse(rows[0].metadata);
  }

  /**
   * Check if a token is near expiry (< 5 minutes remaining).
   */
  async isTokenNearExpiry(
    channelId: string,
    type: 'oauth_token' | 'refresh_token',
  ): Promise<boolean> {
    const meta = await this.getMetadata(channelId, type);
    if (!meta || !meta.expires_at) return false;

    const expiresAt = new Date(meta.expires_at as string);
    const now = new Date();
    const fiveMinutesMs = 5 * 60 * 1000;
    return expiresAt.getTime() - now.getTime() < fiveMinutesMs;
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────

  /**
   * Remove all credentials for a channel (e.g., on disconnect).
   */
  async removeChannel(channelId: string): Promise<void> {
    await this.db.run(
      `DELETE FROM marketplace_credentials WHERE channel_id = ?`,
      [channelId],
    );
  }
}

// ─── Local helpers (used by both saveCredential and decrypt) ─────────────────

/**
 * Encrypt plaintext for storage. Mirrors the logic in crypto-utils.decrypt
 * but uses AES-GCM encryption with PBKDF2 key derivation.
 */
async function encryptForStorage(plaintext: string, password: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pwBytes = new TextEncoder().encode(password);
  const baseKey = await crypto.subtle.importKey(
    'raw', pwBytes, 'PBKDF2', false, ['deriveBits'],
  );
  const derived = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(16), iterations: 100_000 },
      baseKey,
      384, // 48 bytes = 32 key + 16 IV for AES-GCM (using last 32 as key, first 16 as... wait)
    ),
  );

  // Actually use the same pattern as crypto-utils.ts: derive a CryptoKey directly.
  const aesKey = await crypto.subtle.importKey(
    'raw', derived.slice(0, 32), 'AES-GCM', false, ['encrypt'],
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    new TextEncoder().encode(plaintext),
  );

  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);
  return btoa(String.fromCharCode(...combined));
}
