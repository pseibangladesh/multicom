import { describe, expect, it } from "vitest";

import { missingEnvVars } from "@/lib/env-check";

describe("missingEnvVars", () => {
  it("passes when both URLs are set", () => {
    expect(
      missingEnvVars({
        API_BASE_URL: "http://localhost:8787",
        STORE_URL: "http://localhost:5173",
      }),
    ).toEqual([]);
  });

  it("flags unset, empty, whitespace and the literal 'undefined' (what a failed `source .env` leaves)", () => {
    expect(missingEnvVars({})).toEqual(["API_BASE_URL", "STORE_URL"]);
    expect(
      missingEnvVars({ API_BASE_URL: "  ", STORE_URL: "undefined" }),
    ).toEqual(["API_BASE_URL", "STORE_URL"]);
    expect(
      missingEnvVars({ API_BASE_URL: "http://x", STORE_URL: undefined }),
    ).toEqual(["STORE_URL"]);
  });
});
