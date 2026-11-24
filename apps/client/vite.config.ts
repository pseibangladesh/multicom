/**
 * Copyright (c) 2024-2026 Ronan LE MEILLAT
 * License: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

/* global process */
import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { githubPagesSpa } from "@sctg/vite-plugin-github-pages-spa";

import _package from "./package.json" with { type: "json" };

/**
 * Package.json type definition for React project
 *
 * Provides TypeScript typing for package.json structure with
 * common fields used in React applications
 */
export type PackageJson = {
  name: string;
  private: boolean;
  version: string;
  type: string;
  scripts: {
    dev: string;
    build: string;
    lint: string;
    "preview:env": string;
    [key: string]: string;
  };
  dependencies: {
    react: string;
    "react-dom": string;
    "react-router-dom": string;
    [key: string]: string;
  };
  devDependencies: {
    typescript: string;
    eslint: string;
    vite: string;
    [key: string]: string;
  };
};

const packageJson: PackageJson = _package;

/**
 * Extract dependencies with a specific vendor prefix
 *
 * @param packageJson - The package.json object
 * @param vendorPrefix - Vendor namespace prefix (e.g. "@heroui")
 * @returns Array of dependency names matching the vendor prefix
 *
 * Used for chunk optimization in the build configuration
 */
export function extractPerVendorDependencies(
  packageJson: PackageJson,
  vendorPrefix: string,
): string[] {
  const dependencies = Object.keys(packageJson.dependencies || {});

  return dependencies.filter((dependency) =>
    dependency.startsWith(`${vendorPrefix}/`),
  );
}

/**
 * Vite configuration
 * @see https://vitejs.dev/config/
 */
if (process.env.NODE_ENV === "development") {
  console.warn("Launching Vite in development mode, environment variables loaded (sensitive values hidden)", {
    STORE_URL: process.env.STORE_URL,
    API_BASE_URL: process.env.API_BASE_URL,
  });
}
export default defineConfig({
  base: process.env.VITE_BASE_PATH || "/",
  define: {
    "import.meta.env.API_BASE_URL": JSON.stringify(process.env.API_BASE_URL),
    "import.meta.env.MERCHANT_PK": JSON.stringify(process.env.MERCHANT_PK || "merchant_pk_placeholder"),
    // No fallback: it must match the backend's STORE_URL, and main.tsx shows an
    // "Environment Variables Missing" screen when it (or API_BASE_URL) is unset.
    "import.meta.env.STORE_URL": JSON.stringify(process.env.STORE_URL),
    "import.meta.env.STORE_NAME": JSON.stringify(process.env.STORE_NAME || "Bengal Exchange Store"),
    "import.meta.env.BENGAL_EXCHANGE_THEME": JSON.stringify(process.env.BENGAL_EXCHANGE_THEME ?? process.env.FUFUNI_THEME ?? "bengal"),
    // Variable for disabling the Cloudfare AI Gateway and using direct API calls instead, for testing and fallback purposes
    "import.meta.env.DISABLE_CLOUDFLARE_AIG": JSON.stringify(process.env.DISABLE_CLOUDFLARE_AIG === "true"),
  },
  resolve: {
    tsconfigPaths: true,
    dedupe: ["react", "react-dom"],
  },
  plugins: [react(), tailwindcss(), githubPagesSpa()],
  build: {
    // Inline assets smaller than 1KB
    // This is for demonstration purposes only
    // and should be adjusted based on the project requirements
    assetsInlineLimit: 1024,
    // Enable source maps for better debugging experience
    // This should be disabled in production for better performance and security
    sourcemap: true,
    rollupOptions: {
      output: {
        // Customizing the output file names
        assetFileNames: `assets/${packageJson.name}-[name]-[hash][extname]`,
        entryFileNames: `js/${packageJson.name}-[hash].js`,
        chunkFileNames: `js/${packageJson.name}-[hash].js`,
        /**
         * Manual chunk configuration for better code splitting
         *
         * Groups all @heroui dependencies into a single chunk
         * to optimize loading performance and avoid oversized chunks
         */
        manualChunks(id:string) {
          if (!id.includes("node_modules")) return;

          // Group core React + i18n dependencies into a single chunk
          if (
            [
              "react",
              "react-dom",
              "react-router-dom",
              "react-i18next",
              "i18next",
              "i18next-http-backend",
            ].some((name) => id.includes(`/node_modules/${name}/`))
          ) {
            return "react";
          }

          // Group Heroui packages together for better caching
          if (id.includes("/node_modules/@heroui/")) return "heroui";
        },
      },
    },
  },
});
