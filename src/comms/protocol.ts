// Comms Protocol v1 (Phase E4) — messages are POINTERS, not payloads. An agent→agent message
// carries an intent, refs (addresses of the truth: paths/SHAs/task ids/diff ranges), the minimal
// fields needed to act, and an OPTIONAL terse note (≤ ~20 words). Richness lives in files the
// reader opens locally. Governance ledgers (decisions/FDQs/invariants) are exempt — they stay prose.

export const NOTE_WORD_CAP = 20

export interface PointerMessage {
  intent: string
  refs: string[]
  fields: Record<string, string>
  note?: string
}

export function pointer(
  intent: string,
  opts: { refs?: string[]; fields?: Record<string, string>; note?: string } = {},
): PointerMessage {
  return { intent, refs: opts.refs ?? [], fields: opts.fields ?? {}, note: opts.note }
}

/** Serialize to a compact, line-based, machine-legible body. */
export function serialize(msg: PointerMessage): string {
  const lines = [`@intent ${msg.intent}`]
  if (msg.refs.length) lines.push(`@refs ${msg.refs.join(',')}`)
  for (const [k, v] of Object.entries(msg.fields)) lines.push(`@field ${k}=${v}`)
  if (msg.note) lines.push(`@note ${msg.note}`)
  return lines.join('\n') + '\n'
}

export function parse(body: string): PointerMessage {
  const msg: PointerMessage = { intent: '', refs: [], fields: {} }
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('@intent ')) msg.intent = line.slice(8).trim()
    else if (line.startsWith('@refs ')) msg.refs = line.slice(6).split(',').map((s) => s.trim()).filter(Boolean)
    else if (line.startsWith('@field ')) {
      const rest = line.slice(7)
      const eq = rest.indexOf('=')
      if (eq > 0) msg.fields[rest.slice(0, eq).trim()] = rest.slice(eq + 1).trim()
    } else if (line.startsWith('@note ')) msg.note = line.slice(6).trim()
  }
  return msg
}

export interface ValidationResult {
  ok: boolean
  errors: string[]
}

/**
 * Validate the envelope. Terse ≠ lossy (rule 3): carry enough to act — an intent plus at least one
 * ref or field. The note, if present, is hard-capped at ~20 words.
 */
export function validate(msg: PointerMessage): ValidationResult {
  const errors: string[] = []
  if (!msg.intent) errors.push('missing intent')
  if (msg.refs.length === 0 && Object.keys(msg.fields).length === 0) {
    errors.push('under-specified: needs at least one ref or field')
  }
  if (msg.note && msg.note.trim().split(/\s+/).length > NOTE_WORD_CAP) {
    errors.push(`note exceeds ${NOTE_WORD_CAP} words`)
  }
  return { ok: errors.length === 0, errors }
}

/** True if a body is a Comms Protocol v1 pointer (has an @intent line). */
export function isPointer(body: string): boolean {
  return /^@intent\s+\S/m.test(body)
}
