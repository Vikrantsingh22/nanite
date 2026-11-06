import { test, expect, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import { gotoOrFixme, watchProblems } from "./helpers";
import { domainSummary, handleDomain, newDomainState, type DomainMockState } from "./domain-mock";

const API = "http://localhost:4000"; // NEXT_PUBLIC_API_BASE_URL as baked into the web container
const WALLET = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const OUT = "artifacts/onboarding";

/** Signed-in user at the username-claimed state; only the custom-domain endpoints are interesting. */
function fakeApi(page: Page, d: DomainMockState, initial: "name_claimed" | "done" = "name_claimed") {
  const s = { state: initial as "name_claimed" | "done", completed: 0 };
  const me = () => ({ wallet: WALLET, username: "demo", ensName: "demo.nanitecom.eth", onboardingState: s.state, hasKeys: true, domain: domainSummary(d) });
  return {
    s,
    install: () =>
      page.route(`${API}/**`, async (route: Route) => {
        const req = route.request();
        const origin = req.headers()["origin"] ?? "*";
        const cors = { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,DELETE,OPTIONS" };
        const json = (status: number, body: unknown) => route.fulfill({ status, headers: cors, contentType: "application/json", body: JSON.stringify(body) });
        if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
        const path = new URL(req.url()).pathname;
        if (path === "/me") return json(200, me());
        if (path === "/onboarding/status") {
          return json(200, { onboardingState: s.state, hasKeys: true, username: "demo", ensName: "demo.nanitecom.eth", canClaim: true, claim: { status: "done", username: "demo", steps: [], error: null }, domain: domainSummary(d), sharedMailDomain: "nanitecom.itsvikrant.tech" });
        }
        if (path === "/agents") return json(200, { agents: [] });
        const dom = handleDomain(d, path, req.method(), req.method() === "GET" || req.method() === "DELETE" ? null : req.postDataJSON());
        if (dom) return route.fulfill({ status: dom.status, headers: { ...cors, ...(dom.headers ?? {}) }, contentType: "application/json", body: JSON.stringify(dom.body) });
        if (path === "/onboarding/complete") {
          // the domain is optional: completing never needs a verified one
          s.state = "done";
          s.completed++;
          return json(200, { onboardingState: "done" });
        }
        return json(404, { error: "not_found" });
      }),
  };
}

/** Like helpers.setTheme, but without requestAnimationFrame (the page clock is paused, so rAF never fires). */
async function setThemeNoRaf(page: Page, theme: "dark" | "light") {
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate((t) => {
    document.documentElement.classList.toggle("dark", t === "dark");
    document.documentElement.setAttribute("data-theme", t);
    document.documentElement.style.colorScheme = t;
  }, theme);
  await page.waitForTimeout(500); // real time: lets colour transitions finish before axe samples colours
}

/** Pauses the fake page clock one second from "now" as the page sees it. */
const pause = async (page: Page) => {
  const at = await page.evaluate(() => Date.now() + 1000);
  await page.clock.pauseAt(at).catch(() => undefined);
};

async function axe(page: Page, label: string) {
  await page.clock.resume(); // axe uses timers; a paused fake clock would hang it
  for (const theme of ["dark", "light"] as const) {
    await setThemeNoRaf(page, theme);
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical" || v.impact === "moderate");
    expect(bad.map((v) => `${label} ${theme}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
  }
  await setThemeNoRaf(page, "dark");
  await pause(page);
}

/** Fake page clock (so 5 s polls take no real time), paused right after load: only fastForward moves time. */
async function open(page: Page, d: DomainMockState, route = "/onboarding", initial: "name_claimed" | "done" = "name_claimed") {
  const api = fakeApi(page, d, initial);
  await api.install();
  await page.clock.install();
  await gotoOrFixme(page, route);
  await pause(page);
  return api;
}

const shot = (page: Page, name: string, width: number) => page.screenshot({ path: `${OUT}/${name}-${width}.png`, fullPage: true });
const rows = (page: Page) => page.getByTestId("dns-record");
const poll = async (page: Page, d: DomainMockState, ms = 5000) => {
  const before = d.polls;
  await page.clock.fastForward(ms);
  await expect.poll(() => d.polls).toBeGreaterThan(before);
  await page.waitForTimeout(150); // real time: lets the client schedule its next poll before time moves again
};

test.beforeEach(() => fs.mkdirSync(OUT, { recursive: true }));

test("entry: check shows the provider, warnings and a subdomain suggestion; create shows the records", async ({ page }) => {
  const problems = watchProblems(page);
  const d = newDomainState();
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, d);
  await expect(page.getByRole("listitem").filter({ hasText: "04 domain" })).toHaveAttribute("aria-current", "step");
  await page.getByRole("button", { name: /use my own domain/i }).click();
  await expect(page.getByRole("heading", { name: /add your mail domain/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /check domain/i })).toBeDisabled();
  await expect(page.getByText(/up to 72 hours/)).toBeVisible();

  await page.locator("#domain-name").fill("Example.com");
  await page.getByRole("button", { name: /check domain/i }).click();
  const check = page.getByTestId("domain-check");
  await expect(check.getByText("DNS: Cloudflare")).toBeVisible();
  await expect(check.getByText(/already receives mail/)).toBeVisible();
  await expect(check.getByText("mail.example.com", { exact: true })).toBeVisible();
  for (const w of [1440, 390]) {
    await page.setViewportSize({ width: w, height: w === 390 ? 844 : 900 });
    await shot(page, "08-domain-entry", w);
  }
  await axe(page, "domain entry");

  // taken domains show the server's message
  await page.locator("#domain-name").fill("taken.com");
  await page.getByRole("button", { name: /check domain/i }).click();
  await expect(page.getByText("That domain is already used by another account.")).toBeVisible();

  // take the suggestion, then create
  await page.locator("#domain-name").fill("example.com");
  await page.getByRole("button", { name: /check domain/i }).click();
  await page.getByRole("button", { name: /use mail\.example\.com/i }).click();
  await expect(page.getByRole("button", { name: /^add mail\.example\.com$/i })).toBeVisible();
  await page.getByRole("button", { name: /^add mail\.example\.com$/i }).click();
  await expect(page.getByRole("heading", { name: /add these dns records/i })).toBeVisible();
  expect(d.createBody).toEqual({ name: "mail.example.com" });
  await expect(rows(page)).toHaveCount(5);
  // the only expected failure is the designed 409 for the taken domain
  expect(problems.filter((p) => !/\/me\b|401|409/.test(p))).toEqual([]);
});

test("records: type, host, value, priority, copy buttons, provider tips; resumes after a reload", async ({ page }) => {
  // The test origin (http://web:3000) is not a secure context, so there is no navigator.clipboard: stub it and record what was written.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void ((window as unknown as { __clip?: string }).__clip = t) } });
  });
  const clip = () => page.evaluate(() => (window as unknown as { __clip?: string }).__clip);
  const d = newDomainState();
  Object.assign(d, { exists: true, name: "mail.example.com", stage: 0 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, d);
  await expect(page.getByRole("heading", { name: /add these dns records/i })).toBeVisible();
  await expect(rows(page)).toHaveCount(5);

  const dkim = page.locator('[data-record="TXT|resend._domainkey.mail"]');
  await expect(dkim.getByText("TXT", { exact: true })).toBeVisible();
  await expect(dkim.getByText("DKIM", { exact: true })).toBeVisible();
  await expect(dkim.getByText("resend._domainkey.mail", { exact: true })).toBeVisible();
  await expect(dkim.getByText("waiting")).toBeVisible();
  const recv = page.locator('[data-record="MX|mail"]');
  await expect(recv.getByText("receive-apne1.forge.rmta.net")).toBeVisible();
  await expect(recv.getByText("10", { exact: true })).toBeVisible();
  await expect(page.getByTestId("domain-progress")).toContainText("0/5 records found");
  await expect(page.getByTestId("provider-tips")).toContainText("DNS only");
  await expect(page.getByTestId("provider-tips")).toContainText("priority 10");

  // copy buttons copy exactly that cell
  await dkim.getByRole("button", { name: /copy host of the dkim txt record/i }).click();
  await expect(dkim.getByRole("button", { name: /host of the dkim txt record copied/i })).toBeVisible();
  expect(await clip()).toBe("resend._domainkey.mail");
  await dkim.getByRole("button", { name: /copy value of the dkim txt record/i }).click();
  expect(await clip()).toMatch(/^p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKB/);
  await recv.getByRole("button", { name: /copy priority of the receiving mx record/i }).click();
  expect(await clip()).toBe("10");

  for (const w of [1440, 390]) {
    await page.setViewportSize({ width: w, height: w === 390 ? 844 : 900 });
    await expect(page.locator("html")).toHaveJSProperty("scrollWidth", await page.evaluate(() => document.documentElement.clientWidth));
    await shot(page, "09-domain-records", w);
  }
  await axe(page, "domain records");

  // resume: reload mid-way and the wizard is on the same step with the current state
  d.stage = 2;
  await page.reload();
  await pause(page);
  await expect(page.getByRole("heading", { name: /add these dns records/i })).toBeVisible();
  await expect(page.getByTestId("domain-progress")).toContainText("5/5 records found");
  await expect(page.getByRole("heading", { name: /add your mail domain/i })).toHaveCount(0);
});

test("polling flips each record waiting -> found in DNS -> verified, announces changes, then Continue reaches done", async ({ page }) => {
  const d = newDomainState();
  Object.assign(d, { exists: true, name: "mail.example.com", stage: 0 });
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await open(page, d);
  await expect(page.getByTestId("domain-progress")).toContainText("0/5 records found");

  d.stage = 1;
  await poll(page, d);
  await expect(page.getByTestId("domain-progress")).toContainText("2/5 records found");
  await expect(page.locator('[data-state="found"]')).toHaveCount(2);
  await expect(page.locator('[data-state="waiting"]')).toHaveCount(3);
  await expect(page.getByTestId("domain-announce")).toContainText("found in DNS");
  await expect(page.getByTestId("last-checked")).toContainText(/last checked \d+s ago/);

  d.stage = 2;
  await poll(page, d);
  await expect(page.getByTestId("domain-progress")).toContainText("5/5 records found");
  await expect(page.locator('[data-state="found"]')).toHaveCount(5);

  d.stage = 3;
  await poll(page, d);
  await expect(page.getByRole("heading", { name: /domain verified/i })).toBeVisible();
  await expect(page.locator('[data-state="verified"]')).toHaveCount(5);
  for (const w of [1440, 390]) {
    await page.setViewportSize({ width: w, height: w === 390 ? 844 : 900 });
    await shot(page, "10-domain-verified", w);
  }
  await axe(page, "domain verified");

  // polling stopped once verified
  const polls = d.polls;
  await page.clock.fastForward(30_000);
  await page.waitForTimeout(300);
  expect(d.polls).toBe(polls);

  // a reload after verification resumes at the same success state
  await page.reload();
  await pause(page);
  await expect(page.getByRole("heading", { name: /domain verified/i })).toBeVisible();
  await page.getByRole("button", { name: /^continue$/i }).click();
  await expect(page.getByRole("heading", { name: /you are set/i })).toBeVisible();
  await page.getByRole("button", { name: /finish setup/i }).click();
  await expect.poll(() => api.s.completed).toBe(1);
});

test("polling backs off to 15 s after 2 minutes and pauses while the tab is hidden", async ({ page }) => {
  const d = newDomainState();
  Object.assign(d, { exists: true, name: "mail.example.com", stage: 0 });
  await page.addInitScript(() => {
    (window as unknown as { __hidden: boolean }).__hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => (window as unknown as { __hidden: boolean }).__hidden });
  });
  await open(page, d);
  await expect(page.getByTestId("domain-progress")).toBeVisible();

  // hidden: the next due poll does not happen
  await page.evaluate(() => ((window as unknown as { __hidden: boolean }).__hidden = true));
  const before = d.polls;
  await page.clock.fastForward(6000);
  await page.waitForTimeout(300);
  expect(d.polls).toBe(before);
  // visible again: it polls right away
  await page.evaluate(() => {
    (window as unknown as { __hidden: boolean }).__hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => d.polls).toBe(before + 1);

  // every 5 s for the first 2 minutes ...
  let steps = 0;
  for (let i = 0; i < 40; i++) {
    const b = d.polls;
    await page.clock.fastForward(5000);
    await page.waitForTimeout(250);
    if (d.polls === b) break; // a 5 s step without a poll: the schedule changed
    steps++;
  }
  expect(steps).toBeGreaterThanOrEqual(20);
  expect(steps).toBeLessThanOrEqual(25);
  // ... then every 15 s: 5 s have passed since the last poll, 10 s more bring the next one
  const b = d.polls;
  await page.clock.fastForward(10_000);
  await expect.poll(() => d.polls).toBe(b + 1);
});

test("Check now calls verify, then stays disabled for 30 s", async ({ page }) => {
  const d = newDomainState();
  Object.assign(d, { exists: true, name: "mail.example.com", stage: 1 });
  await open(page, d);
  const btn = page.getByRole("button", { name: /^check now$/i });
  await expect(btn).toBeEnabled();
  await btn.click();
  await expect.poll(() => d.verifyCalls).toBe(1);
  const wait = page.getByRole("button", { name: /check again in \d+s/i });
  await expect(wait).toBeDisabled();
  await page.clock.fastForward(15_000);
  await expect(page.getByRole("button", { name: /check again in \d+s/i })).toBeDisabled();
  await page.clock.fastForward(16_000);
  await expect(page.getByRole("button", { name: /^check now$/i })).toBeEnabled();
  expect(d.verifyCalls).toBe(1);
});

test("a rate-limited Check now (429) keeps the button disabled instead of showing an error", async ({ page }) => {
  const d = newDomainState();
  Object.assign(d, { exists: true, name: "mail.example.com", stage: 0, limited: true });
  await open(page, d);
  await page.getByRole("button", { name: /^check now$/i }).click();
  await expect.poll(() => d.verifyCalls).toBe(1);
  await expect(page.getByRole("button", { name: /check again in \d+s/i })).toBeDisabled();
  await expect(page.locator('[data-slot="alert"][role="alert"]')).toHaveCount(0);
});

test("Use a different domain removes the domain and returns to the entry form", async ({ page }) => {
  const d = newDomainState();
  Object.assign(d, { exists: true, name: "typo.example.com", stage: 0 });
  await open(page, d);
  await page.getByRole("button", { name: /use a different domain/i }).click();
  await page.getByRole("button", { name: /^remove$/i }).click();
  await expect(page.getByRole("heading", { name: /choose your agents. mail address/i })).toBeVisible();
  expect(d.exists).toBe(false);
});

test("choice: own domain is recommended with the 72 h note; the shared option shows the real example address and needs no setup", async ({ page }) => {
  const d = newDomainState();
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await open(page, d);
  await expect(page.getByRole("heading", { name: /choose your agents. mail address/i })).toBeVisible();
  const own = page.getByTestId("option-own");
  await expect(own.getByText("Recommended")).toBeVisible();
  await expect(own).toContainText("DNS changes can take up to 72 hours to reach the internet. You can keep using Nanite meanwhile.");
  const shared = page.getByTestId("option-shared");
  await expect(shared.getByRole("heading", { name: /start now with nanitecom\.itsvikrant\.tech/i })).toBeVisible();
  await expect(shared).toContainText("alex.demo@nanitecom.itsvikrant.tech");
  for (const w of [1440, 390]) {
    await page.setViewportSize({ width: w, height: w === 390 ? 844 : 900 });
    await shot(page, "07b-domain-choice", w);
  }
  await axe(page, "domain choice");

  // the zero-setup route: no domain call at all, straight to the end
  await shared.getByRole("button", { name: /^start now$/i }).click();
  await expect(page.getByRole("heading", { name: /you are set/i })).toBeVisible();
  await page.getByRole("button", { name: /finish setup/i }).click();
  await expect.poll(() => api.s.completed).toBe(1);
  expect(d.exists).toBe(false);
  expect(d.checkCalls).toBe(0);
});

test("own domain: Continue for now finishes onboarding while verification is still pending", async ({ page }) => {
  const d = newDomainState();
  Object.assign(d, { exists: true, name: "mail.example.com", stage: 1 });
  const api = await open(page, d);
  await expect(page.getByTestId("dns-delay-note")).toContainText("up to 72 hours");
  await expect(page.getByTestId("background-note")).toContainText("verification keeps running in the background");
  await page.getByRole("button", { name: /continue for now/i }).click();
  await expect(page.getByRole("heading", { name: /you are set/i })).toBeVisible();
  await expect(page.getByTestId("done-domain-pending")).toContainText("still being verified");
  await page.getByRole("button", { name: /finish setup/i }).click();
  await expect.poll(() => api.s.completed).toBe(1);
  expect(d.stage).toBe(1); // nothing was verified
  await axe(page, "done with pending domain");
});

test("dashboard: a user who skipped can add a domain later and then sees its pending status", async ({ page }) => {
  const d = newDomainState();
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, d, "/dashboard", "done");
  const card = page.getByTestId("mail-domain-card");
  await expect(card.getByRole("heading", { name: /mail domain/i })).toBeVisible();
  await expect(card).toContainText("shared domain");
  await card.getByRole("button", { name: /add your own domain/i }).click();
  // settings variant: no choice screen, straight to the form
  await expect(card.getByRole("heading", { name: /choose/i })).toHaveCount(0);
  await card.locator("#domain-name").fill("mail.example.com");
  await card.getByRole("button", { name: /check domain/i }).click();
  await card.getByRole("button", { name: /^add mail\.example\.com$/i }).click();
  await expect(card.getByRole("heading", { name: /add these dns records/i })).toBeVisible();
  await expect(card.getByRole("button", { name: /continue for now/i })).toHaveCount(0);
  await expect(card).toContainText("up to 72 hours");
  await expect(card.getByText("not started", { exact: true }).first()).toBeVisible();
  await axe(page, "dashboard mail domain card");
  await page.reload();
  await pause(page);
  await expect(page.getByTestId("mail-domain-card")).toContainText("is not verified yet");
  await expect(page.getByTestId("mail-domain-card")).toContainText("new agents use the shared address");
});
