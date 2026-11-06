"use client"

import * as React from "react"

type RGB = [number, number, number]

let ctx: CanvasRenderingContext2D | null = null

function getCtx() {
  if (!ctx) {
    const c = document.createElement("canvas")
    c.width = c.height = 1
    ctx = c.getContext("2d", { willReadFrequently: true })
  }
  return ctx
}

/** Resolve a CSS var token to a computed color string. */
function computed(token: string): string {
  const el = document.createElement("span")
  el.style.color = `var(--${token})`
  document.body.appendChild(el)
  const value = getComputedStyle(el).color
  el.remove()
  return value
}

/** Resolve token to sRGB, compositing translucent colors over `over`. */
function resolve(token: string, over?: RGB): RGB {
  const c = getCtx()
  if (!c) return [0, 0, 0]
  c.clearRect(0, 0, 1, 1)
  if (over) {
    c.fillStyle = `rgb(${over.join(",")})`
    c.fillRect(0, 0, 1, 1)
  }
  c.fillStyle = computed(token)
  c.fillRect(0, 0, 1, 1)
  const d = c.getImageData(0, 0, 1, 1).data
  return [d[0], d[1], d[2]]
}

function luminance([r, g, b]: RGB) {
  const f = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

export function contrastRatio(a: RGB, b: RGB) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

export function toHex([r, g, b]: RGB) {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")
}

function subscribeTheme(cb: () => void) {
  const obs = new MutationObserver(cb)
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
  return () => obs.disconnect()
}

/**
 * Live measurement of `fg` token on `bg` token ("hex|ratio"), re-measured when the
 * theme class changes. Server and hydration render a placeholder.
 */
export function useTokenMeasure(fg: string, bg: string): { hex: string; ratio: number | null } {
  const snap = React.useSyncExternalStore(
    subscribeTheme,
    () => {
      const back = resolve(bg)
      const front = resolve(fg, back)
      return `${toHex(front)}|${contrastRatio(front, back).toFixed(2)}`
    },
    () => "|"
  )
  const [hex, ratio] = snap.split("|")
  return { hex: hex || "······", ratio: ratio ? Number(ratio) : null }
}
