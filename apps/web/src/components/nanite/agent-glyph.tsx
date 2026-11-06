import { cn } from "cn"

function hash(input: string) {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Deterministic 5x5 mirrored pixel glyph derived from the agent's name. */
export function AgentGlyph({ seed, className }: { seed: string; className?: string }) {
  let h = hash(seed)
  const cells: [number, number][] = []
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0
      if (h & 1) {
        cells.push([x, y])
        if (x < 2) cells.push([4 - x, y])
      }
    }
  }
  return (
    <svg
      viewBox="0 0 5 5"
      aria-hidden="true"
      shapeRendering="crispEdges"
      className={cn("size-full fill-primary", className)}
    >
      {cells.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" />
      ))}
    </svg>
  )
}
