import { describe, expect, it } from "vitest";

import { createModeController, resolveMode } from "@/lib/theme";

describe("resolveMode", () => {
  it("uses the stored mode, else dark (the brand default)", () => {
    expect(resolveMode("dark")).toBe("dark");
    expect(resolveMode("light")).toBe("light");
    expect(resolveMode(null)).toBe("dark");
  });

  it("ignores a stored value that is not a mode", () => {
    expect(resolveMode("luxury")).toBe("dark");
  });
});

describe("createModeController", () => {
  function fakes(stored: string | null) {
    const store = new Map<string, string>();

    if (stored !== null) store.set("theme", stored);
    const applied: string[] = [];

    return {
      store,
      applied,
      deps: {
        storage: {
          get: (k: string) => store.get(k) ?? null,
          set: (k: string, v: string) => void store.set(k, v),
          remove: (k: string) => void store.delete(k),
        },
        apply: (m: "light" | "dark") => void applied.push(m),
      },
    };
  }

  it("starts dark and saves nothing until the user chooses", () => {
    const f = fakes(null);
    const c = createModeController(f.deps);

    expect(c.mode()).toBe("dark");
    expect(f.store.has("theme")).toBe(false);
  });

  it("saves an explicit choice", () => {
    const f = fakes(null);
    const c = createModeController(f.deps);

    c.choose("light");
    expect(f.store.get("theme")).toBe("light");
    expect(c.mode()).toBe("light");
    expect(f.applied.at(-1)).toBe("light");
  });

  it("keeps a choice saved on an earlier visit", () => {
    const f = fakes("light");

    expect(createModeController(f.deps).mode()).toBe("light");
  });
});

describe("createModeController — other tabs and old data", () => {
  function setup(entries: Record<string, string>) {
    const store = new Map(Object.entries(entries));
    const applied: string[] = [];
    const c = createModeController({
      storage: {
        get: (k) => store.get(k) ?? null,
        set: (k, v) => void store.set(k, v),
        remove: (k) => void store.delete(k),
      },
      apply: (m) => void applied.push(m),
    });

    return { c, store, applied };
  }

  it("sync() adopts a choice saved by another tab", () => {
    const { c, store, applied } = setup({});

    store.set("theme", "dark");
    c.sync();
    expect(c.mode()).toBe("dark");
    expect(applied.at(-1)).toBe("dark");
  });

  it("treats an old luxury-dark theme as a dark choice and migrates it once", () => {
    const { c, store } = setup({ "ui-theme": "luxury-dark", theme: "light" });

    expect(c.mode()).toBe("dark");
    expect(store.get("theme")).toBe("dark");
    expect(store.has("ui-theme")).toBe(false);
  });

  it("drops a light old theme slug without changing the mode", () => {
    const { c, store } = setup({ "ui-theme": "luxury" });

    expect(c.mode()).toBe("dark"); // nothing chosen: the default
    expect(store.has("theme")).toBe(false);
    expect(store.has("ui-theme")).toBe(false);
  });
});
