import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  pointer,
  serialize,
  parse,
  validate,
  isPointer,
  dispatchNext,
  KovAdapter,
  createTask,
  listInvariants,
  listFdqs,
} from '../src/index.js'
import { ratifyAsForces } from './helpers.js'

describe('Comms Protocol v1 (E4)', () => {
  it('serialize → parse round-trips a pointer message', () => {
    const m = pointer('review', { refs: ['task:T1', 'bion/T1'], fields: { task_id: 'T1', gate: 'forces' }, note: 'done, review then authorize' })
    expect(parse(serialize(m))).toEqual(m)
  })

  it('validate enforces intent, enough-to-act, and the note word cap', () => {
    expect(validate(pointer('dispatch', { fields: { task_id: 'x' } })).ok).toBe(true)
    expect(validate({ intent: '', refs: [], fields: {} }).ok).toBe(false) // missing intent
    expect(validate(pointer('dispatch')).ok).toBe(false) // under-specified: no refs/fields
    const longNote = Array.from({ length: 25 }, () => 'w').join(' ')
    expect(validate(pointer('dispatch', { fields: { a: 'b' }, note: longNote })).ok).toBe(false)
  })

  it('agent→agent dispatch packets conform to the envelope', async () => {
    const root = join(tmpdir(), `bion-mail-${randomUUID()}`)
    const kov = new KovAdapter({ mailRoot: root })
    const id = `t-${randomUUID()}`
    await createTask({ id, title: 'conformance', priority: 9_000_000 }) // top of the ratified backlog
    await ratifyAsForces(id)

    const out = await dispatchNext(kov)
    expect(out?.task.id).toBe(id)
    const poll = await kov.pollStatus()
    const msg = parse(poll.consumed[0]!.content)
    expect(validate(msg).ok).toBe(true)
    expect(msg.intent).toBe('dispatch')
    expect(msg.fields.task_id).toBe(id)
    expect(msg.refs.length).toBeGreaterThan(0)
  })

  it('governance ledgers stay human-readable prose (carve-out), not pointers', async () => {
    const inv = (await listInvariants()).find((i) => i.id === 'INV-5')!
    expect(isPointer(inv.statement)).toBe(false)
    expect(inv.statement).toMatch(/append-only/i) // readable prose

    const b3 = (await listFdqs()).find((f) => f.id === 'FDQ-B3')!
    expect(isPointer(b3.ruling ?? '')).toBe(false)
    expect((b3.ruling ?? '').length).toBeGreaterThan(20)
  })
})
