"use client"

import * as React from "react"

/** Copy text to the clipboard; `copied` is true for 1.5s afterwards. */
export function useCopy(timeoutMs = 1500) {
  const [copied, setCopied] = React.useState(false)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const copy = React.useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        // Clipboard can be blocked (insecure origin); still show feedback.
      }
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), timeoutMs)
    },
    [timeoutMs]
  )

  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  return { copied, copy }
}
