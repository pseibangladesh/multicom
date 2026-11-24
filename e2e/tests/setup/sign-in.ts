import { expect, type Page } from "@playwright/test";
import * as fs from "fs";

/**
 * Produces the storage state (Better Auth session cookie) for one account.
 *
 * - With `<prefix>_EMAIL` and `<prefix>_PASSWORD` set, signs in through the
 *   storefront /login page and saves the session to `fixturePath`.
 * - Otherwise an existing `fixturePath` file is reused.
 *
 * The account must have a confirmed email (sign-in is refused otherwise);
 * emails listed in ADMIN_EMAILS are confirmed automatically.
 */
export async function signInOrReuse(page: Page, prefix: string, fixturePath: string) {
  const email = process.env[`${prefix}_EMAIL`];
  const password = process.env[`${prefix}_PASSWORD`];

  if (email && password) {
    await page.goto("login");
    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').fill(password);
    await page.locator('form button[type="submit"]').click();
    // Signed in → the login page moves on to the account page.
    await page.waitForURL(/\/account/, { timeout: 15_000 });
    await page.context().storageState({ path: fixturePath });

    return;
  }

  if (!fs.existsSync(fixturePath)) {
    throw new Error(
      `No session for ${prefix}: set ${prefix}_EMAIL and ${prefix}_PASSWORD ` +
        `(a confirmed account), or provide ${fixturePath}.`,
    );
  }
  const state = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));

  expect(state.cookies?.length ?? 0).toBeGreaterThan(0);
}
