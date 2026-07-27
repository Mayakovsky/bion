import { BaseAdapter } from './baseAdapter.js'

/**
 * DesktopAdapter — the architect agent. wake_mode=user_initiated: Desktop reads its inbox at
 * session start (filesystem-first; MCP is convenience only, never load-bearing — spec §5).
 */
export class DesktopAdapter extends BaseAdapter {
  constructor(opts: { mailRoot?: string } = {}) {
    super({
      id: 'desktop',
      capabilities: ['architect', 'spec-author', 'review'],
      wakeMode: 'user_initiated',
      mailRoot: opts.mailRoot,
    })
  }
}
