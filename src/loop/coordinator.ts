import { dispatchNext, type DispatchOutcome } from './dispatcher.js'
import { reportCompletion, type CompletionOutcome, type NotifyFn } from './monitor.js'
import type { AgentAdapter } from '../adapters/types.js'

// Coordinator — thin composition of the event loop's moving parts (dispatcher + state monitor
// + notifier). The loop is hands-free UP TO the gate: dispatch and state updates proceed
// autonomously; push/merge/tag/deploy/spend still stop at the Forces gate (spec §7, Gate C).

export interface CoordinatorDeps {
  kov: AgentAdapter
  desktop: AgentAdapter
  notify?: NotifyFn
}

export class Coordinator {
  constructor(private readonly deps: CoordinatorDeps) {}

  /** Dispatch the next ratified, dependency-satisfied task to Kov (or null if none). */
  dispatchNext(): Promise<DispatchOutcome | null> {
    return dispatchNext(this.deps.kov)
  }

  /** Handle a completion signal: detect → update → notify → queue review (idempotent). */
  reportCompletion(taskId: string, source = 'kov'): Promise<CompletionOutcome> {
    return reportCompletion(taskId, source, { desktop: this.deps.desktop, notify: this.deps.notify })
  }
}
