import './testEnv.js' // must run before runMigrations pulls in src/env.js (directive-23 Part A)
import { runMigrations } from '../src/db/migrate.js'

// Apply migrations once (idempotent) before the suite. Owner lane (bion_owner). Targets
// bion_test, not bion — see test/testEnv.ts.
export default async function setup(): Promise<void> {
  const applied = await runMigrations()
  if (applied.length) console.log(`[globalSetup] applied migrations: ${applied.join(', ')}`)
}
