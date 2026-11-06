"use client"

import * as React from "react"

import type { UnlockedKeys } from "@/lib/onboarding-crypto"

/*
 * In-memory key holder. The decrypted private key and seed live ONLY in this React state:
 * never localStorage, sessionStorage, IndexedDB or cookies. Reloading the tab locks.
 *
 * For T3.2 / T3.3 (inbox, agents): `const { keys, status } = useKeys()`; when status is "unlocked",
 * keys = { privateKey, publicKey (X25519, 32 B), seed (32 B), keyId (16 hex) }, directly usable with
 * decryptEmail(entity, { keyId, publicKey, privateKey }) and deriveAgentWallet(seed, i).
 * Treat the arrays as read-only; call lock() on logout.
 */
interface KeyContextValue {
  status: "locked" | "unlocked"
  keys: UnlockedKeys | null
  setKeys: (keys: UnlockedKeys) => void
  lock: () => void
}

const KeyContext = React.createContext<KeyContextValue | null>(null)

function wipe(k: UnlockedKeys | null) {
  k?.privateKey.fill(0)
  k?.seed.fill(0)
}

export function KeyProvider({ children }: { children: React.ReactNode }) {
  const [keys, setKeysState] = React.useState<UnlockedKeys | null>(null)
  const ref = React.useRef<UnlockedKeys | null>(null)

  const setKeys = React.useCallback((next: UnlockedKeys) => {
    if (ref.current && ref.current !== next) wipe(ref.current)
    ref.current = next
    setKeysState(next)
  }, [])
  const lock = React.useCallback(() => {
    wipe(ref.current)
    ref.current = null
    setKeysState(null)
  }, [])

  const value = React.useMemo<KeyContextValue>(
    () => ({ status: keys ? "unlocked" : "locked", keys, setKeys, lock }),
    [keys, setKeys, lock],
  )
  return <KeyContext.Provider value={value}>{children}</KeyContext.Provider>
}

export function useKeys(): KeyContextValue {
  const v = React.useContext(KeyContext)
  if (!v) throw new Error("useKeys must be used inside <KeyProvider>")
  return v
}
