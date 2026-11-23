import { test as setup } from "@playwright/test";
import * as path from "path";

import { signInOrReuse } from "./sign-in";

const FIXTURE_PATH = path.join(__dirname, "../../fixtures/storage-state-admin.json");

// E2E_ADMIN_EMAIL must be listed in ADMIN_EMAILS.
setup("sign in as an admin", async ({ page }) => {
  await signInOrReuse(page, "E2E_ADMIN", FIXTURE_PATH);
});
