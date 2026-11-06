import { test, expect, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import { gotoOrFixme, setTheme, watchProblems } from "./helpers";
import { domainSummary, handleDomain, newDomainState } from "./domain-mock";

const API = "http://localhost:4000"; // NEXT_PUBLIC_API_BASE_URL as baked into the web container
const WALLET = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const FAKE_SIG = "0x" + "ab".repeat(65);

type State = "started" | "keys_created" | "name_claimed" | "done";

/** In-memory fake of the Nanite API, enough to drive the whole wizard without a wallet or chain. */
function fakeApi(page: Page, opts: { signedIn: boolean }) {
  const s = {
    signedIn: opts.signedIn,
    state: "started" as State,
    username: null as string | null,
    claimPolls: -1,
    keyBody: null as Record<string, unknown> | null,
    seenKeys: false,
    domain: newDomainState(),
  };
  const claim = () => {
    const done = s.claimPolls >= 3;
    const step = (i: number, id: string, label: string) => ({
      id,
      label,
      status: done || s.claimPolls > i ? "done" : s.claimPolls === i ? "active" : "pending",
      ...(done || s.claimPolls > i ? { txHash: "0x" + String(i + 1).repeat(64) } : {}),
    });
    return {
      status: s.claimPolls < 0 ? "idle" : done ? "done" : "running",
      username: s.username,
      steps: s.claimPolls < 0 ? [] : [step(0, "deploy-registry", "Deploy your name registry"), step(1, "set-parent", "Link registry to nanitecom.eth"), step(2, "register-username", "Register your username")],
      error: null,
    };
  };
  const me = () => ({ wallet: WALLET, username: s.username && s.state !== "keys_created" ? s.username : null, ensName: s.state === "name_claimed" || s.state === "done" ? `${s.username}.nanitecom.eth` : null, onboardingState: s.state, hasKeys: s.state !== "started", domain: domainSummary(s.domain) });

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
        if (path === "/me") return s.signedIn ? json(200, me()) : json(401, { error: "unauthenticated" });
        if (path === "/auth/nonce") return json(200, { nonce: "abcdef0123456789", expiresAt: new Date(Date.now() + 300000).toISOString() });
        if (path === "/auth/verify") {
          s.signedIn = true;
          return json(200, me());
        }
        if (path === "/auth/logout") {
          s.signedIn = false;
          return json(200, { ok: true });
        }
        if (path === "/onboarding/keys" && req.method() === "POST") {
          s.keyBody = req.postDataJSON();
          s.state = "keys_created";
          return json(201, { ok: true });
        }
        if (path === "/onboarding/status") {
          if (s.claimPolls >= 0 && s.claimPolls < 3) s.claimPolls++;
          if (s.claimPolls >= 3 && s.state === "keys_created") s.state = "name_claimed";
          return json(200, { onboardingState: s.state, hasKeys: s.state !== "started", username: s.username, ensName: me().ensName, canClaim: true, claim: claim(), domain: domainSummary(s.domain), sharedMailDomain: "nanitecom.itsvikrant.tech" });
        }
        if (path.startsWith("/onboarding/username/") && path.endsWith("/available")) {
          const name = decodeURIComponent(path.split("/")[3]!);
          return json(200, name === "taken" ? { username: name, available: false, reason: "taken" } : { username: name, available: true });
        }
        if (path === "/onboarding/username" && req.method() === "POST") {
          s.username = (req.postDataJSON() as { username: string }).username;
          s.claimPolls = 0;
          return json(202, { status: "running" });
        }
        const dom = handleDomain(s.domain, path, req.method(), req.method() === "GET" || req.method() === "DELETE" ? null : req.postDataJSON());
        if (dom) return route.fulfill({ status: dom.status, headers: { ...cors, ...(dom.headers ?? {}) }, contentType: "application/json", body: JSON.stringify(dom.body) });
        if (path === "/onboarding/complete") {
          s.state = "done";
          return json(200, { onboardingState: "done" });
        }
        return json(404, { error: "not_found" });
      }),
  };
}

async function mockWallet(page: Page) {
  await page.addInitScript(
    ({ wallet, sig }) => {
      (window as unknown as { ethereum: unknown }).ethereum = {
        isMetaMask: true,
        request: async ({ method }: { method: string }) => {
          if (method === "eth_requestAccounts" || method === "eth_accounts") return [wallet];
          if (method === "eth_chainId") return "0xaa36a7";
          if (method === "personal_sign") return sig; // deterministic, like an EOA
          return null;
        },
        on() {},
        removeListener() {},
      };
    },
    { wallet: WALLET, sig: FAKE_SIG },
  );
}

const ignorable = (p: string) => /\/me\b|401/.test(p); // anonymous /me is a designed 401

async function axe(page: Page, label: string) {
  const out: Record<string, unknown> = {};
  for (const theme of ["dark", "light"] as const) {
    await setTheme(page, theme);
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    out[theme] = r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target.join(" ")) }));
    const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(bad.map((v) => `${label} ${theme}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
  }
  await setTheme(page, "dark");
  return out;
}

test("/onboarding renders the connect step, passes axe in both themes, no console errors", async ({ page }) => {
  const problems = watchProblems(page);
  await fakeApi(page, { signedIn: false }).install();
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoOrFixme(page, "/onboarding");
  await expect(page.getByRole("heading", { level: 1, name: /set up your nanite account/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /connect your wallet/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /connect metamask/i })).toBeVisible();
  const r = await axe(page, "/onboarding");
  fs.mkdirSync("artifacts/onboarding", { recursive: true });
  fs.writeFileSync("artifacts/onboarding/a11y-connect.json", JSON.stringify(r, null, 2));
  expect(problems.filter((p) => !ignorable(p))).toEqual([]);
});

test("/unlock without a session shows the sign-in step", async ({ page }) => {
  await fakeApi(page, { signedIn: false }).install();
  await gotoOrFixme(page, "/unlock");
  await expect(page.getByRole("heading", { level: 1, name: /unlock your mailbox/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /connect metamask/i })).toBeVisible();
});

// viem's SIWE message builder rejects bare hostnames like "web", so the browser reaches the web
// container as nanite.test (resolved by Chromium itself; no host files involved).
test.use({ launchOptions: { args: ["--host-resolver-rules=MAP nanite.test web"] } });

test("full wizard with a mocked wallet and API: keys, recovery code, username, ENS progress, done", async ({ page }) => {
  test.setTimeout(120_000);
  const problems = watchProblems(page);
  const api = fakeApi(page, { signedIn: false });
  await api.install();
  await mockWallet(page);
  await page.setViewportSize({ width: 1024, height: 900 });
  const shot = (n: string) => page.screenshot({ path: `artifacts/onboarding/${n}.png`, fullPage: true });
  fs.mkdirSync("artifacts/onboarding", { recursive: true });

  await gotoOrFixme(page, "http://nanite.test:3000/onboarding");
  await shot("01-connect");
  await page.getByRole("button", { name: /connect metamask/i }).click();
  await expect(page.getByRole("button", { name: /sign in with ethereum/i })).toBeVisible();
  await shot("02-sign-in");
  await page.getByRole("button", { name: /sign in with ethereum/i }).click();

  // Keys step
  await expect(page.getByRole("heading", { name: /create your mailbox key/i })).toBeVisible();
  await shot("03-keys-intro");
  await page.getByRole("button", { name: /create keys/i }).click();
  await expect(page.getByText(/save your recovery code now/i)).toBeVisible({ timeout: 30_000 });
  const groups = await page.getByRole("list", { name: /recovery code groups/i }).getByRole("listitem").allInnerTexts();
  expect(groups).toHaveLength(5);
  const finish = page.getByRole("button", { name: /finish key setup/i });
  await expect(finish).toBeDisabled();
  await shot("04-recovery-code");
  Object.assign(api.s, {}); // keep the reference alive for readability
  await axe(page, "recovery");

  await page.getByRole("checkbox", { name: /i stored this code/i }).click();
  const label = await page.locator("label[for=recovery-check]").innerText();
  const n = Number(/group (\d)/.exec(label)![1]);
  await page.locator("#recovery-check").fill("WRONG");
  await expect(finish).toBeDisabled();
  await page.locator("#recovery-check").fill(groups[n - 1]!);
  await expect(finish).toBeEnabled();
  await finish.click();

  // Only public data was posted.
  await expect.poll(() => api.s.keyBody !== null).toBe(true);
  expect(Object.keys(api.s.keyBody!).sort()).toEqual(
    ["keyId", "passphraseMode", "publicKey", "recoverySalt", "walletSalt", "wrappedPrivateKeyRecovery", "wrappedPrivateKeyWallet", "wrappedSeedRecovery", "wrappedSeedWallet"],
  );
  const posted = JSON.stringify(api.s.keyBody);
  expect(posted).not.toContain(FAKE_SIG.slice(2, 30));
  expect(posted.toUpperCase()).not.toContain(groups[0]!);
  // Nothing secret in browser storage.
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(stored.toUpperCase()).not.toContain(groups[0]!);

  // Username step
  await expect(page.getByRole("heading", { name: /claim your username/i })).toBeVisible();
  await page.locator("#username").fill("taken");
  await expect(page.getByText("That username is taken.")).toBeVisible();
  await expect(page.getByRole("button", { name: /register username/i })).toBeDisabled();
  await page.locator("#username").fill("vikrant");
  await expect(page.getByText("Available", { exact: true })).toBeVisible();
  await shot("05-username");
  await axe(page, "username");
  await page.getByRole("button", { name: /register username/i }).click();

  // Progress
  await expect(page.getByText(/ens:\/\/vikrant\.nanitecom\.eth/)).toBeVisible();
  await shot("06-claim-progress");
  // Domain step (T3.6): the wizard cannot finish without a verified mail domain.
  await expect(page.getByRole("heading", { name: /choose your agents. mail address/i })).toBeVisible({ timeout: 30_000 });
  await shot("07b-domain-choice");
  await page.getByRole("button", { name: /use my own domain/i }).click();
  await expect(page.getByRole("heading", { name: /add your mail domain/i })).toBeVisible();
  await page.locator("#domain-name").fill("mail.example.com");
  await page.getByRole("button", { name: /check domain/i }).click();
  await page.getByRole("button", { name: /add mail\.example\.com/i }).click();
  await expect(page.getByRole("heading", { name: /add these dns records/i })).toBeVisible();
  api.s.domain.stage = 3; // the next poll (5 s) sees it verified
  await expect(page.getByRole("heading", { name: /domain verified/i })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: /^continue$/i }).click();
  await expect(page.getByRole("heading", { name: /you are set/i })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("vikrant", { exact: false }).first()).toBeVisible();
  await shot("07-done");
  await axe(page, "done");

  expect(problems.filter((p) => !ignorable(p))).toEqual([]);
});
