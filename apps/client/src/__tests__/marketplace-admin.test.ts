import { describe, expect, it } from "vitest";

import enUS from "@/locales/base/en-US.json";
import frFR from "@/locales/base/fr-FR.json";
import esES from "@/locales/base/es-ES.json";
import arSA from "@/locales/base/ar-SA.json";
import heIL from "@/locales/base/he-IL.json";
import zhCN from "@/locales/base/zh-CN.json";
import {
  buildConfigPatch,
  ebayFormFromConfig,
  etsyFormFromConfig,
  connectReturnUrl,
  hasRunningJob,
  isConflictError,
  missingListingFields,
  oauthReturnMessageKey,
  parseServerDate,
  readOAuthReturn,
  summarizeImport,
  validateConfigForm,
} from "@/lib/marketplace-admin";

describe("formFromConfig", () => {
  it("reads Etsy listing_defaults into string fields", () => {
    expect(
      etsyFormFromConfig({
        shop_id: "31337",
        default_carrier: "usps",
        listing_defaults: {
          taxonomy_id: 1027,
          shipping_profile_id: 555,
          is_supply: false,
        },
      }),
    ).toEqual({
      default_carrier: "usps",
      taxonomy_id: "1027",
      shipping_profile_id: "555",
      readiness_state_id: "",
      return_policy_id: "",
      who_made: "",
      when_made: "",
      is_supply: "false",
    });
  });

  it("reads eBay listing policies and tolerates a missing/garbage listing", () => {
    expect(
      ebayFormFromConfig({
        listing: { category_id: "9355" },
        marketplace_id: "EBAY_GB",
      }),
    ).toMatchObject({
      category_id: "9355",
      marketplace_id: "EBAY_GB",
      payment_policy_id: "",
    });
    expect(ebayFormFromConfig({ listing: "nope" }).category_id).toBe("");
  });
});

describe("buildConfigPatch", () => {
  const original = etsyFormFromConfig({
    default_carrier: "usps",
    listing_defaults: { taxonomy_id: 1, shipping_profile_id: 2 },
  });

  it("sends only changed fields, converting ids and booleans, nested under listing_defaults", () => {
    const form = {
      ...original,
      shipping_profile_id: " 77 ",
      is_supply: "true" as const,
    };

    expect(buildConfigPatch("etsy", form, original)).toEqual({
      listing_defaults: { shipping_profile_id: 77, is_supply: true },
    });
  });

  it("sends null for cleared fields so the backend deletes them", () => {
    expect(
      buildConfigPatch(
        "etsy",
        { ...original, default_carrier: "", taxonomy_id: "" },
        original,
      ),
    ).toEqual({
      default_carrier: null,
      listing_defaults: { taxonomy_id: null },
    });
  });

  it("returns null when nothing changed (whitespace-only edits included)", () => {
    expect(
      buildConfigPatch(
        "etsy",
        { ...original, default_carrier: "usps  " },
        original,
      ),
    ).toBeNull();
  });

  it("nests eBay policies under listing and keeps strings as strings", () => {
    const o = ebayFormFromConfig({});

    expect(
      buildConfigPatch(
        "ebay",
        { ...o, category_id: "9355", marketplace_id: "EBAY_US" },
        o,
      ),
    ).toEqual({
      marketplace_id: "EBAY_US",
      listing: { category_id: "9355" },
    });
  });
});

describe("validateConfigForm", () => {
  it("accepts an empty form (every field is optional)", () => {
    expect(validateConfigForm("etsy", etsyFormFromConfig({}))).toEqual({});
    expect(validateConfigForm("ebay", ebayFormFromConfig({}))).toEqual({});
  });

  it("mirrors the backend rules for Etsy", () => {
    const form = {
      ...etsyFormFromConfig({}),
      taxonomy_id: "0",
      shipping_profile_id: "1.5",
      readiness_state_id: "abc",
      when_made: "yesterday",
    };

    expect(validateConfigForm("etsy", form)).toEqual({
      taxonomy_id: "admin-marketplaces-error-positive-int",
      shipping_profile_id: "admin-marketplaces-error-positive-int",
      readiness_state_id: "admin-marketplaces-error-positive-int",
      when_made: "admin-marketplaces-error-when-made",
    });
    for (const ok of ["made_to_order", "2020_2026", "before_2007", "1990s"]) {
      expect(
        validateConfigForm("etsy", {
          ...etsyFormFromConfig({}),
          when_made: ok,
        }),
      ).toEqual({});
    }
  });

  it("mirrors the backend rules for eBay", () => {
    const form = {
      ...ebayFormFromConfig({}),
      marketplace_id: "US",
      content_language: "english",
    };

    expect(validateConfigForm("ebay", form)).toEqual({
      marketplace_id: "admin-marketplaces-error-marketplace-id",
      content_language: "admin-marketplaces-error-content-language",
    });
  });
});

describe("missingListingFields", () => {
  it("lists required fields that are still blank", () => {
    expect(
      missingListingFields("etsy", {
        ...etsyFormFromConfig({}),
        taxonomy_id: "1",
      }),
    ).toEqual(["shipping_profile_id"]);
    expect(missingListingFields("ebay", ebayFormFromConfig({}))).toHaveLength(
      5,
    );
  });
});

describe("OAuth return", () => {
  it("parses the callback redirect params", () => {
    expect(
      readOAuthReturn("?marketplace=etsy&result=connected&channelId=ch1"),
    ).toEqual({
      platform: "etsy",
      result: "connected",
      error: null,
      channelId: "ch1",
    });
    expect(
      readOAuthReturn("?marketplace=ebay&result=error&error=shop_mismatch")
        ?.error,
    ).toBe("shop_mismatch");
  });

  it("ignores unrelated or malformed query strings", () => {
    expect(readOAuthReturn("")).toBeNull();
    expect(readOAuthReturn("?result=connected")).toBeNull();
    expect(readOAuthReturn("?marketplace=etsy&result=weird")).toBeNull();
  });

  it("maps outcomes to messages", () => {
    const base = { platform: "etsy", error: null, channelId: null };

    expect(oauthReturnMessageKey({ ...base, result: "connected" })).toBe(
      "admin-marketplaces-connected",
    );
    expect(oauthReturnMessageKey({ ...base, result: "denied" })).toBe(
      "admin-marketplaces-connect-denied",
    );
    expect(
      oauthReturnMessageKey({
        ...base,
        result: "error",
        error: "shop_mismatch",
      }),
    ).toBe("admin-marketplaces-connect-shop-mismatch");
    expect(
      oauthReturnMessageKey({
        ...base,
        result: "error",
        error: "token_exchange_failed",
      }),
    ).toBe("admin-marketplaces-connect-failed");
  });

  it("builds the return URL under the app base path", () => {
    expect(connectReturnUrl("https://shop.test", "")).toBe(
      "https://shop.test/admin/marketplaces",
    );
    expect(connectReturnUrl("https://x.github.io", "/fufuni/")).toBe(
      "https://x.github.io/fufuni/admin/marketplaces",
    );
  });
});

describe("misc", () => {
  it("summarizes an order import response", () => {
    expect(
      summarizeImport({
        fetched: 3,
        imported: [1, 2],
        skipped: [1],
        failed: [],
        shortfalls: [1],
        unmatchedSkus: [],
      }),
    ).toEqual({
      fetched: 3,
      imported: 2,
      skipped: 1,
      failed: 0,
      shortfalls: 1,
      unmatched: 0,
    });
  });

  it("parses SQLite UTC timestamps", () => {
    expect(parseServerDate("2026-11-22 10:00:00")?.toISOString()).toBe(
      "2026-11-22T10:00:00.000Z",
    );
    expect(parseServerDate("2026-11-22T10:00:00.000Z")?.toISOString()).toBe(
      "2026-11-22T10:00:00.000Z",
    );
    expect(parseServerDate(null)).toBeNull();
    expect(parseServerDate("garbage")).toBeNull();
  });
});

describe("background jobs", () => {
  const ch = (status: string | null) =>
    ({
      lastJob: status
        ? { type: "push_products", status, error: null, updatedAt: null }
        : null,
    }) as unknown as Parameters<typeof hasRunningJob>[0][number];

  it("polls only while some channel has a pending or running job", () => {
    expect(hasRunningJob([ch("completed"), ch(null)])).toBe(false);
    expect(hasRunningJob([ch("failed"), ch("pending")])).toBe(true);
    expect(hasRunningJob([ch("in_progress")])).toBe(true);
  });

  it("recognises a 409 from useSecuredApi", () => {
    expect(isConflictError(new Error("HTTP 409"))).toBe(true);
    expect(isConflictError(new Error("HTTP 4090"))).toBe(false);
    expect(isConflictError(new Error("HTTP 500"))).toBe(false);
    expect(isConflictError("HTTP 409")).toBe(false);
  });
});

describe("marketplace i18n keys", () => {
  const locales = {
    "en-US": enUS,
    "fr-FR": frFR,
    "es-ES": esES,
    "ar-SA": arSA,
    "he-IL": heIL,
    "zh-CN": zhCN,
  } as Record<string, Record<string, string>>;
  const keys = Object.keys(enUS).filter((k) =>
    k.startsWith("admin-marketplaces-"),
  );

  it("has the keys the page builds dynamically", () => {
    for (const job of [
      "pull_orders",
      "push_products",
      "push_inventory",
      "sync_all",
    ]) {
      expect(keys).toContain(
        `admin-marketplaces-job-${job.replace(/_/g, "-")}`,
      );
    }
  });

  it.each(Object.keys(locales))(
    "%s has every marketplace key with the same placeholders",
    (lang) => {
      const placeholders = (s: string) => (s.match(/{{\w+}}/g) ?? []).sort();

      for (const k of keys) {
        expect(locales[lang][k], `${lang} ${k}`).toBeTruthy();
        expect(placeholders(locales[lang][k]), `${lang} ${k}`).toEqual(
          placeholders(enUS[k as keyof typeof enUS] as string),
        );
      }
    },
  );
});
