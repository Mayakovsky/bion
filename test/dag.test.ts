import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createTask, CycleError, findCycle, assertAcyclic } from '../src/index.js'

describe('DAG enforcement (inv 14)', () => {
  it('findCycle detects a 2-node cycle and clears a chain', () => {
    expect(findCycle(new Map([['A', ['B']], ['B', ['A']]]))).not.toBeNull()
    expect(findCycle(new Map([['A', ['B']], ['B', ['C']], ['C', []]]))).toBeNull()
  })

  it('assertAcyclic throws on self-dependency', () => {
    expect(() => assertAcyclic('S', ['S'], new Map())).toThrow(CycleError)
  })

  it('createTask accepts an acyclic chain', async () => {
    const a = `t-${randomUUID()}`
    const b = `t-${randomUUID()}`
    await createTask({ id: a, title: 'root' })
    const created = await createTask({ id: b, title: 'child', dependencies: [a] })
    expect(created.dependencies).toEqual([a])
    expect(created.ratified).toBe(false)
  })

  it('createTask rejects a dependency cycle', async () => {
    const m1 = `t-${randomUUID()}`
    const m2 = `t-${randomUUID()}`
    // m1 forward-references m2 (deps are text[], not FK-enforced) ...
    await createTask({ id: m1, title: 'm1', dependencies: [m2] })
    // ... now m2 -> m1 closes the loop and must be rejected.
    await expect(createTask({ id: m2, title: 'm2', dependencies: [m1] })).rejects.toBeInstanceOf(
      CycleError,
    )
  })
})
