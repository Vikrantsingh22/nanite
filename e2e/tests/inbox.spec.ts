import { test, expect, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import { gotoOrFixme, setTheme, watchProblems } from "./helpers";

/*
 * Dashboard and inbox with a mocked wallet and a mocked API. The mailbox key bundle and every email
 * in tests/fixtures/inbox-fixture.json are REAL @nanite/crypto output (scripts/e2e/make-inbox-fixture.ts),
 * so the browser unlock + decrypt path runs for real. Only the network and the wallet are fake.
 */

const API = "http://localhost:4000"; // NEXT_PUBLIC_API_BASE_URL as baked into the web container
const WALLET = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const CREATOR = "0x38cbfe210ce51a97fe698982952412ab12ad3dab";

type Fixture = {
  signature: string;
  bundle: Record<string, unknown>;
  emails: { name: string; type: "otp" | "conversation" | "sent"; subject: string; keyIds: string[]; ciphertext: string; wrappedKeys: string; nonce: string }[];
};
const fixture = JSON.parse(fs.readFileSync("tests/fixtures/inbox-fixture.json", "utf8")) as Fixture;

const AGENTS = [
  { id: "3f1c2a9e-0000-4000-8000-000000000001", index: 0, name: "alex", ensName: "alex.vikrant.nanitecom.eth", email: "alex@nanite.email", walletAddress: "0xc0575045b1acacc1349e3e5f8bd20fba3a8e287b", status: "active", createdAt: "2026-11-01T10:00:00Z" },
  { id: "3f1c2a9e-0000-4000-8000-000000000002", index: 1, name: "scout", ensName: "scout.vikrant.nanitecom.eth", email: "scout@nanite.email", walletAddress: "0xd817c0cbe139bd900fcfe7c016df15d4d11efab8", status: "provisioning", createdAt: "2026-11-05T10:00:00Z" },
];

const entityKey = (i: number) => "0x" + (i + 1).toString(16).padStart(64, "0");

function installApi(page: Page, opts: { agents: typeof AGENTS | [] }) {
  const seen = { inboxCalls: [] as string[], keeps: [] as Array<{ key: string; days: number }> };
  const kept = new Map<string, string>();
  return {
    seen,
    install: () =>
      page.route(`${API}/**`, async (route: Route) => {
        const req = route.request();
        const origin = req.headers()["origin"] ?? "*";
        const cors = { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,OPTIONS" };
        const json = (status: number, body: unknown) => route.fulfill({ status, headers: cors, contentType: "application/json", body: JSON.stringify(body) });
        if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
        const url = new URL(req.url());
        const path = url.pathname;
        const ext = /^\/mail\/([^/]+)\/emails\/(0x[0-9a-f]{64})\/extend$/.exec(path);
        if (ext && req.method() === "POST") {
          const { days } = req.postDataJSON() as { days: number };
          seen.keeps.push({ key: ext[2]!, days });
          const at = new Date(Date.now() + days * 86_400_000).toISOString();
          kept.set(ext[2]!, at);
          return json(200, { status: "extended", expiresAtBlock: "999999", expiresAt: at });
        }
        if (path === "/me") return json(200, { wallet: WALLET, username: "vikrant", ensName: "vikrant.nanitecom.eth", onboardingState: "done", hasKeys: true });
        if (path === "/onboarding/keys") return json(200, { ...fixture.bundle, keyVersion: 1 });
        if (path === "/agents") return json(200, { agents: opts.agents });
        if (path === "/usage") return json(200, { date: "2026-11-06", sent: 3, received: 4, quota: 90 });
        if (path === "/auth/logout") return json(200, { ok: true });
        const m = /^\/mail\/([^/]+)\/inbox$/.exec(path);
        if (m) {
          seen.inboxCalls.push(url.search);
          if (m[1] !== AGENTS[0]!.id) return json(404, { error: "not_found" });
          const type = url.searchParams.get("type");
          const now = Math.floor(Date.now() / 1000);
          const items = fixture.emails
            .map((e, i) => ({
              key: entityKey(i),
              type: e.type,
              receivedAt: now - 120 - i * 600,
              threadId: "t".repeat(32),
              senderHash: (e.name.charCodeAt(0).toString(16).padStart(2, "0") + "ab").repeat(16),
              keyIds: e.keyIds,
              owner: WALLET,
              creator: CREATOR,
              ciphertext: e.ciphertext,
              wrappedKeys: e.wrappedKeys,
              nonce: e.nonce,
              expiresAtBlock: "123456",
              extendable: e.type !== "otp",
              expiresAt:
                kept.get(entityKey(i)) ??
                new Date(Date.now() + (e.type === "otp" ? 240_000 : e.subject === "Welcome to Nanite" ? 47 * 3_600_000 : e.subject === "Weekly digest (HTML)" ? 3 * 3_600_000 : 5 * 86_400_000)).toISOString(),
            }))
            .filter((e) => !type || e.type === type);
          return json(200, { items, skipped: 0 });
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
          if (method === "personal_sign") return sig;
          return null;
        },
        on() {},
        removeListener() {},
      };
    },
    { wallet: WALLET, sig: fixture.signature },
  );
}

/** Every request to a host starting with "evil-" is recorded and refused. None may happen. */
function trapEvil(page: Page) {
  const hits: string[] = [];
  page.on("request", (r) => {
    if (/\/\/evil-/.test(r.url())) hits.push(r.url());
  });
  void page.route(/\/\/evil-[^/]+\//, (route) => route.abort());
  return hits;
}

async function axe(page: Page, label: string) {
  for (const theme of ["dark", "light"] as const) {
    await setTheme(page, theme);
    await page.waitForTimeout(500); // let colour transitions (transition-all on badges) finish before axe samples colours
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(bad.map((v) => `${label} ${theme}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
  }
  await setTheme(page, "dark");
}

// Anonymous /me 401s are designed; aborted Next.js RSC prefetches happen when a client navigation supersedes them.
const ignorable = (p: string) => /\/me\b|401|_rsc=.*ERR_ABORTED/.test(p);
const SHOTS = "artifacts/inbox";
fs.mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string, width: number) => {
  await page.waitForTimeout(800); // let the heading reveal animation finish
  return page.screenshot({ path: `${SHOTS}/${name}-${width}.png`, fullPage: true });
};

/** Locked -> /unlock -> wallet signature (mocked, deterministic) -> back, with the key only in memory. */
async function unlockViaLink(page: Page, linkName: RegExp) {
  await page.getByRole("link", { name: linkName }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: /unlock your mailbox/i })).toBeVisible();
  await page.getByRole("button", { name: /sign to unlock/i }).click();
  // The link carried ?next=<page it was on>, so unlocking returns there on its own (no goBack).
  await page.waitForURL("**/dashboard", { timeout: 30_000 });
}

for (const width of [1440, 390]) {
  test(`dashboard: empty state and agents list @${width}`, async ({ page }) => {
    const problems = watchProblems(page);
    await mockWallet(page);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });

    await installApi(page, { agents: [] }).install();
    await gotoOrFixme(page, "/dashboard");
    await expect(page.getByRole("heading", { level: 1, name: /your agents/i })).toBeVisible();
    await expect(page.getByText("No agents yet")).toBeVisible();
    await expect(page.getByRole("link", { name: /create your first agent/i })).toHaveAttribute("href", "/agents/new");
    await shot(page, "dashboard-empty", width);

    await page.unroute(`${API}/**`);
    await installApi(page, { agents: AGENTS }).install();
    await page.reload();
    await expect(page.getByTestId("agent-tile")).toHaveCount(2);
    await expect(page.getByText("alex@nanite.email")).toBeVisible();
    await expect(page.getByRole("link", { name: /open inbox/i }).first()).toHaveAttribute("href", `/agents/${AGENTS[0]!.id}`);
    await expect(page.getByRole("link", { name: /settings/i }).first()).toHaveAttribute("href", `/agents/${AGENTS[0]!.id}/settings`);
    await expect(page.getByRole("link", { name: /new agent/i })).toHaveAttribute("href", "/agents/new");
    await expect(page.getByText("provisioning")).toBeVisible();
    await expect(page.getByText(/your mailbox is locked/i)).toBeVisible();
    await shot(page, "dashboard", width);
    if (width === 1440) await axe(page, "/dashboard");
    expect(problems.filter((p) => !ignorable(p))).toEqual([]);
  });
}

test("inbox requires an unlocked key", async ({ page }) => {
  await mockWallet(page);
  const api = installApi(page, { agents: AGENTS });
  await api.install();
  await gotoOrFixme(page, `/agents/${AGENTS[0]!.id}`);
  await expect(page.getByText(/your mailbox is locked/i)).toBeVisible();
  await expect(page.getByRole("link", { name: /unlock your mailbox/i })).toHaveAttribute("href", `/unlock?next=${encodeURIComponent(`/agents/${AGENTS[0]!.id}`)}`);
  expect(api.seen.inboxCalls).toEqual([]); // nothing fetched while locked
});

test("/unlock?next= returns to a same-origin path and ignores anything else", async ({ page }) => {
  test.setTimeout(120_000);
  const evil = trapEvil(page);
  await mockWallet(page);
  await installApi(page, { agents: AGENTS }).install();

  // Valid relative path: after the signature the page lands there (client-side, key kept in memory).
  await gotoOrFixme(page, `/unlock?next=${encodeURIComponent("/dashboard")}`);
  await page.getByRole("button", { name: /sign to unlock/i }).click();
  await page.waitForURL("**/dashboard", { timeout: 30_000 });
  await expect(page.getByRole("heading", { level: 1, name: /your agents/i })).toBeVisible();
  await expect(page.getByText(/your mailbox is locked/i)).toHaveCount(0);

  // Hostile values are dropped: the unlock page stays put and nothing leaves the origin.
  for (const bad of ["//evil-a.test/x", "https://evil-b.test/x", "/\\evil-c.test", "javascript:alert(1)", "/%2F/evil-d.test", "/unlock"]) {
    await page.goto(`/unlock?next=${encodeURIComponent(bad)}`);
    await expect(page.getByText("Mail is locked")).toBeVisible();
    await page.getByRole("button", { name: /sign to unlock/i }).click();
    await expect(page.getByText("Mail is unlocked")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(400);
    expect(new URL(page.url()).pathname, bad).toBe("/unlock");
  }
  expect(evil).toEqual([]);
});

for (const width of [1440, 390]) {
  test(`inbox: real ciphertext is decrypted in the browser, HTML stays sandboxed @${width}`, async ({ page }) => {
    test.setTimeout(120_000);
    const problems = watchProblems(page);
    const evil = trapEvil(page);
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    await mockWallet(page);
    await installApi(page, { agents: AGENTS }).install();
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });

    // Dashboard (locked) -> unlock -> back -> open inbox, all client-side so the key stays in memory.
    await gotoOrFixme(page, "/dashboard");
    await unlockViaLink(page, /unlock/i);
    await expect(page.getByText(/your mailbox is locked/i)).toHaveCount(0);
    await page.getByRole("link", { name: /open inbox/i }).first().click();

    // List: decrypted subjects, one undecryptable row that does not break the list.
    await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
    const list = page.getByRole("navigation", { name: "Messages" });
    await expect(list.getByText("Welcome to Nanite")).toBeVisible({ timeout: 30_000 });
    await expect(list.getByText("Weekly digest (HTML)")).toBeVisible();
    await expect(list.getByText("Your Acme verification code")).toBeVisible();
    await expect(list.getByText(/cannot decrypt: not encrypted for your key/i)).toBeVisible();
    await expect(list.getByText("Not for you")).toHaveCount(0);
    await shot(page, "inbox-list", width);

    // Plain text is rendered as text: markup stays literal.
    await list.getByText("Welcome to Nanite").click();
    const text = page.getByTestId("mail-text");
    await expect(text).toContainText("<b>not bold</b>");
    await expect(text).toContainText("<script>alert(1)</script>");
    await expect(page.locator("article b")).toHaveCount(0);
    const chip = page.getByRole("link", { name: /open in arkiv explorer/i });
    await expect(chip).toHaveAttribute("href", `https://rabdi.explorer.arkiv.network/entity/${entityKey(0)}`);
    await expect(page.getByText(/explorer shows only ciphertext/i)).toBeVisible();
    await expect(page.getByText("https://example.com/verify?token=abc")).toBeVisible();
    await expect(page.getByRole("link", { name: "https://example.com/verify?token=abc" })).toHaveCount(0); // links are text only
    await shot(page, "message-detail", width);
    if (width === 1440) await axe(page, "inbox detail");

    // HTML: sandboxed iframe, CSP, no scripts, no remote loads.
    if (width === 390) await page.getByRole("button", { name: /back to inbox/i }).click();
    await list.getByText("Weekly digest (HTML)").click();
    const iframe = page.locator("iframe[title='Email content']");
    await expect(iframe).toHaveAttribute("sandbox", "");
    const srcdoc = (await iframe.getAttribute("srcdoc")) ?? "";
    expect(srcdoc).toContain("Content-Security-Policy");
    expect(srcdoc).toContain("default-src 'none'; img-src data:; style-src 'unsafe-inline'");
    expect(srcdoc).not.toMatch(/<script|onerror|http-equiv="refresh"|<base|<link|evil-/i);
    await expect(page.frameLocator("iframe[title='Email content']").locator("#msg")).toContainText("HTMLMARKER");
    await expect(page.getByText(/remote images blocked/i).first()).toBeVisible();
    await page.waitForTimeout(1500);
    expect(evil, "no request may reach a remote host").toEqual([]);
    expect(dialogs).toEqual([]);
    expect(await page.title()).not.toBe("pwned");
    await shot(page, "message-detail-html", width);
    // The text toggle shows the raw source literally.
    await page.getByRole("button", { name: /show as text/i }).click();
    await expect(page.getByTestId("mail-text")).toContainText("<script>");
    await expect(iframe).toHaveCount(0);

    // OTP view: big code, copy, countdown.
    await page.getByRole("tab", { name: /one-time codes/i }).click();
    await expect(page.getByTestId("otp-item")).toHaveCount(1);
    await expect(page.getByLabel("Code 4 8 2 9 1 3")).toBeVisible();
    await expect(page.getByRole("button", { name: /copy code/i })).toBeVisible();
    await expect(page.getByText(/expires in \d:\d\d/)).toBeVisible();
    await shot(page, "otp", width);
    if (width === 1440) await axe(page, "inbox otp");

    // Key never reaches browser storage.
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    expect(stored).not.toContain("482913");
    expect(stored).not.toContain("Welcome to Nanite");

    expect(evil).toEqual([]);
    expect(problems.filter((p) => !ignorable(p) && !/evil-/.test(p))).toEqual([]);
  });
}

for (const width of [1440, 390]) {
  test(`inbox: expiry shown on every message, red under 6 h, Keep with a day picker on thread/sent mail only @${width}`, async ({ page }) => {
    test.setTimeout(120_000);
    const problems = watchProblems(page);
    await mockWallet(page);
    const api = installApi(page, { agents: AGENTS });
    await api.install();
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await gotoOrFixme(page, "/dashboard");
    await unlockViaLink(page, /unlock/i);
    await page.getByRole("link", { name: /open inbox/i }).first().click();
    const list = page.getByRole("navigation", { name: "Messages" });
    await expect(list.getByText("Welcome to Nanite")).toBeVisible({ timeout: 30_000 });

    // Rows: remaining life on every message; red under 6 hours.
    const welcomeRow = list.getByRole("button", { name: /welcome to nanite/i });
    const digestRow = list.getByRole("button", { name: /weekly digest/i });
    await expect(welcomeRow.getByTestId("row-expiry")).toHaveText(/^expires in 1 d 2[23] h$/);
    await expect(welcomeRow.getByTestId("row-expiry")).not.toHaveClass(/text-destructive/);
    await expect(digestRow.getByTestId("row-expiry")).toHaveText(/^expires in [23] h \d+ m$/);
    await expect(digestRow.getByTestId("row-expiry")).toHaveClass(/text-destructive/);

    // A one-time code has no Keep action.
    await list.getByText("Your Acme verification code").click();
    await expect(page.getByTestId("detail-expiry")).toContainText(/expires in \d+ m/);
    await expect(page.getByTestId("keep-button")).toHaveCount(0);
    if (width === 390) await page.getByRole("button", { name: /back to inbox/i }).click();

    // Digest (urgent): red detail line.
    await list.getByText("Weekly digest (HTML)").click();
    await expect(page.getByTestId("detail-expiry")).toHaveClass(/text-destructive/);
    if (width === 390) await page.getByRole("button", { name: /back to inbox/i }).click();

    // Keep the welcome mail for 30 days.
    await list.getByText("Welcome to Nanite").click();
    await expect(page.getByTestId("detail-expiry")).toContainText(/expires in 1 d 2[23] h/);
    await page.getByTestId("keep-button").click();
    const group = page.getByRole("group", { name: "Keep for" });
    for (const d of [7, 30, 90, 182]) await expect(group.getByRole("button", { name: `${d} days` })).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/keep-picker-${width}.png`, fullPage: true });
    if (width === 1440) await axe(page, "keep picker");
    await group.getByRole("button", { name: "30 days" }).click();
    await expect(page.getByTestId("keep-message")).toHaveText("Kept for 30 more days.");
    expect(api.seen.keeps).toEqual([{ key: entityKey(0), days: 30 }]);
    await expect(page.getByTestId("detail-expiry")).toContainText(/expires in (29 d 23|30 d 0) h/);
    await shot(page, "keep-done", width);
    if (width === 1440) await axe(page, "keep done");
    expect(problems.filter((p) => !ignorable(p))).toEqual([]);
  });
}
