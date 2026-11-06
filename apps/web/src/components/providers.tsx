"use client"

import * as React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { WagmiProvider } from "wagmi"

import { KeyProvider } from "@/lib/key-context"
import { SessionProvider } from "@/lib/session-context"
import { wagmiConfig } from "@/lib/wagmi"

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = React.useState(() => new QueryClient())
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <KeyProvider>
          <SessionProvider>{children}</SessionProvider>
        </KeyProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
