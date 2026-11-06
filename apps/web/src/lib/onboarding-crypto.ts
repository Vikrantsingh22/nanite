/*
 * The key setup / unlock code lives in @nanite/crypto (onboarding.ts) so the live scripts run the exact
 * same code as the browser. Everything secret stays in this tab; only KeyBundle (public key, salts,
 * wrapped blobs) is ever sent to the server.
 */
export { probeDeterministicSignature, prepareKeys, unlockWithBundle } from "@nanite/crypto"
export type { PreparedKeys, Signer, UnlockedKeys, UnlockSecret, Wrapping } from "@nanite/crypto"

/** Rough passphrase strength hint (not a guarantee). */
export function passphraseStrength(p: string): { score: 0 | 1 | 2 | 3; label: string } {
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length
  const words = p.trim().split(/\s+/).filter(Boolean).length
  if (p.length < 12) return { score: 0, label: "Too short: use at least 12 characters" }
  if (p.length >= 20 || words >= 4) return { score: 3, label: "Strong" }
  if (p.length >= 16 || classes >= 3) return { score: 2, label: "Fair: longer is better" }
  return { score: 1, label: "Weak: add words or length" }
}
