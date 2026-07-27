import { BaseAdapter } from './baseAdapter.js'

/**
 * KovAdapter — the implementer agent. wake_mode=auto: Kov reads/writes its mailbox via native
 * local filesystem with NO MCP dependence in the executing lane (spec §5).
 */
export class KovAdapter extends BaseAdapter {
  constructor(opts: { mailRoot?: string } = {}) {
    super({
      id: 'kov',
      capabilities: ['implementer', 'terminal', 'commit'],
      wakeMode: 'auto',
      mailRoot: opts.mailRoot,
    })
  }
}
