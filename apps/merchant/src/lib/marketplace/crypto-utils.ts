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

/**
 * Lightweight AES-GCM encryption / decryption that works in both Node.js ≥ 18
 * and Cloudflare Workers (Web Crypto API).
 *
 * Format: base64(IV || ciphertext) — no authentication tag prefix; the GCM tag
 * is appended automatically by the Web Crypto API.
 */

// ─── Encryption ──────────────────────────────────────────────────────────────

/**
 * Encrypt a plaintext string with AES-GCM using a UTF-8 passphrase.
 *
 * @param plaintext  The secret to encrypt (e.g. OAuth refresh token).
 * @param password   Passphrase — ideally ≥ 32 chars; derived via PBKDF2.
 * @returns Base64-encoded IV + ciphertext string.
 */
export async function encrypt(
  plaintext: string,
  password: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password);

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );

  // Pack IV + ciphertext into a single Uint8Array, then base64-encode.
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);
  return btoa(String.fromCharCode(...combined));
}

// ─── Decryption ──────────────────────────────────────────────────────────────

/**
 * Decrypt a base64-encoded AES-GCM payload.
 *
 * @param ciphertext  Base64 string from {@link encrypt}.
 * @param password    The same passphrase used during encryption.
 * @returns The original plaintext.
 */
export async function decrypt(
  ciphertext: string,
  password: string,
): Promise<string> {
  const combined = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));

  const iv = combined.slice(0, 12);
  const encrypted = combined.slice(12);

  const key = await deriveKey(password);

  const plaintextBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    encrypted,
  );

  return new TextDecoder().decode(plaintextBuffer);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Derive a 32-byte AES-GCM key from a passphrase via PBKDF2-SHA256. */
async function deriveKey(password: string): Promise<CryptoKey> {
  const pwBytes = new TextEncoder().encode(password);
  const baseKey = await crypto.subtle.importKey(
    'raw',
    pwBytes,
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(16), iterations: 100_000 },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ─── AWS Signature V4 ────────────────────────────────────────────────────────

/** Compute SHA-256 hex digest of a string payload. */
async function sha256Hex(payload: string): Promise<string> {
  const encoded = new TextEncoder().encode(payload);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Compute HMAC-SHA256. */
async function hmacSha256(key: string | Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = typeof key === 'string'
    ? await crypto.subtle.importKey('raw', new TextEncoder().encode(key), 'HMAC', false, ['sign'])
    : await crypto.subtle.importKey('raw', key, 'HMAC', false, ['sign']);
  const hashBuffer = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
  return new Uint8Array(hashBuffer);
}

/** Format a Date to AWS ISO8601 basic format (YYYYMMDDTHHMMSSZ). */
function formatDate(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '').split('.')[0] + 'Z';
}

/** Format a Date to AWS date only (YYYYMMDD). */
function formatDateShort(d: Date): string {
  return d.toISOString().split('T')[0].replace(/-/g, '');
}

/**
 * Generate AWS Signature V4 for an SP-API request.
 * Returns the Authorization header value and x-amz-content-sha256 hash.
 */
export async function signRequestV4(
  method: string,
  host: string,
  pathname: string,
  searchParams: URLSearchParams | Record<string, string>,
  awsCredentials: { accessKeyId: string; secretAccessKey: string; region: string },
  payloadHash: string,
): Promise<{ authorization: string; contentSha256: string }> {
  const now = new Date();
  const dateStamp = formatDateShort(now);

  // Canonical request components.
  const searchStr = Object.keys(searchParams).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent((searchParams as Record<string, string>)[k])}`).join('&');
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${formatDate(now)}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = [
    method,
    pathname,
    searchStr,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${awsCredentials.region}/execute-api/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${formatDate(now)}\n${scope}\n${await sha256Hex(canonicalRequest)}`;

  // HMAC signing chain.
  const kSecret = `AWS4${awsCredentials.secretAccessKey}`;
  let signature = await hmacSha256(kSecret, dateStamp);
  signature = await hmacSha256(signature, awsCredentials.region);
  signature = await hmacSha256(signature, 'execute-api');
  signature = await hmacSha256(signature, 'aws4_request');

  const authValue = `AWS4-HMAC-SHA256 Credential=${awsCredentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${Array.from(signature).map(b => b.toString(16).padStart(2, '0')).join('')}`;

  return {
    authorization: authValue,
    contentSha256: payloadHash,
  };
}
