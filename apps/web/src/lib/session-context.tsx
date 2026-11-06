"use client"

import * as React from "react"
import { useAccount, useChainId, useDisconnect, useSignMessage, useSwitchChain } from "wagmi"
import { createSiweMessage } from "viem/siwe"

import { api, type Me } from "@/lib/api"
import { authChainId } from "@/lib/config"
import { useKeys } from "@/lib/key-context"

type SessionState = { status: "loading" } | { status: "anon" } | { status: "authed"; me: Me }

interface SessionContextValue {
  session: SessionState
  refresh: () => Promise<Me | null>
  /** Pages that need the session call this once on mount (the cookie is HttpOnly; only the API can tell). */
  /** SIWE: nonce, wallet signature, verify. Throws on rejection. */
  signIn: () => Promise<Me>
  signOut: () => Promise<void>
}

const SessionContext = React.createContext<SessionContextValue | null>(null)

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = React.useState<SessionState>({ status: "loading" })
  const { address } = useAccount()
  const chainId = useChainId()
  const { switchChainAsync } = useSwitchChain()
  const { signMessageAsync } = useSignMessage()
  const { disconnect } = useDisconnect()
  const { lock } = useKeys()

  const refresh = React.useCallback(async () => {
    try {
      const me = await api<Me>("/me")
      setSession({ status: "authed", me })
      return me
    } catch {
      setSession({ status: "anon" })
      return null
    }
  }, [])

  const signIn = React.useCallback(async () => {
    if (!address) throw new Error("wallet_not_connected")
    if (chainId !== authChainId) await switchChainAsync({ chainId: authChainId })
    const { nonce } = await api<{ nonce: string }>("/auth/nonce")
    const message = createSiweMessage({
      address,
      chainId: authChainId,
      domain: window.location.host,
      nonce,
      uri: window.location.origin,
      version: "1",
      statement: "Sign in to Nanite. This does not unlock your mailbox and costs no gas.",
    })
    const signature = await signMessageAsync({ message })
    const me = await api<Me>("/auth/verify", { method: "POST", body: { message, signature } })
    setSession({ status: "authed", me })
    return me
  }, [address, chainId, switchChainAsync, signMessageAsync])

  const signOut = React.useCallback(async () => {
    lock()
    await api("/auth/logout", { method: "POST" }).catch(() => undefined)
    setSession({ status: "anon" })
    disconnect()
  }, [lock, disconnect])

  const value = React.useMemo(() => ({ session, refresh, signIn, signOut }), [session, refresh, signIn, signOut])
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionContextValue {
  const v = React.useContext(SessionContext)
  if (!v) throw new Error("useSession must be used inside <SessionProvider>")
  return v
}
