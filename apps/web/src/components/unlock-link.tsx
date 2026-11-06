"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"

import { unlockHref } from "@/lib/safe-next"

/** Link to `/unlock` that returns to the page it was rendered on once the mailbox is unlocked. */
export function UnlockLink(props: Omit<React.ComponentProps<typeof Link>, "href">) {
  const pathname = usePathname()
  return <Link {...props} href={unlockHref(pathname)} />
}
