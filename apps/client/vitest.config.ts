import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Unit tests for pure client logic (no DOM). Kept separate from vite.config.ts
// so tests don't pull in the app's build plugins.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  define: {
    "import.meta.env.API_BASE_URL": JSON.stringify("https://api.test"),
    "import.meta.env.MERCHANT_PK": JSON.stringify("pk_test"),
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
