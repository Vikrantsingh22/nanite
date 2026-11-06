import { createConfig, http } from "wagmi"
import { sepolia } from "wagmi/chains"
import { injected } from "wagmi/connectors"

/**
 * Injected wallets only (MetaMask and look-alikes). wagmi keeps just the last connector id in
 * localStorage; no key material ever touches browser storage.
 */
export const wagmiConfig = createConfig({
  chains: [sepolia],
  connectors: [injected()],
  transports: { [sepolia.id]: http() },
  ssr: true,
})
