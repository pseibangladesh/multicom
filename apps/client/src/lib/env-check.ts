/**
 * Build-time variables the app cannot run without. Vite inlines them from the
 * shell environment (see vite.config.ts `define`), so a broken `.env` (e.g. an
 * unquoted value with spaces, which makes `source .env` fail) leaves them
 * undefined.
 */
export const REQUIRED_ENV_VARS = ["API_BASE_URL", "STORE_URL"] as const;

export type RequiredEnvVar = (typeof REQUIRED_ENV_VARS)[number];

/** Names of required variables that are unset, empty, or the literal "undefined". */
export function missingEnvVars(
  env: Partial<Record<string, unknown>>,
): RequiredEnvVar[] {
  return REQUIRED_ENV_VARS.filter((name) => {
    const value = env[name];

    return (
      typeof value !== "string" ||
      value.trim() === "" ||
      value.trim() === "undefined"
    );
  });
}
