/*
 * Post-unlock redirect target (`/unlock?next=<path>`). Only same-origin relative paths are accepted:
 * one leading "/", no "//", no backslash, no scheme, no control characters. Anything else is dropped,
 * so the unlock page can never be used as an open redirect.
 */
const MAX_NEXT = 512

export function safeNextPath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_NEXT) return null
  if (raw[0] !== "/" || raw[1] === "/") return null
  if (raw.includes("\\") || /[\u0000-\u001f\u007f]/.test(raw)) return null
  // Decoded forms must not smuggle a second slash, a backslash or a scheme either (e.g. /%2F/evil, /%5Cevil).
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return null
  }
  if (decoded.startsWith("//") || decoded.includes("\\") || /[\u0000-\u001f\u007f]/.test(decoded)) return null
  try {
    const u = new URL(raw, "http://nanite.invalid")
    if (u.origin !== "http://nanite.invalid") return null
  } catch {
    return null
  }
  // Never bounce back into the unlock page itself.
  if (raw === "/unlock" || raw.startsWith("/unlock?") || raw.startsWith("/unlock/")) return null
  return raw
}

/** `/unlock?next=<current path>`; the current path is validated, so an unsafe one yields plain `/unlock`. */
export function unlockHref(currentPath: string | null | undefined): string {
  const next = safeNextPath(currentPath)
  return next ? `/unlock?next=${encodeURIComponent(next)}` : "/unlock"
}
