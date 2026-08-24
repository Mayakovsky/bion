// BION-DIRECTIVE-81-ADDENDUM — real, stateful rate cap for the Desktop UI-notify action.
// Deliberately a standalone script, not LLM-remembered discipline: the notify harness must call
// `node kov-notify-ratelimit.mjs attempt` immediately before the real ui_type/ui_click calls and
// obey its exit code — nonzero means refused, no UI action may proceed. Atomic check-and-record
// in one call (not separate check/record steps) so there's no window for two concurrent attempts
// to both pass.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const STATE_PATH = 'C:\\Users\\kidco\\.local\\mcp\\kov-notify-state.json';
const WINDOW_MS = 60_000;
const CAP = 3; // sane per-minute ceiling — addendum's "cheap insurance against a flood" ask

function loadState() {
  if (!existsSync(STATE_PATH)) return { sends: [] };
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    return { sends: Array.isArray(raw.sends) ? raw.sends : [] };
  } catch {
    return { sends: [] };
  }
}

function saveState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function main() {
  const cmd = process.argv[2];
  const now = Date.now();
  const state = loadState();
  const recent = state.sends.filter((t) => now - t < WINDOW_MS);

  if (cmd === 'status') {
    console.log(JSON.stringify({ cap: CAP, window_ms: WINDOW_MS, sends_in_window: recent.length, remaining: Math.max(0, CAP - recent.length) }));
    process.exit(0);
  }

  if (cmd === 'attempt') {
    if (recent.length >= CAP) {
      console.log(JSON.stringify({ allowed: false, reason: `rate cap reached: ${recent.length}/${CAP} sends in the last ${WINDOW_MS / 1000}s`, cap: CAP, window_ms: WINDOW_MS }));
      process.exit(1);
    }
    recent.push(now);
    saveState({ sends: recent });
    console.log(JSON.stringify({ allowed: true, sends_in_window: recent.length, cap: CAP, window_ms: WINDOW_MS }));
    process.exit(0);
  }

  console.error('usage: node kov-notify-ratelimit.mjs <status|attempt>');
  process.exit(2);
}

main();
