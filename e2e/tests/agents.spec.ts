import { test, expect, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import { gotoOrFixme, setTheme, watchProblems } from "./helpers";

const API = "http://localhost:4000"; // NEXT_PUBLIC_API_BASE_URL as baked into the web container
const WALLET = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const FAKE_SIG = "0x" + "ab".repeat(65);
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "nan_" + "A1b2C3d4E5".repeat(4) + "xyz"; // 43 chars after the prefix
const OUT = "artifacts/agents";

type Agent = { id: string; index: number; name: string; ensName: string; email: string; walletAddress: string; status: string; createdAt: string };

const STEP_DEFS = [
  ["deploy-resolver", "Deploy the agent's resolver"],
  ["register-agent", "Register the agent name"],
  ["grant-keys", "Grant the agent its one writable record"],
] as const;

/** In-memory fake of the Nanite API for onboarding state, /agents and the send policy. */
function fakeApi(page: Page, opts: { state: "started" | "done"; agents?: Agent[] }) {
  const s = {
    signedIn: opts.state === "done",
    state: opts.state as "started" | "done",
    agents: [...(opts.agents ?? [])],
    createBody: null as Record<string, unknown> | null,
    createPolls: -1,
    policy: { policy: "reply-only", allow: [] as string[], limit: 50 },
    putBody: null as Record<string, unknown> | null,
    putPolls: -1,
    rotated: 0,
    revoked: false,
    signer: {
      supported: true,
      address: "0x1111111111111111111111111111111111111111" as string | null,
      record: "published" as "none" | "pending" | "published" | "mismatch" | "unavailable",
      onchain: null as string | null,
    },
    signerPosts: 0,
    signerPolls: -1,
  };
  const signerJob = () => {
    const done = s.signerPolls >= 1;
    return {
      agentStatus: "active",
      kind: "signer",
      status: done ? "done" : "running",
      steps: [{ id: "publish-signer", label: "Publish the mail-signing key", status: done ? "done" : "active", ...(done ? { txHash: "0x" + "e".repeat(64) } : {}) }],
      error: null,
    };
  };
  const me = () => ({
    wallet: WALLET,
    username: s.state === "done" ? "demo" : null,
    ensName: s.state === "done" ? "demo.nanitecom.eth" : null,
    onboardingState: s.state,
    hasKeys: s.state !== "started",
  });
  const createJob = () => {
    const done = s.createPolls >= 2;
    return {
      agentStatus: done ? "active" : "provisioning",
      kind: "create",
      status: done ? "done" : "running",
      steps: STEP_DEFS.map(([id, label], i) => ({
        id,
        label,
        status: done || s.createPolls > i ? "done" : s.createPolls === i ? "active" : "pending",
        ...(done || s.createPolls > i ? { txHash: "0x" + String(i + 1).repeat(64) } : {}),
      })),
      error: null,
    };
  };
  const putJob = () => {
    const done = s.putPolls >= 1;
    return {
      agentStatus: "active",
      kind: "policy",
      status: done ? "done" : "running",
      steps: [{ id: "set-send-policy", label: "Write the send policy to ENS", status: done ? "done" : "active", ...(done ? { txHash: "0x" + "d".repeat(64) } : {}) }],
      error: null,
    };
  };

  return {
    s,
    install: () =>
      page.route(`${API}/**`, async (route: Route) => {
        const req = route.request();
        const origin = req.headers()["origin"] ?? "*";
        const cors = { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,PUT,OPTIONS" };
        const json = (status: number, body: unknown) => route.fulfill({ status, headers: cors, contentType: "application/json", body: JSON.stringify(body) });
        if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
        const path = new URL(req.url()).pathname;
        const m = req.method();
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
        if (path === "/onboarding/keys" && m === "POST") {
          s.state = "done"; // shortcut: pretend the username was claimed as well
          return json(201, { ok: true });
        }
        if (!s.signedIn) return json(401, { error: "unauthenticated" });
        if (path === "/agents" && m === "GET") return json(200, { agents: s.agents });
        if (path === "/agents" && m === "POST") {
          s.createBody = req.postDataJSON();
          s.createPolls = 0;
          const b = s.createBody as { name: string; index: number; walletAddress: string };
          const agent: Agent = {
            id: AGENT_ID,
            index: b.index,
            name: b.name,
            ensName: `${b.name}.demo.nanitecom.eth`,
            email: `${b.name}.demo@nanite.test`,
            walletAddress: b.walletAddress.toLowerCase(),
            status: "provisioning",
            createdAt: new Date().toISOString(),
          };
          s.agents.push(agent);
          return json(202, { agent, token: TOKEN, tokenId: "t1", status: { ...createJob(), steps: STEP_DEFS.map(([id, label]) => ({ id, label, status: "pending" })), status: "queued" } });
        }
        const idm = /^\/agents\/([^/]+)\/(status|send-policy|token|revoke|signer)$/.exec(path);
        if (idm) {
          if (idm[1] !== AGENT_ID) return json(404, { error: "not_found" });
          const sub = idm[2];
          if (sub === "signer" && m === "GET") return json(200, s.signer);
          if (sub === "signer" && m === "POST") {
            s.signerPosts++;
            s.signerPolls = 0;
            return json(202, { ...signerJob(), status: "queued", signerAddress: "0x2222222222222222222222222222222222222222", rotated: !!s.signer.address });
          }
          if (sub === "status" && m === "GET" && s.signerPolls >= 0) {
            if (s.signerPolls < 1) s.signerPolls++;
            if (s.signerPolls >= 1) s.signer = { supported: true, address: "0x2222222222222222222222222222222222222222", record: "published", onchain: null };
            return json(200, signerJob());
          }
          if (sub === "status" && m === "GET") {
            if (s.createPolls >= 0 && s.createPolls < 2) s.createPolls++;
            if (s.createPolls >= 2) for (const a of s.agents) if (a.status === "provisioning") a.status = "active";
            if (s.putPolls >= 0) {
              if (s.putPolls < 1) s.putPolls++;
              return json(200, putJob());
            }
            return json(200, createJob());
          }
          if (sub === "send-policy" && m === "GET") return json(200, s.policy);
          if (sub === "send-policy" && m === "PUT") {
            s.putBody = req.postDataJSON();
            s.policy = { ...s.policy, ...(s.putBody as object) } as typeof s.policy;
            s.putPolls = 0;
            return json(202, { ...putJob(), status: "queued" });
          }
          if (sub === "token" && m === "POST") {
            s.rotated++;
            return json(201, { token: "nan_" + "Z9y8X7w6V5".repeat(4) + "abc", tokenId: "t2" });
          }
          if (sub === "revoke" && m === "POST") {
            s.revoked = true;
            for (const a of s.agents) a.status = "revoked";
            return json(202, { agent: s.agents[0], status: { agentStatus: "revoked", kind: "revoke", status: "running", steps: [], error: null } });
          }
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
    { wallet: WALLET, sig: FAKE_SIG },
  );
}

const ignorable = (p: string) => /\/me\b|401/.test(p);

async function axe(page: Page, label: string) {
  for (const theme of ["dark", "light"] as const) {
    await setTheme(page, theme);
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(bad.map((v) => `${label} ${theme}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
  }
  await setTheme(page, "dark");
}

const activeAgent = (): Agent => ({
  id: AGENT_ID,
  index: 0,
  name: "scout",
  ensName: "scout.demo.nanitecom.eth",
  email: "scout.demo@nanite.test",
  walletAddress: "0xc0575045b1acacc1349e3e5f8be20fba3a8e287b",
  status: "active",
  createdAt: new Date().toISOString(),
});

// viem's SIWE builder rejects bare hostnames like "web"; Chromium maps nanite.test to the web container.
test.use({ launchOptions: { args: ["--host-resolver-rules=MAP nanite.test web"] } });

test.beforeAll(() => fs.mkdirSync(OUT, { recursive: true }));

test("/agents/new with locked keys points to /unlock", async ({ page }) => {
  const problems = watchProblems(page);
  await fakeApi(page, { state: "done" }).install();
  await page.setViewportSize({ width: 1024, height: 800 });
  await gotoOrFixme(page, "/agents/new");
  await expect(page.getByRole("heading", { level: 1, name: /add an agent/i })).toBeVisible();
  await expect(page.getByText(/your keys are locked/i)).toBeVisible();
  await expect(page.getByRole("link", { name: /unlock your mailbox/i })).toHaveAttribute("href", "/unlock?next=%2Fagents%2Fnew");
  await expect(page.getByRole("button", { name: /^add agent$/i })).toHaveCount(0);
  await page.screenshot({ path: `${OUT}/00-locked.png`, fullPage: true });
  expect(problems.filter((p) => !ignorable(p))).toEqual([]);
});

test("add-agent flow with a mocked wallet and API: derive, ENS progress, token shown once", async ({ page }) => {
  test.setTimeout(150_000);
  const problems = watchProblems(page);
  const api = fakeApi(page, { state: "started" });
  await api.install();
  await mockWallet(page);
  await page.setViewportSize({ width: 1024, height: 900 });
  const shot = (n: string) => page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true });

  // Get the seed into memory the real way: create keys in the onboarding wizard.
  await gotoOrFixme(page, "http://nanite.test:3000/onboarding");
  await page.getByRole("button", { name: /connect metamask/i }).click();
  await page.getByRole("button", { name: /sign in with ethereum/i }).click();
  await page.getByRole("button", { name: /create keys/i }).click();
  await expect(page.getByText(/save your recovery code now/i)).toBeVisible({ timeout: 30_000 });
  const groups = await page.getByRole("list", { name: /recovery code groups/i }).getByRole("listitem").allInnerTexts();
  await page.getByRole("checkbox", { name: /i stored this code/i }).click();
  const n = Number(/group (\d)/.exec(await page.locator("label[for=recovery-check]").innerText())![1]);
  await page.locator("#recovery-check").fill(groups[n - 1]!);
  await page.getByRole("button", { name: /finish key setup/i }).click();
  await expect(page.getByRole("heading", { name: /you are set/i })).toBeVisible();

  // Client-side navigation keeps the in-memory keys (a full load would lock them).
  await page.evaluate(() => (window as unknown as { next: { router: { push: (p: string) => void } } }).next.router.push("/agents/new"));
  await expect(page.getByRole("heading", { level: 1, name: /add an agent/i })).toBeVisible();
  await expect(page.getByText(/this will be agent #0/i)).toBeVisible();
  await shot("01-form");
  await axe(page, "add-agent form");

  const name = page.getByLabel("Agent name");
  await name.fill("Bad_Name!");
  await expect(page.getByRole("button", { name: /^add agent$/i })).toBeDisabled();
  await name.fill("scout");
  await page.getByRole("button", { name: /^add agent$/i }).click();

  // The seed never leaves the browser: only name, index and the derived address are posted.
  await expect.poll(() => api.s.createBody !== null).toBe(true);
  expect(Object.keys(api.s.createBody!).sort()).toEqual(["index", "name", "walletAddress"]);
  expect(api.s.createBody).toMatchObject({ name: "scout", index: 0 });
  expect(String(api.s.createBody!.walletAddress)).toMatch(/^0x[0-9a-fA-F]{40}$/);

  await expect(page.getByText(/ens:\/\/scout\.demo\.nanitecom\.eth/)).toBeVisible();
  await expect(page.getByTestId("agent-token")).toHaveText(TOKEN);
  await expect(page.getByTestId("agent-email")).toHaveText("scout.demo@nanite.test");
  await shot("02-progress");
  await expect(page.getByRole("heading", { name: /agent ready/i })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("link", { name: /agent settings/i })).toHaveCount(0); // gated on "I stored it"
  await shot("03-ready");
  await axe(page, "add-agent ready");

  // The token is not kept in any browser storage.
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(stored).not.toContain("A1b2C3d4E5");

  await page.getByRole("checkbox", { name: /i stored this token/i }).click();
  await expect(page.getByRole("link", { name: /open inbox/i })).toHaveAttribute("href", `/agents/${AGENT_ID}`);
  await shot("04-confirmed");

  // Add another: the next index is 1 and the token is gone from the page.
  await page.getByRole("button", { name: /add another agent/i }).click();
  await expect(page.getByText(/this will be agent #1/i)).toBeVisible();
  await expect(page.getByTestId("agent-token")).toHaveCount(0);
  expect(problems.filter((p) => !ignorable(p))).toEqual([]);
});

test("agent settings: mail signing section (states, rotate with confirm, set up, self custody)", async ({ page }) => {
  test.setTimeout(90_000);
  const problems = watchProblems(page);
  const api = fakeApi(page, { state: "done", agents: [activeAgent()] });
  await api.install();
  const shot = (n: string) => page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true });
  const section = () => page.getByRole("heading", { level: 2, name: /^mail signing/i }).locator("xpath=ancestor::*[@data-slot='card'][1]");

  for (const vp of [{ width: 1024, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(vp);
    await gotoOrFixme(page, `/agents/${AGENT_ID}/settings`);
    await expect(page.getByTestId("signer-address")).toHaveText("0x1111111111111111111111111111111111111111");
    await expect(section().getByText("published", { exact: true })).toBeVisible();
    await shot(`16-signing-${vp.width}`);
  }
  await page.setViewportSize({ width: 1024, height: 900 });
  await gotoOrFixme(page, `/agents/${AGENT_ID}/settings`);
  await expect(page.getByTestId("signer-address")).toBeVisible();
  await axe(page, "signing published");

  // pending / mismatch / unavailable are read fresh via "Check ENS again"
  for (const [record, onchain, badge] of [
    ["pending", null, "pending"],
    ["mismatch", "0x3333333333333333333333333333333333333333", "mismatch"],
    ["unavailable", null, "unavailable"],
  ] as const) {
    api.s.signer = { ...api.s.signer, record, onchain };
    await page.getByRole("button", { name: /check ens again/i }).click();
    await expect(section().getByText(badge, { exact: true })).toBeVisible();
    if (record === "mismatch") {
      await expect(page.getByText("0x3333333333333333333333333333333333333333")).toBeVisible();
      await shot("17-signing-mismatch");
      await axe(page, "signing mismatch");
    }
  }

  // Rotate: confirm dialog first, nothing is sent until confirmed
  await page.getByRole("button", { name: /rotate signing key/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await axe(page, "signing rotate dialog");
  await dialog.getByRole("button", { name: /^cancel$/i }).click();
  await expect(dialog).toBeHidden();
  expect(api.s.signerPosts).toBe(0);
  await page.getByRole("button", { name: /rotate signing key/i }).click();
  await page.getByRole("dialog").getByRole("button", { name: /^rotate key$/i }).click();
  await expect(page.getByText("ens://nanite.signer")).toBeVisible();
  await expect(page.getByText("Signing key published to ENS")).toBeAttached({ timeout: 20_000 });
  await expect(page.getByTestId("signer-address")).toHaveText("0x2222222222222222222222222222222222222222");
  expect(api.s.signerPosts).toBe(1);
  await shot("18-signing-rotated");
  await axe(page, "signing rotated");

  // An agent without a signer yet can set one up (no confirm needed); self custody explains itself.
  api.s.signer = { supported: true, address: null, record: "none", onchain: null };
  api.s.signerPolls = -1;
  await gotoOrFixme(page, `/agents/${AGENT_ID}/settings`);
  await expect(page.getByRole("button", { name: /set up signing/i })).toBeVisible();
  await axe(page, "signing not set up");
  await page.getByRole("button", { name: /set up signing/i }).click();
  await expect(page.getByTestId("signer-address")).toHaveText("0x2222222222222222222222222222222222222222", { timeout: 20_000 });
  api.s.signer = { supported: false, address: null, record: "none", onchain: null };
  await gotoOrFixme(page, `/agents/${AGENT_ID}/settings`);
  await expect(page.getByText(/keeps its own keys/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /signing key|set up signing/i })).toHaveCount(0);
  await axe(page, "signing self custody");
  expect(problems.filter((p) => !ignorable(p))).toEqual([]);
});

test("agent settings: send policy editor, token rotation, revoke", async ({ page }) => {
  test.setTimeout(90_000);
  const problems = watchProblems(page);
  const api = fakeApi(page, { state: "done", agents: [activeAgent()] });
  await api.install();
  const shot = (n: string) => page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true });

  for (const vp of [{ width: 1024, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(vp);
    await gotoOrFixme(page, `/agents/${AGENT_ID}/settings`);
    await expect(page.getByRole("heading", { level: 1, name: /agent settings/i })).toBeVisible();
    await expect(page.getByRole("radio", { name: "Reply only" })).toBeChecked();
    await shot(`10-settings-${vp.width}`);
  }
  await page.setViewportSize({ width: 1024, height: 900 });
  await gotoOrFixme(page, `/agents/${AGENT_ID}/settings`);
  await axe(page, "settings");

  // Policy editor
  const save = page.getByRole("button", { name: /save to ens/i });
  await expect(save).toBeDisabled();
  await page.getByRole("radio", { name: "Allowlist" }).click();
  await page.getByLabel("Add a recipient").fill("not valid");
  await page.getByRole("button", { name: /^add$/i }).click();
  await expect(page.getByText(/use an email address/i)).toBeVisible();
  await page.getByLabel("Add a recipient").fill("Friend@Example.COM");
  await page.getByRole("button", { name: /^add$/i }).click();
  await page.getByLabel("Add a recipient").fill("@example.org");
  await page.keyboard.press("Enter");
  await page.getByLabel("Add a recipient").fill("vitalik.eth");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("list", { name: "Allowed recipients" }).getByRole("listitem")).toHaveCount(3);
  await page.getByRole("button", { name: "Remove vitalik.eth" }).click();
  await page.getByLabel("Daily send limit").fill("abc");
  await expect(save).toBeDisabled();
  await page.getByLabel("Daily send limit").fill("5");
  await shot("11-policy-edited");
  await axe(page, "settings edited");
  await save.click();
  await expect(page.getByText("ens://send-policy")).toBeVisible();
  expect(api.s.putBody).toEqual({ policy: "allowlist", allow: ["friend@example.com", "@example.org"], limit: 5 });
  await expect(page.getByText("Policy saved to ENS")).toBeAttached({ timeout: 20_000 });
  await expect(save).toBeDisabled();
  await shot("12-policy-saved");

  // Token rotation
  await page.getByRole("button", { name: /rotate token/i }).click();
  await expect(page.getByTestId("agent-token")).toContainText("nan_Z9y8X7w6V5");
  await shot("13-token-rotated");
  await axe(page, "settings token");
  await page.getByRole("checkbox", { name: /i stored this token/i }).click();
  await page.getByRole("button", { name: /hide token/i }).click();
  await expect(page.getByTestId("agent-token")).toHaveCount(0);

  // Revoke with confirmation
  await page.getByRole("button", { name: /^revoke scout$/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await shot("14-revoke-dialog");
  await axe(page, "revoke dialog");
  await dialog.getByRole("button", { name: /^cancel$/i }).click();
  await expect(dialog).toBeHidden(); // wait for the exit animation: no stale dialog when it is reopened
  expect(api.s.revoked).toBe(false);
  await page.getByRole("button", { name: /^revoke scout$/i }).click();
  await page.getByRole("dialog").getByRole("button", { name: /^revoke agent$/i }).click();
  await expect(page.getByText(/this agent is revoked/i)).toBeVisible();
  expect(api.s.revoked).toBe(true);
  await shot("15-revoked");
  expect(problems.filter((p) => !ignorable(p))).toEqual([]);
});
