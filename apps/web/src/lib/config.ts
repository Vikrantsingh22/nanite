/** Base URL of the Nanite API service (apps/api), without a trailing slash. */
export const apiBaseUrl: string = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000").replace(/\/+$/, "");

/** Chain the API accepts in SIWE messages and where usernames are registered (Sepolia by default). */
export const authChainId: number = Number(process.env.NEXT_PUBLIC_AUTH_CHAIN_ID ?? "11155111");

/** Domain of shared-domain mailboxes (`<agent>.<user>@<domain>`); display only, the API owns the real value. */
export const SHARED_MAIL_DOMAIN: string = process.env.NEXT_PUBLIC_SHARED_MAIL_DOMAIN || "nanitecom.itsvikrant.tech";

export const ETHERSCAN_TX = "https://sepolia.etherscan.io/tx/";
export const ENS_PARENT = "nanitecom.eth";
