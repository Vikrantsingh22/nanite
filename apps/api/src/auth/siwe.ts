import { isAddress, isAddressEqual, recoverMessageAddress, type Hex } from "viem";
import { parseSiweMessage, validateSiweMessage } from "viem/siwe";

export interface SiweCheck {
  /** Expected domain (host of WEB_ORIGIN). */
  domain: string;
  /** Expected origin for the `uri` field. */
  origin: string;
  chainIds: number[];
  /** Max age of issuedAt, ms. */
  maxAgeMs?: number;
  now?: Date;
}

export type SiweResult =
  | { ok: true; address: string; nonce: string }
  | { ok: false; reason: "malformed" | "domain" | "chain" | "uri" | "expired" | "signature" };

/**
 * EIP-4361 verification for EOAs (ECDSA recovery, no RPC). Nonce consumption is the caller's job
 * (it must be atomic and happens after this returns ok).
 */
export async function checkSiwe(message: string, signature: string, c: SiweCheck): Promise<SiweResult> {
  const now = c.now ?? new Date();
  const parsed = parseSiweMessage(message);
  const { address, nonce, chainId, uri, issuedAt, version } = parsed;
  if (!address || !isAddress(address) || !nonce || !chainId || !uri || !issuedAt || version !== "1") {
    return { ok: false, reason: "malformed" };
  }
  if (!c.chainIds.includes(chainId)) return { ok: false, reason: "chain" };
  if (parsed.domain !== c.domain) return { ok: false, reason: "domain" };
  let uriOrigin: string;
  try {
    uriOrigin = new URL(uri).origin;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (uriOrigin !== c.origin) return { ok: false, reason: "uri" };
  const age = now.getTime() - issuedAt.getTime();
  if (age < -60_000 || age > (c.maxAgeMs ?? 5 * 60_000)) return { ok: false, reason: "expired" };
  // Checks domain/nonce presence, expirationTime and notBefore.
  if (!validateSiweMessage({ message: parsed, domain: c.domain, time: now })) return { ok: false, reason: "expired" };
  try {
    const recovered = await recoverMessageAddress({ message, signature: signature as Hex });
    if (!isAddressEqual(recovered, address)) return { ok: false, reason: "signature" };
  } catch {
    return { ok: false, reason: "signature" };
  }
  return { ok: true, address: address.toLowerCase(), nonce };
}
