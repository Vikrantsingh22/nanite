import type { BrowserContext, Page } from "@playwright/test";

export const MOCK_WALLET = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
export const MOCK_SIG = "0x" + "ab".repeat(65);

/** Injects a fake EIP-1193 `window.ethereum` (same shape the specs use) so the connect step works without MetaMask. */
export async function injectMockWallet(target: Page | BrowserContext) {
  await target.addInitScript(
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
    { wallet: MOCK_WALLET, sig: MOCK_SIG },
  );
}
