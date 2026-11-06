"use client"

import * as React from "react"
import Link from "next/link"
import { ArrowRightIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useSession } from "@/lib/session-context"

/** Primary calls to action on the public home page. */
export function HomeActions() {
  const { session, refresh } = useSession()
  React.useEffect(() => {
    void refresh()
  }, [refresh])
  const authed = session.status === "authed"
  return (
    <>
      <Button size="lg" asChild>
        <Link href={authed ? "/dashboard" : "/onboarding"}>
          {authed ? "Open dashboard" : "Get started"}
          <ArrowRightIcon data-icon="inline-end" />
        </Link>
      </Button>
      {authed ? null : (
        <Button size="lg" variant="outline" asChild>
          <Link href="/dashboard">Sign in</Link>
        </Button>
      )}
    </>
  )
}
