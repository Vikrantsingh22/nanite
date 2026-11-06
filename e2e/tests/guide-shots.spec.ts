import { test, expect, type Page, type Route } from "@playwright/test";
import fs from "node:fs";
import { gotoOrFixme, mockAnonSession, watchProblems } from "./helpers";
import { domainSummary, handleDomain, newDomainState } from "./domain-mock";

/*
 * Screenshots for docs/user-guide.md (1440 wide, written to ../docs/guide-shots) and a check that every label the
 * guide quotes exists in the real UI. Same approach as the other specs: a mocked wallet and an in-memory fake of the
 * Nanite API; the browser-side crypto, the wizard and the pages are the real code.
 */

const API = "http://localhost:4000"; // NEXT_PUBLIC_API_BASE_URL as baked into the web container
const WALLET = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const FAKE_SIG = "0x" + "ab".repeat(65);
const OUT = "../docs/guide-shots";
const TOKEN = "nan_" + "A1b2C3d4E5".repeat(4) + "xyz";
const ids = (i: number) => `11111111-1111-4111-8111-11111111111${i}`;

type Agent = { id: string; index: number; name: string; ensName: string; email: string; walletAddress: string; status: string; createdAt: string };
type State = "started" | "keys_created" | "name_claimed" | "done";

const shotFile = (n: string) => `${OUT}/${n}.png`;
async function shot(page: Page, name: string, opts: { full?: boolean } = {}) {
  await page.waitForTimeout(700); // heading reveal animation
  await page.screenshot({ path: shotFile(name), fullPage: opts.full ?? true });
}

const STEP = (id: string, label: string, i: number, polls: number) => ({
  id,
  label,
  status: polls > i + 1 ? "done" : polls === i + 1 ? "active" : "pending",
  ...(polls > i + 1 ? { txHash: "0x" + String(i + 1).repeat(64) } : {}),
});

function fakeApi(page: Page) {
  const s = {
    signedIn: false,
    state: "started" as State,
    username: null as string | null,
    claimPolls: -1,
    keyBody: null as Record<string, unknown> | null,
    domain: newDomainState(),
    agents: [] as Agent[],
    createPolls: -1,
    createBody: null as Record<string, unknown> | null,
    policy: { policy: "reply-only", allow: [] as string[], limit: 50 },
    retention: { otpTtlMinutes: 5, mailTtlHours: 48, extend: "on", extendLimit: 20 },
    signer: { supported: true, custody: "nanite", managed: true, address: "0x6f8C33d4184d115325b4DaFA58F0F7EE516877fa" as string | null, record: "published", onchain: null as string | null },
  };
  const me = () => ({
    wallet: WALLET,
    username: s.username && s.state !== "keys_created" ? s.username : null,
    ensName: s.state === "name_claimed" || s.state === "done" ? `${s.username}.nanitecom.eth` : null,
    onboardingState: s.state,
    hasKeys: s.state !== "started",
    domain: domainSummary(s.domain),
  });
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
  const createJob = () => {
    const done = s.createPolls >= 2;
    const defs = [["deploy-resolver", "Deploy the agent's resolver"], ["register-agent", "Register the agent name"], ["grant-keys", "Grant the agent its one writable record"]] as const;
    return {
      agentStatus: done ? "active" : "provisioning",
      kind: "create",
      status: done ? "done" : "running",
      steps: defs.map(([id, label], i) => ({ id, label, status: done || s.createPolls > i ? "done" : s.createPolls === i ? "active" : "pending", ...(done || s.createPolls > i ? { txHash: "0x" + String(i + 1).repeat(64) } : {}) })),
      error: null,
    };
  };
  const simpleJob = (kind: string, id: string, label: string, polls: number) => ({
    agentStatus: "active",
    kind,
    status: polls >= 1 ? "done" : "running",
    steps: [{ id, label, status: polls >= 1 ? "done" : "active", ...(polls >= 1 ? { txHash: "0x" + "d".repeat(64) } : {}) }],
    error: null,
  });
  let policyPolls = -1;

  return {
    s,
    install: () =>
      page.route(`${API}/**`, async (route: Route) => {
        const req = route.request();
        const origin = req.headers()["origin"] ?? "*";
        const cors = { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS" };
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
          s.keyBody = req.postDataJSON();
          s.state = "keys_created";
          return json(201, { ok: true });
        }
        if (path === "/onboarding/keys" && m === "GET") return s.keyBody ? json(200, { ...s.keyBody, keyVersion: 1 }) : json(404, { error: "not_found" });
        if (path === "/onboarding/status") {
          if (s.claimPolls >= 0 && s.claimPolls < 3) s.claimPolls++;
          if (s.claimPolls >= 3 && s.state === "keys_created") s.state = "name_claimed";
          return json(200, { onboardingState: s.state, hasKeys: s.state !== "started", username: s.username, ensName: me().ensName, canClaim: true, claim: claim(), domain: domainSummary(s.domain), sharedMailDomain: "nanitecom.itsvikrant.tech" });
        }
        if (path.startsWith("/onboarding/username/") && path.endsWith("/available")) {
          const name = decodeURIComponent(path.split("/")[3]!);
          return json(200, name === "taken" ? { username: name, available: false, reason: "taken" } : { username: name, available: true });
        }
        if (path === "/onboarding/username" && m === "POST") {
          s.username = (req.postDataJSON() as { username: string }).username;
          s.claimPolls = 0;
          return json(202, { status: "running" });
        }
        const dom = handleDomain(s.domain, path, m, m === "GET" || m === "DELETE" ? null : req.postDataJSON());
        if (dom) return route.fulfill({ status: dom.status, headers: { ...cors, ...(dom.headers ?? {}) }, contentType: "application/json", body: JSON.stringify(dom.body) });
        if (path === "/onboarding/complete") {
          s.state = "done";
          return json(200, { onboardingState: "done" });
        }
        if (!s.signedIn) return json(401, { error: "unauthenticated" });
        if (path === "/usage") return json(200, { date: "2026-11-06", sent: 3, received: 4, quota: 90 });
        if (path === "/agents" && m === "GET") return json(200, { agents: s.agents });
        if (path === "/agents" && m === "POST") {
          s.createBody = req.postDataJSON();
          s.createPolls = 0;
          const b = s.createBody as { name: string; index: number; walletAddress: string };
          const agent: Agent = {
            id: ids(b.index),
            index: b.index,
            name: b.name,
            ensName: `${b.name}.${s.username}.nanitecom.eth`,
            email: s.domain.exists && s.domain.stage === 3 ? `${b.name}@${s.domain.name}` : `${b.name}.${s.username}@nanitecom.itsvikrant.tech`,
            walletAddress: b.walletAddress.toLowerCase(),
            status: "provisioning",
            createdAt: new Date().toISOString(),
          };
          s.agents.push(agent);
          return json(202, { agent, token: TOKEN, tokenId: "t1", status: { ...createJob(), status: "queued", steps: createJob().steps.map((x) => ({ id: x.id, label: x.label, status: "pending" })) } });
        }
        const idm = /^\/agents\/([^/]+)\/(status|send-policy|retention|token|revoke|signer)$/.exec(path);
        if (idm) {
          const sub = idm[2];
          if (sub === "signer" && m === "GET") return json(200, s.signer);
          if (sub === "retention" && m === "GET") return json(200, s.retention);
          if (sub === "send-policy" && m === "GET") return json(200, s.policy);
          if (sub === "send-policy" && m === "PUT") {
            s.policy = { ...s.policy, ...(req.postDataJSON() as object) };
            policyPolls = 0;
            return json(202, { ...simpleJob("policy", "set-send-policy", "Write the send policy to ENS", 0), status: "queued" });
          }
          if (sub === "status" && m === "GET") {
            if (policyPolls >= 0) {
              policyPolls++;
              return json(200, simpleJob("policy", "set-send-policy", "Write the send policy to ENS", policyPolls));
            }
            if (s.createPolls >= 0 && s.createPolls < 2) s.createPolls++;
            if (s.createPolls >= 2) for (const a of s.agents) if (a.status === "provisioning") a.status = "active";
            return json(200, createJob());
          }
          if (sub === "token" && m === "POST") return json(201, { token: "nan_" + "Z9y8X7w6V5".repeat(4) + "abc", tokenId: "t2" });
          if (sub === "revoke" && m === "POST") return json(202, { agent: s.agents[0], status: { agentStatus: "revoked", kind: "revoke", status: "running", steps: [], error: null } });
        }
        return json(404, { error: "not_found" });
      }),
  };
}

async function mockWallet(page: Page, sig: string) {
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
    { wallet: WALLET, sig },
  );
}

// viem's SIWE builder rejects bare hostnames like "web"; Chromium maps nanite.test to the web container.
test.use({ launchOptions: { args: ["--host-resolver-rules=MAP nanite.test web"] } });
test.beforeAll(() => fs.mkdirSync(OUT, { recursive: true }));

test("guide: home, onboarding, dashboard, add agent (hosted and self-hosted), agent settings", async ({ page }) => {
  test.setTimeout(240_000);
  const problems = watchProblems(page);
  const api = fakeApi(page);
  await api.install();
  await mockWallet(page, FAKE_SIG);
  await page.setViewportSize({ width: 1440, height: 900 });

  // Home
  await gotoOrFixme(page, "http://nanite.test:3000/");
  await expect(page.getByRole("link", { name: /get started/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /^sign in$/i })).toBeVisible();
  await shot(page, "01-home", { full: false });

  // 01 connect, sign in
  await page.getByRole("link", { name: /get started/i }).click();
  await expect(page.getByRole("heading", { level: 1, name: /set up your nanite account/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /connect your wallet/i })).toBeVisible();
  await shot(page, "02-connect", { full: false });
  await page.getByRole("button", { name: /connect metamask/i }).click();
  await expect(page.getByRole("button", { name: /sign in with ethereum/i })).toBeVisible();
  await shot(page, "03-sign-in", { full: false });
  await page.getByRole("button", { name: /sign in with ethereum/i }).click();

  // 02 keys
  await expect(page.getByRole("heading", { name: /create your mailbox key/i })).toBeVisible();
  await shot(page, "04-keys-intro", { full: false });
  await page.getByRole("button", { name: /create keys/i }).click();
  await expect(page.getByText(/save your recovery code now/i)).toBeVisible({ timeout: 30_000 });
  const groups = await page.getByRole("list", { name: /recovery code groups/i }).getByRole("listitem").allInnerTexts();
  expect(groups).toHaveLength(5);
  expect(groups.every((g) => g.length === 5)).toBe(true); // 5 groups of 5 = 25 characters
  await page.getByRole("button", { name: /^copy$/i }).first().waitFor();
  await page.getByRole("checkbox", { name: /i stored this code/i }).click();
  const label = await page.locator("label[for=recovery-check]").innerText();
  expect(label).toMatch(/type group \d of your code to confirm/i);
  const n = Number(/group (\d)/.exec(label)![1]);
  await page.locator("#recovery-check").fill(groups[(n % 5)]!); // a wrong group first
  await expect(page.getByText(new RegExp(`does not match group ${n}`, "i"))).toBeVisible();
  await expect(page.getByRole("button", { name: /finish key setup/i })).toBeDisabled();
  await shot(page, "05-recovery-code");
  await page.locator("#recovery-check").fill(groups[n - 1]!);
  await page.getByRole("button", { name: /finish key setup/i }).click();

  // 03 username
  await expect(page.getByRole("heading", { name: /claim your username/i })).toBeVisible();
  await page.locator("#username").fill("taken");
  await expect(page.getByText("That username is taken.")).toBeVisible();
  await page.locator("#username").fill("Ab");
  await expect(page.getByText("Use 3 to 32 characters: a-z, 0-9 and inner hyphens.")).toBeVisible();
  await page.locator("#username").fill("demo");
  await expect(page.getByText("Available", { exact: true })).toBeVisible();
  await shot(page, "06-username", { full: false });
  await page.getByRole("button", { name: /register username/i }).click();
  await expect(page.getByText(/ens:\/\/demo\.nanitecom\.eth/)).toBeVisible();
  await shot(page, "07-claim-progress", { full: false });

  // 04 domain: choice, own-domain flow
  await expect(page.getByRole("heading", { name: /choose your agents. mail address/i })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Recommended", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start now", exact: true })).toBeVisible();
  await shot(page, "08-domain-choice", { full: false });
  await page.getByRole("button", { name: /use my own domain/i }).click();
  await expect(page.getByRole("heading", { name: /add your mail domain/i })).toBeVisible();
  await page.locator("#domain-name").fill("example.com");
  await page.getByRole("button", { name: /check domain/i }).click();
  await expect(page.getByText(/we suggest/i)).toBeVisible();
  await shot(page, "09-domain-check");
  await page.getByRole("button", { name: /use mail\.example\.com/i }).click();
  await page.getByRole("button", { name: /add mail\.example\.com/i }).click();
  await expect(page.getByRole("heading", { name: /add these dns records/i })).toBeVisible();
  await expect(page.getByText(/up to 72 hours/i).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /continue for now/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /use a different domain/i })).toBeVisible();
  await shot(page, "10-dns-waiting");
  api.s.domain.stage = 1;
  await page.getByRole("button", { name: /check now/i }).click();
  await expect(page.getByText("found in DNS").first()).toBeVisible();
  await shot(page, "11-dns-found");
  api.s.domain.stage = 3;
  await expect(page.getByRole("heading", { name: /domain verified/i })).toBeVisible({ timeout: 20_000 });
  await shot(page, "12-domain-verified");
  await page.getByRole("button", { name: /^continue$/i }).click();

  // 05 done
  await expect(page.getByRole("heading", { name: /you are set/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /finish setup/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /unlock mailbox/i })).toBeVisible();
  await shot(page, "13-done", { full: false });
  await page.getByRole("button", { name: /finish setup/i }).click();
  await expect(page.getByRole("button", { name: /finish setup/i })).toHaveCount(0);

  // Dashboard (empty), client-side so the key stays in memory
  await page.getByRole("link", { name: /unlock mailbox/i }).click();
  await page.waitForURL("**/dashboard", { timeout: 30_000 });
  await expect(page.getByRole("heading", { level: 1, name: /your agents/i })).toBeVisible();
  await expect(page.getByText("No agents yet")).toBeVisible();
  await expect(page.getByTestId("mail-domain-card")).toBeVisible();
  await expect(page.getByTestId("mail-usage")).toHaveText("mail today: 7 / 90");
  await shot(page, "20-dashboard-empty");

  // Add a hosted agent
  await page.getByRole("link", { name: /create your first agent/i }).click();
  await expect(page.getByRole("heading", { level: 1, name: /add an agent/i })).toBeVisible();
  await expect(page.getByText(/this will be agent #0/i)).toBeVisible();
  await expect(page.getByLabel("Nanite holds the agent key (simplest)")).toBeChecked();
  await shot(page, "21-add-agent-form", { full: false });
  await page.getByLabel("Agent name").fill("alex");
  await page.getByRole("button", { name: /^add agent$/i }).click();
  await expect(page.getByTestId("agent-token")).toHaveText(TOKEN);
  await expect(page.getByTestId("agent-email")).toHaveText("alex@mail.example.com");
  await shot(page, "22-agent-progress");
  await expect(page.getByRole("heading", { name: /agent ready/i })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("checkbox", { name: /i stored this token/i }).click();
  await expect(page.getByRole("link", { name: /open inbox/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /agent settings/i })).toBeVisible();
  await shot(page, "23-agent-ready");

  // Self-hosted choice
  await page.getByRole("button", { name: /add another agent/i }).click();
  await expect(page.getByText(/this will be agent #1/i)).toBeVisible();
  await page.getByLabel("Hold the key yourself (self-hosted)").click();
  await expect(page.getByTestId("keygen-command")).toBeVisible();
  await page.getByLabel("Agent name").fill("kit");
  await page.getByLabel("Encryption public key").fill("iVU3vtI+fdNPg+2ORfUHQyO5ojBWADGkDeZFRL0iN3Q=");
  await page.getByLabel("Signer address").fill("0xE53E34806aDb80A1A48A101a6cae7BF9E24de135");
  await shot(page, "24-add-agent-self-hosted");
  await page.getByRole("button", { name: /^add agent$/i }).click();
  await expect(page.getByTestId("mcp-config")).toBeVisible();
  await expect(page.getByRole("heading", { name: /agent ready/i })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("checkbox", { name: /i stored this token/i }).click();
  await shot(page, "25-self-hosted-mcp-config");

  // Agent settings of the hosted agent
  await page.getByRole("link", { name: /^add agent$/i }).count();
  await page.evaluate(() => (window as unknown as { next: { router: { push: (p: string) => void } } }).next.router.push("/dashboard"));
  await expect(page.getByTestId("agent-tile")).toHaveCount(2);
  await shot(page, "26-dashboard-agents");
  await page.getByRole("link", { name: /settings/i }).first().click();
  await expect(page.getByRole("heading", { level: 2, name: /sending policy/i })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: /^retention/i })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: /^mail signing/i })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: /api token/i })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: /revoke agent/i })).toBeVisible();
  await shot(page, "30-settings");
  await page.getByLabel("Allowlist").click();
  await page.getByLabel("Add a recipient").fill("friend@example.com");
  await page.getByRole("button", { name: /^add$/i }).click();
  await page.getByLabel("Add a recipient").fill("@example.org");
  await page.getByRole("button", { name: /^add$/i }).click();
  await page.locator("#send-limit").fill("20");
  await expect(page.getByRole("button", { name: /save to ens/i })).toBeEnabled();
  await shot(page, "31-send-policy-allowlist");
  await page.getByRole("button", { name: /save to ens/i }).click();
  await expect(page.getByText("ens://send-policy")).toBeVisible();
  await expect(page.getByRole("button", { name: /rotate signing key/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /rotate token/i })).toBeVisible();
  await page.getByRole("button", { name: /rotate token/i }).click();
  await expect(page.getByTestId("agent-token")).toBeVisible();
  await shot(page, "32-token-rotated");
  await page.getByRole("button", { name: /^revoke alex$/i }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: shotFile("33-revoke-dialog"), fullPage: false });
  await page.getByRole("dialog").getByRole("button", { name: /^cancel$/i }).click();

  // Sign out
  await page.getByRole("link", { name: /all agents|nanite/i }).first().click().catch(() => undefined);
  expect(problems.filter((p) => !/\/me\b|401/.test(p))).toEqual([]);
});

/* ------------------------------------------------------------------ inbox (real ciphertext fixture) */

type Fixture = {
  signature: string;
  bundle: Record<string, unknown>;
  emails: { name: string; type: "otp" | "conversation" | "sent"; subject: string; keyIds: string[]; ciphertext: string; wrappedKeys: string; nonce: string }[];
};
const fixture = JSON.parse(fs.readFileSync("tests/fixtures/inbox-fixture.json", "utf8")) as Fixture;
const CREATOR = "0x38cbfe210ce51a97fe698982952412ab12ad3dab";
const FIX_AGENTS = [
  { id: "3f1c2a9e-0000-4000-8000-000000000001", index: 0, name: "alex", ensName: "alex.demo.nanitecom.eth", email: "alex.demo@nanitecom.itsvikrant.tech", walletAddress: "0xc0575045b1acacc1349e3e5f8bd20fba3a8e287b", status: "active", createdAt: "2026-11-01T10:00:00Z" },
];
const entityKey = (i: number) => "0x" + (i + 1).toString(16).padStart(64, "0");

test("guide: unlock, dashboard mail domain card, inbox (decrypt, OTP, HTML sandbox, expiry, Keep)", async ({ page }) => {
  test.setTimeout(180_000);
  const problems = watchProblems(page);
  await mockWallet(page, fixture.signature);
  await page.setViewportSize({ width: 1440, height: 900 });
  let signedIn = true;
  const kept = new Map<string, string>();
  await page.route(`${API}/**`, async (route: Route) => {
    const req = route.request();
    const origin = req.headers()["origin"] ?? "*";
    const cors = { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,OPTIONS" };
    const json = (status: number, body: unknown) => route.fulfill({ status, headers: cors, contentType: "application/json", body: JSON.stringify(body) });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const url = new URL(req.url());
    const path = url.pathname;
    if (path === "/auth/logout") {
      signedIn = false;
      return json(200, { ok: true });
    }
    if (path === "/me") return signedIn ? json(200, { wallet: WALLET, username: "demo", ensName: "demo.nanitecom.eth", onboardingState: "done", hasKeys: true, domain: null }) : json(401, { error: "unauthenticated" });
    if (path === "/onboarding/keys") return json(200, { ...fixture.bundle, keyVersion: 1 });
    if (path === "/agents") return json(200, { agents: FIX_AGENTS });
    if (path === "/usage") return json(200, { date: "2026-11-06", sent: 3, received: 4, quota: 90 });
    const ext = /^\/mail\/([^/]+)\/emails\/(0x[0-9a-f]{64})\/extend$/.exec(path);
    if (ext && req.method() === "POST") {
      const { days } = req.postDataJSON() as { days: number };
      const at = new Date(Date.now() + days * 86_400_000).toISOString();
      kept.set(ext[2]!, at);
      return json(200, { status: "extended", expiresAtBlock: "999999", expiresAt: at });
    }
    const mm = /^\/mail\/([^/]+)\/inbox$/.exec(path);
    if (mm) {
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
          expiresAt: kept.get(entityKey(i)) ?? new Date(Date.now() + (e.type === "otp" ? 240_000 : e.subject === "Welcome to Nanite" ? 47 * 3_600_000 : e.subject === "Weekly digest (HTML)" ? 3 * 3_600_000 : 5 * 86_400_000)).toISOString(),
        }))
        .filter((e) => !type || e.type === type);
      return json(200, { items, skipped: 0 });
    }
    return json(404, { error: "not_found" });
  });

  // Reload scenario: a fresh page load is locked.
  await gotoOrFixme(page, "/dashboard");
  await expect(page.getByText(/your mailbox is locked/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /^lock$/i })).toHaveCount(0);
  await shot(page, "40-dashboard-locked", { full: false });
  await page.getByRole("link", { name: /^unlock it$/i }).or(page.getByRole("link", { name: /unlock it/i })).first().click();
  await expect(page.getByRole("heading", { level: 1, name: /unlock your mailbox/i })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Wallet" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Recovery code" })).toBeVisible();
  await expect(page.getByText("Mail is locked")).toBeVisible();
  await shot(page, "41-unlock", { full: false });
  await page.getByRole("tab", { name: "Recovery code" }).click();
  await expect(page.getByRole("button", { name: /unlock with recovery code/i })).toBeVisible();
  await shot(page, "42-unlock-recovery", { full: false });
  await page.getByRole("tab", { name: "Wallet" }).click();
  await page.getByRole("button", { name: /sign to unlock/i }).click();
  await page.waitForURL("**/dashboard", { timeout: 30_000 });

  // Dashboard unlocked: Lock button, mail domain card (no domain yet)
  await expect(page.getByRole("button", { name: /^lock$/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /sign out/i })).toBeVisible();
  await expect(page.getByText("You are using Nanite's shared domain.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: /add your own domain/i }).click();
  await expect(page.getByRole("heading", { name: /add your mail domain/i })).toBeVisible();
  await shot(page, "43-dashboard-mail-domain");

  // Inbox
  await page.getByRole("button", { name: /^hide$/i }).click();
  await page.getByRole("link", { name: /open inbox/i }).first().click();
  const list = page.getByRole("navigation", { name: "Messages" });
  await expect(list.getByText("Welcome to Nanite")).toBeVisible({ timeout: 30_000 });
  await shot(page, "50-inbox-list", { full: false });
  await list.getByText("Welcome to Nanite").click();
  await expect(page.getByText("https://example.com/verify?token=abc")).toBeVisible();
  await expect(page.getByText(/links in this message \(shown as text, not clickable\)/i)).toBeVisible();
  await expect(page.getByText(/explorer shows only ciphertext/i)).toBeVisible();
  await expect(page.getByText("owned by your wallet").first()).toBeVisible();
  await shot(page, "51-message-detail");
  await page.getByTestId("keep-button").click();
  const group = page.getByRole("group", { name: "Keep for" });
  for (const d of [7, 30, 90, 182]) await expect(group.getByRole("button", { name: `${d} days` })).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: shotFile("52-keep-picker"), fullPage: false });
  await group.getByRole("button", { name: "30 days" }).click();
  await expect(page.getByTestId("keep-message")).toHaveText("Kept for 30 more days.");
  await list.getByText("Weekly digest (HTML)").click();
  await expect(page.getByText(/remote images blocked/i).first()).toBeVisible();
  await expect(page.getByText("sandboxed, scripts off")).toBeVisible();
  await expect(page.getByRole("button", { name: /show as text/i })).toBeVisible();
  await shot(page, "53-html-sandbox");
  await page.getByRole("tab", { name: /one-time codes/i }).click();
  await expect(page.getByLabel("Code 4 8 2 9 1 3")).toBeVisible();
  await expect(page.getByText(/expires in \d:\d\d/)).toBeVisible();
  await expect(page.getByText("valid", { exact: true })).toBeVisible();
  await shot(page, "54-otp", { full: false });

  // Lock and sign out
  await page.getByRole("button", { name: /^lock$/i }).click();
  await expect(page.getByRole("link", { name: /^unlock$/i })).toBeVisible();
  await page.getByRole("button", { name: /sign out/i }).click();
  await expect(page.getByText(/you are signed out/i)).toBeVisible();
  expect(problems.filter((p) => !/\/me\b|401/.test(p))).toEqual([]);
});

test("guide: /unlock without a session shows the sign-in step (anonymous)", async ({ page }) => {
  await mockAnonSession(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoOrFixme(page, "/unlock");
  await expect(page.getByRole("heading", { level: 1, name: /unlock your mailbox/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /connect metamask/i })).toBeVisible();
});
