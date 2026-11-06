import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import { ROUTES, gotoOrFixme, setTheme } from "./helpers";

const results: Record<string, unknown> = {};
test.afterAll(() => {
  fs.mkdirSync("artifacts", { recursive: true });
  fs.writeFileSync("artifacts/a11y.json", JSON.stringify(results, null, 2));
});

for (const route of ROUTES) {
  for (const theme of ["dark", "light"] as const) {
    test(`a11y ${route} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await gotoOrFixme(page, route);
      await setTheme(page, theme);
      const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const key = `${route}#${theme}`;
      results[key] = r.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary?.split("\n").slice(0, 3).join(" ") })),
      }));
      const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(
        bad.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`),
        "serious/critical axe violations",
      ).toEqual([]);
    });
  }
}
