"use client"

import * as React from "react"
import { ImageOffIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"

/*
 * Untrusted email HTML. Layers, outermost first:
 *  1. <iframe sandbox="">: no scripts, no same-origin (opaque origin), no forms, no popups, no top navigation.
 *  2. CSP meta inside the document: nothing loads except data: images and inline styles.
 *  3. A DOMParser pass (inert: it runs nothing and fetches nothing) that drops active elements and
 *     handlers and strips every non-data: image source, so a stray <meta refresh> or <base> cannot
 *     steer the frame and remote images are counted instead of requested.
 * The HTML is never inserted into this page's DOM (no dangerouslySetInnerHTML).
 */
export const EMAIL_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"

const DROP = "script,iframe,frame,frameset,object,embed,applet,form,meta,base,link,noscript,audio,video,source,track,portal"

export function buildEmailDocument(rawHtml: string): { srcDoc: string; blockedImages: number } {
  const dom = new DOMParser().parseFromString(rawHtml, "text/html")
  dom.querySelectorAll(DROP).forEach((n) => n.remove())
  let blocked = 0
  dom.querySelectorAll("img,image,picture source").forEach((el) => {
    const src = el.getAttribute("src") ?? ""
    if (!/^data:image\//i.test(src)) {
      if (src) blocked++
      el.removeAttribute("src")
      el.setAttribute("alt", el.getAttribute("alt") ?? "[remote image blocked]")
    }
    el.removeAttribute("srcset")
  })
  dom.querySelectorAll("*").forEach((el) => {
    for (const a of Array.from(el.attributes)) {
      if (/^on/i.test(a.name) || (a.name === "style" && /url\s*\(|expression\s*\(/i.test(a.value))) el.removeAttribute(a.name)
      if (/^(background|poster|ping)$/i.test(a.name)) el.removeAttribute(a.name)
    }
    if (el.tagName === "A") {
      el.removeAttribute("href") // links are listed separately as text; nothing in the frame is clickable
      el.removeAttribute("target")
    }
  })
  const css = "body{font:14px/1.5 system-ui,sans-serif;margin:12px;overflow-wrap:anywhere}img{max-width:100%;height:auto}"
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${EMAIL_CSP}"><style>${css}</style>`
  return {
    srcDoc: `<!doctype html><html><head>${head}</head><body>${dom.body?.innerHTML ?? ""}</body></html>`,
    blockedImages: blocked,
  }
}

export function SandboxedHtml({ html, title = "Email content" }: { html: string; title?: string }) {
  const built = React.useMemo(() => buildEmailDocument(html), [html])
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">
          <ImageOffIcon data-icon="inline-start" />
          remote images blocked{built.blockedImages > 0 ? ` (${built.blockedImages})` : ""}
        </Badge>
        <span className="font-mono text-xs text-muted-foreground">sandboxed, scripts off</span>
      </div>
      {/* White canvas on purpose: email HTML assumes a light background. */}
      <iframe
        title={title}
        sandbox=""
        srcDoc={built.srcDoc}
        referrerPolicy="no-referrer"
        loading="lazy"
        className="h-96 w-full rounded-md border bg-white"
      />
    </div>
  )
}
