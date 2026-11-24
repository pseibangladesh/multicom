import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");
// Tokens with no bx-* colour utility (see globals.css @theme inline).
const NO_UTILITY = new Set(["--bx-scrim"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);

    if (statSync(p).isDirectory()) return name === "locales" ? [] : files(p);

    return /\.tsx?$/.test(name) ? [p] : [];
  });
}

describe("Bengal colour utilities (CLAUDE.md)", () => {
  it("uses bg-bx-*/text-bx-*/border-bx-* instead of raw var(--bx-*) classes", () => {
    const offenders: string[] = [];

    for (const f of files(SRC)) {
      for (const m of readFileSync(f, "utf8").matchAll(/\[var\((--bx-[a-z-]+)\)\]/g)) {
        if (!NO_UTILITY.has(m[1])) offenders.push(`${f.replace(SRC, "src")}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
