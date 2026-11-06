import { cn } from "cn"

import { glyphCells, hash } from "./agent-glyph"

export type AgentMascotStatus = "active" | "provisioning" | "revoked" | "failed"

type Px = readonly [x: number, y: number, w?: number, h?: number]

function Rects({ r, className }: { r: readonly Px[]; className?: string }) {
  return (
    <>
      {r.map(([x, y, w = 1, h = 1]) => (
        <rect key={`${x}-${y}-${w}-${h}`} x={x} y={y} width={w} height={h} className={className} />
      ))}
    </>
  )
}

// Antenna tip pixels (the light), one set per variant. The stalk is fixed below.
const TIPS: readonly (readonly Px[])[] = [
  [[6, 0, 3, 1]], // wide bulb
  [[7, 0]], // single pixel
  [[6, 0], [8, 0]], // fork
  [[7, 1], [8, 0]], // bent
]
const STALKS: readonly (readonly Px[])[] = [
  [[7, 1, 1, 2]],
  [[7, 1, 1, 2]],
  [[6, 1], [8, 1], [7, 2]],
  [[7, 2]],
]
const EARS: readonly (readonly Px[])[] = [[], [[1, 5, 1, 3], [13, 5, 1, 3]], [[0, 5, 2, 3], [13, 5, 2, 3]]]
const FOREHEAD: readonly (readonly Px[])[] = [[], [[4, 3], [10, 3]], [[6, 3, 3, 1]]]
const MOUTH: readonly (readonly Px[])[] = [[], [[6, 8, 3, 1]], [[6, 7], [7, 8], [8, 7]]]
// Eye boxes: [x of left eye, width, y, height]; the right eye mirrors around column 7.
const EYES: readonly (readonly [number, number, number, number])[] = [
  [5, 1, 5, 2],
  [4, 2, 5, 2],
  [4, 2, 6, 1],
  [5, 1, 6, 1],
]

const LABEL: Record<AgentMascotStatus, string> = {
  active: "active",
  provisioning: "setting up",
  revoked: "revoked, asleep",
  failed: "failed",
}

/**
 * Nanite's pet-like pixel bot. Appearance is deterministic from the seed (antenna, eyes, ears,
 * forehead mark, mouth); the agent's 5x5 identity glyph sits on its chest panel.
 * Animation is CSS only (see `.mascot` in globals.css) and is off under prefers-reduced-motion.
 * Add `data-mascot-host` to an ancestor to make hover/focus-within trigger a reaction.
 */
export function AgentMascot({
  seed,
  status = "active",
  label,
  className,
}: {
  seed: string
  status?: AgentMascotStatus
  /** Name used in the accessible label; defaults to the seed. */
  label?: string
  className?: string
}) {
  const h = hash(`mascot:${seed}`)
  const antenna = h & 3
  const eye = (h >> 2) & 3
  const ears = ((h >> 4) & 7) % 3
  const brow = ((h >> 7) & 7) % 3
  const mouth = ((h >> 10) & 7) % 3
  const delay = -(((h >> 13) & 255) / 255) * 6
  const dur = 4.6 + (((h >> 21) & 15) / 15) * 2.4

  const [ex, ew, ey, eh] = EYES[eye]!
  const rx = 15 - ex - ew
  const awake = status === "active"
  const working = status === "provisioning"
  const asleep = status === "revoked"
  const failed = status === "failed"

  return (
    <svg
      viewBox="0 0 15 16"
      role="img"
      aria-label={`AI agent ${label ?? seed}, ${LABEL[status]}`}
      shapeRendering="crispEdges"
      data-state={status}
      className={cn("mascot", className)}
      style={
        { "--mascot-delay": `${delay.toFixed(2)}s`, "--mascot-dur": `${dur.toFixed(2)}s` } as React.CSSProperties
      }
    >
      <g className="mascot-bot">
        {/* antenna */}
        <Rects r={STALKS[antenna]!} className="m-shell" />
        <Rects r={TIPS[antenna]!} className="m-tip mascot-tip" />
        {/* ears */}
        <Rects r={EARS[ears]!} className="m-shell" />
        {/* head + screen */}
        <Rects r={[[3, 3, 9, 1], [2, 4, 11, 5], [3, 9, 9, 1]]} className="m-shell" />
        <Rects r={FOREHEAD[brow]!} className="m-ink" />
        <rect x="3" y="4" width="9" height="5" className="m-screen" />
        {/* face */}
        {awake && (
          <g className="mascot-eyes">
            <Rects r={[[ex, ey, ew, eh], [rx, ey, ew, eh]]} className="m-ink" />
          </g>
        )}
        {working && (
          <g className="m-ink">
            <rect x="5" y="6" width="1" height="1" className="mascot-dot" style={{ animationDelay: "0s" }} />
            <rect x="7" y="6" width="1" height="1" className="mascot-dot" style={{ animationDelay: "0.25s" }} />
            <rect x="9" y="6" width="1" height="1" className="mascot-dot" style={{ animationDelay: "0.5s" }} />
          </g>
        )}
        {asleep && <Rects r={[[4, 6, 3, 1], [8, 6, 3, 1]]} className="m-ink" />}
        {failed && (
          <Rects
            r={[[4, 5], [6, 5], [5, 6], [4, 7], [6, 7], [8, 5], [10, 5], [9, 6], [8, 7], [10, 7]]}
            className="m-ink"
          />
        )}
        {(awake || working) && <Rects r={MOUTH[mouth]!} className="m-ink-dim" />}
        {failed && <Rects r={[[6, 8, 3, 1]]} className="m-ink-dim" />}
        {/* body, arms, chest panel with the identity glyph */}
        <Rects r={[[4, 10, 7, 6]]} className="m-shell" />
        <Rects r={[[3, 11, 1, 3]]} className="m-shell" />
        <g className="mascot-arm-r">
          <Rects r={[[11, 11, 1, 3]]} className="m-shell" />
        </g>
        <rect x="5" y="10" width="5" height="5" className="m-screen" />
        <g className="m-ink">
          {glyphCells(seed).map(([x, y]) => (
            <rect key={`${x}-${y}`} x={5 + x} y={10 + y} width="1" height="1" />
          ))}
        </g>
        <Rects r={[[4, 15, 2, 1], [9, 15, 2, 1]]} className="m-ink-dim" />
      </g>
      {asleep && (
        <g className="mascot-z m-ink">
          <Rects r={[[12, 0, 3, 1], [14, 1], [13, 2], [12, 3, 3, 1]]} />
        </g>
      )}
    </svg>
  )
}
