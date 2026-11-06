"use client"

import * as React from "react"

/**
 * Current time in ms, refreshed every `intervalMs`. Returns null on the server
 * and during hydration so markup never depends on the server clock.
 */
export function useNow(intervalMs = 250): number | null {
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      const id = setInterval(onChange, intervalMs)
      return () => clearInterval(id)
    },
    [intervalMs]
  )
  const tick = React.useSyncExternalStore(
    subscribe,
    () => Math.floor(Date.now() / intervalMs),
    () => null
  )
  return tick === null ? null : tick * intervalMs
}
