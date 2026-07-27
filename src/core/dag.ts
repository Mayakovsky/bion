// Task-dependency DAG enforcement (spec §4, inv 14).
// Edge semantics: an edge id -> dep means "task `id` depends on `dep`".
// A cycle among those edges is rejected.

export class CycleError extends Error {
  readonly cycle: string[]
  constructor(cycle: string[]) {
    super(`task dependency cycle: ${cycle.join(' -> ')}`)
    this.name = 'CycleError'
    this.cycle = cycle
  }
}

/**
 * Return a cycle (as a node path) if the graph contains one, else null.
 * Iterative DFS with three-color marking so a deep/wide graph won't blow the stack.
 */
export function findCycle(edges: Map<string, string[]>): string[] | null {
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  const nodes = new Set<string>(edges.keys())
  for (const deps of edges.values()) for (const d of deps) nodes.add(d)
  for (const n of nodes) color.set(n, WHITE)

  for (const start of nodes) {
    if (color.get(start) !== WHITE) continue
    // stack frames carry the node and an index into its dep list
    const stack: { node: string; i: number }[] = [{ node: start, i: 0 }]
    const path: string[] = [start]
    color.set(start, GRAY)

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      const deps = edges.get(frame.node) ?? []
      if (frame.i < deps.length) {
        const next = deps[frame.i]!
        frame.i++
        const c = color.get(next)
        if (c === GRAY) {
          // back-edge: cycle from `next` around to itself
          const idx = path.indexOf(next)
          return [...path.slice(idx), next]
        }
        if (c === WHITE) {
          color.set(next, GRAY)
          path.push(next)
          stack.push({ node: next, i: 0 })
        }
      } else {
        color.set(frame.node, BLACK)
        stack.pop()
        path.pop()
      }
    }
  }
  return null
}

/**
 * Assert that adding/updating `nodeId` with `deps` keeps the graph acyclic, given the
 * existing edges. Throws CycleError on a cycle (self-dependency included).
 */
export function assertAcyclic(
  nodeId: string,
  deps: string[],
  existingEdges: Map<string, string[]>,
): void {
  const edges = new Map(existingEdges)
  edges.set(nodeId, deps)
  const cycle = findCycle(edges)
  if (cycle) throw new CycleError(cycle)
}
