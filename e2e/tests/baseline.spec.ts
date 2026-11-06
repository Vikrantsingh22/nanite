import { test, expect } from "@playwright/test";
import { ROUTES, VIEWPORTS, slug, gotoOrFixme } from "./helpers";

// Opt-in pixel comparison: `--project=baseline` (create with --update-snapshots).
for (const route of ROUTES) {
  for (const vp of VIEWPORTS) {
    test(`baseline ${route} @${vp.width}`, async ({ page }) => {
      await page.setViewportSize(vp);
      await gotoOrFixme(page, route);
      await expect(page).toHaveScreenshot(`${slug(route)}-${vp.width}.png`, { fullPage: true });
    });
  }
}
