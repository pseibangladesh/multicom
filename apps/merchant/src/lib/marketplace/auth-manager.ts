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

import { decrypt, encrypt } from './crypto-utils';
import type { CredentialType } from './types';

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
    type: CredentialType;
    value: string;
    /** ISO 8601 expiry, stored in the queryable expires_at column (migration 038). */
    expiresAt?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const encrypted = await encrypt(credential.value, this.encryptionKey);

    await this.db.run(
      `INSERT INTO marketplace_credentials
        (id, channel_id, credential_type, encrypted_value, metadata, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(channel_id, credential_type) DO UPDATE SET
          encrypted_value = excluded.encrypted_value,
          metadata = excluded.metadata,
          expires_at = excluded.expires_at,
          updated_at = datetime('now')`,
      [
        crypto.randomUUID(),
        credential.channelId,
        credential.type,
        encrypted,
        JSON.stringify(credential.metadata ?? {}),
        credential.expiresAt ?? null,
      ],
    );
  }

  // ── Read credentials ────────────────────────────────────────────────────

  /** Decrypted credential plus its expiry, or null if not stored. */
  async getCredential(
    channelId: string,
    type: CredentialType,
  ): Promise<{ value: string; expiresAt: string | null } | null> {
    const rows = await this.db.query<{ encrypted_value: string; expires_at: string | null }>(
      `SELECT encrypted_value, expires_at FROM marketplace_credentials
       WHERE channel_id = ? AND credential_type = ?`,
      [channelId, type],
    );

    if (rows.length === 0) return null;

    try {
      return { value: await decrypt(rows[0].encrypted_value, this.encryptionKey), expiresAt: rows[0].expires_at };
    } catch {
      throw new Error(`Failed to decrypt ${type} for channel ${channelId}. Check encryption key.`);
    }
  }

  /**
   * Retrieve and decrypt a credential for a channel.
   * @returns The decrypted plaintext value, or null if not found.
   */
  async getSecret(channelId: string, type: CredentialType): Promise<string | null> {
    return (await this.getCredential(channelId, type))?.value ?? null;
  }

  /** Get all decrypted credentials for a channel. */
  async getChannelCredentials(channelId: string): Promise<Record<string, string>> {
    const types: CredentialType[] = ['api_key', 'oauth_token', 'refresh_token'];

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
   */
  async getMetadata(
    channelId: string,
    type: CredentialType,
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
   * True if the token expires within `marginMs` (default 5 minutes), or has
   * already expired. False when no expiry is recorded.
   */
  async isTokenNearExpiry(
    channelId: string,
    type: 'oauth_token' | 'refresh_token',
    now: Date = new Date(),
    marginMs = 5 * 60 * 1000,
  ): Promise<boolean> {
    const rows = await this.db.query<{ expires_at: string | null }>(
      `SELECT expires_at FROM marketplace_credentials WHERE channel_id = ? AND credential_type = ?`,
      [channelId, type],
    );
    const expiresAt = rows[0]?.expires_at;
    if (!expiresAt) return false;

    return new Date(expiresAt).getTime() - now.getTime() < marginMs;
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
