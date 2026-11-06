import type { Metadata } from "next"

import { UnlockView } from "@/components/onboarding/unlock-view"
import { safeNextPath } from "@/lib/safe-next"

export const metadata: Metadata = { title: "Unlock | Nanite" }

export default async function UnlockPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams
  // Only a same-origin relative path survives; anything else is dropped here and again in the view.
  return <UnlockView next={safeNextPath(Array.isArray(next) ? next[0] : next)} />
}
