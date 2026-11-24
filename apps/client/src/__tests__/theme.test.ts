import { describe, expect, it } from "vitest";

import {
  createModeController,
  resolveMode,
} from "@/lib/theme";

describe("resolveMode", () => {
  it("uses the stored mode, else the system preference", () => {
    expect(resolveMode("dark", false)).toBe("dark");
    expect(resolveMode("light", true)).toBe("light");
    expect(resolveMode(null, true)).toBe("dark");
    expect(resolveMode(null, false)).toBe("light");
  });

  it("ignores a stored value that is not a mode", () => {
    expect(resolveMode("luxury-dark", false)).toBe("light");
    expect(resolveMode("luxury-dark", true)).toBe("dark");
  });
});

describe("createModeController", () => {
  function fakes(stored: string | null, prefersDark: boolean) {
    const store = new Map<string, string>();

    if (stored !== null) store.set("theme", stored);
    const listeners: ((dark: boolean) => void)[] = [];
    const applied: string[] = [];

    return {
      store,
      applied,
      setSystem: (dark: boolean) => listeners.forEach((l) => l(dark)),
      deps: {
        storage: {
          get: (k: string) => store.get(k) ?? null,
          set: (k: string, v: string) => void store.set(k, v),
          remove: (k: string) => void store.delete(k),
        },
        prefersDark: () => prefersDark,
        onSystemChange: (l: (dark: boolean) => void) => {
          listeners.push(l);

          return () => void listeners.splice(listeners.indexOf(l), 1);
        },
        apply: (m: "light" | "dark") => void applied.push(m),
      },
    };
  }

  it("does not save anything until the user chooses", () => {
    const f = fakes(null, true);
    const c = createModeController(f.deps);

    expect(c.mode()).toBe("dark");
    expect(f.store.has("theme")).toBe(false);
  });

  it("follows a later system change when nothing was chosen", () => {
    const f = fakes(null, false);
    const c = createModeController(f.deps);

    f.setSystem(true);
    expect(c.mode()).toBe("dark");
    expect(f.applied.at(-1)).toBe("dark");
    expect(f.store.has("theme")).toBe(false);
  });

  it("saves an explicit choice and then ignores system changes", () => {
    const f = fakes(null, false);
    const c = createModeController(f.deps);

    c.choose("dark");
    expect(f.store.get("theme")).toBe("dark");
    f.setSystem(false);
    expect(c.mode()).toBe("dark");
  });

  it("keeps a choice saved on an earlier visit", () => {
    const f = fakes("light", true);
    const c = createModeController(f.deps);

    f.setSystem(true);
    expect(c.mode()).toBe("light");
  });
});

describe("createModeController — other tabs and old data", () => {
  function setup(entries: Record<string, string>, prefersDark = false) {
    const store = new Map(Object.entries(entries));
    const applied: string[] = [];
    const c = createModeController({
      storage: {
        get: (k) => store.get(k) ?? null,
        set: (k, v) => void store.set(k, v),
        remove: (k) => void store.delete(k),
      },
      prefersDark: () => prefersDark,
      onSystemChange: () => () => undefined,
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
    const { c, store } = setup({ "ui-theme": "luxury" }, true);

    expect(c.mode()).toBe("dark"); // system decides, nothing chosen
    expect(store.has("theme")).toBe(false);
    expect(store.has("ui-theme")).toBe(false);
  });
});
