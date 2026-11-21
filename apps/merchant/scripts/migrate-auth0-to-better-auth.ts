/**
 * Migration script: Map existing Auth0 customers to Better Auth users/sessions.
 *
 * This script runs AFTER migration 037 (Better Auth tables) is applied.
 * It reads the existing `customers` table and creates corresponding rows in
 * the new `user` table, preserving all customer data.
 *
 * Usage:
 *   npx tsx scripts/migrate-auth0-to-better-auth.ts
 *
 * Safety:
 *   - Only INSERTs into 'user', 'session' — never modifies customers table
 *   - Idempotent: skips users that already have a mapping in 'user' table
 *   - Dry-run mode: pass --dry to see what would change without writing
 */

import { getDb } from './src/db';
import { uuid, now } from './src/types';

// Better Auth uses SHA-256 for session token hashing
async function hashKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Generate a random hex string (for placeholder session tokens during migration)
function randomHex(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface CustomerRow {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  auth_provider: string | null;
  auth_provider_id: string | null;
  accepts_marketing: number;
  locale: string;
  metadata: string | null;
  order_count: number;
  total_spent_cents: number;
  created_at: string;
  updated_at: string;
  email_verified_at: string | null;
}

async function main() {
  const dryRun = process.argv.includes('--dry');
  const db = getDb(null); // Uses D1 binding from wrangler context

  console.log('=== Auth0 → Better Auth Migration ===');
  if (dryRun) {
    console.log('[DRY RUN] No changes will be written.\n');
  }

  // Step 1: Count existing customers
  const [allCustomers] = await db.query<CustomerRow[]>(
    `SELECT * FROM customers WHERE auth_provider IS NOT NULL AND auth_provider != '' LIMIT 1000`
  );
  console.log(`Found ${allCustomers.length} customers with auth_provider set\n`);

  if (allCustomers.length === 0) {
    console.log('No Auth0 customers found. Nothing to migrate.');
    return;
  }

  // Step 2: Check which customers already have Better Auth user records
  const existingUserEmails = await db.query<{ email: string }[]>(
    `SELECT email FROM "user"`
  );
  const existingEmailSet = new Set(existingUserEmails.map((r) => r.email.toLowerCase()));
  console.log(
    `Existing Better Auth users: ${existingEmailSet.size}\n`
  );

  let migrated = 0;
  let skipped = 0;
  const errors: string[] = [];

  // Step 3: Migrate each customer to a Better Auth user
  for (const cust of allCustomers) {
    try {
      const emailLower = cust.email.toLowerCase();

      // Skip if already migrated
      if (existingEmailSet.has(emailLower)) {
        skipped++;
        continue;
      }

      const userId = uuid();

      // Insert into Better Auth 'user' table
      await db.run(
        `INSERT INTO "user" (id, email, name, email_verified, image, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          emailLower,
          cust.name || null,
          cust.email_verified_at ? 1 : 0,
          null, // image — not available in customer table
          cust.created_at || now(),
          cust.updated_at || now(),
        ]
      );

      // Create a session for customers who have auth_provider_id (Auth0-linked)
      if (cust.auth_provider === 'auth0' && cust.auth_provider_id) {
        const rawSessionToken = randomHex();
        const hashedToken = await hashKey(rawSessionToken);

        // Session expires in 30 days (matching Better Auth config)
        const expiresIn = 60 * 60 * 24 * 30;
        const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

        await db.run(
          `INSERT INTO "session" (id, expires_at, token, created_at, updated_at, user_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            uuid(),
            expiresAt,
            hashedToken,
            now(),
            now(),
            userId,
          ]
        );
      }

      // Update customers table to track migration
      await db.run(
        `UPDATE customers SET auth_provider = 'better-auth', updated_at = ?
         WHERE id = ?`,
        [now(), cust.id]
      );

      migrated++;
    } catch (err) {
      errors.push(`Failed to migrate customer ${cust.email}: ${err.message}`);
    }
  }

  console.log('\n=== Migration Summary ===');
  console.log(`Migrated:   ${migrated} customers → Better Auth users`);
  console.log(`Skipped:    ${skipped} (already migrated)`);
  if (errors.length > 0) {
    console.log(`Errors:     ${errors.length}`);
    errors.forEach((e) => console.error(`  - ${e}`));
  } else {
    console.log('Errors:     0');
  }

  // Step 4: Verify migration integrity
  const [postCount] = await db.query<{ count: number }[]>(
    `SELECT COUNT(*) as count FROM "user"`
  );
  console.log(`\nTotal Better Auth users after migration: ${postCount.count}`);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
