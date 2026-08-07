import { config } from 'dotenv'
import { repoPath } from '../src/paths.js'

// Must load before anything imports src/env.js: src/env.ts's own `config({ path: resolveEnvPath() })`
// runs at module-import time and does NOT override already-set vars, so loading .env.test here
// first (override: true) makes it win deterministically over .env.local — no race (directive-23
// Part A). Imports only src/paths.js, which has no env.js side effect, so importing this file
// itself never triggers env.ts's load early.
config({ path: repoPath('.env.test'), override: true })
