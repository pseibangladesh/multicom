/// <reference types="node" />
/**
 * Minimal axe-core check for e2e tests: injects the axe-core build that is
 * already installed at the repo root (no extra dependency) and returns the
 * serious and critical violations.
 */
import path from "node:path";

import type { Page } from "@playwright/test";

// Playwright runs specs from the e2e folder; axe-core lives in the root node_modules.
const AXE = path.resolve(__dirname, "../../node_modules/axe-core/axe.min.js");

export interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  targets: string[];
}

export async function seriousAxeViolations(page: Page): Promise<AxeViolation[]> {
  await page.addScriptTag({ path: AXE });

  return page.evaluate(async () => {
    // axe is a global injected above.
    const axe = (window as unknown as { axe: { run: (ctx: Document, opts: object) => Promise<{ violations: Array<{ id: string; impact: string | null; help: string; nodes: Array<{ target: unknown[] }> }> }> } }).axe;
    const result = await axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });

    return result.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        targets: v.nodes.map((n) => String(n.target[0])),
      }));
  });
}
