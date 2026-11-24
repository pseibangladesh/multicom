import { test as setup } from "@playwright/test";
import * as path from "path";

import { signInOrReuse } from "./sign-in";

const FIXTURE_PATH = path.join(__dirname, "../../fixtures/storage-state-user.json");

setup("sign in as a customer", async ({ page }) => {
  await signInOrReuse(page, "E2E_USER", FIXTURE_PATH);
});
