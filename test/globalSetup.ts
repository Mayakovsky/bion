import { runMigrations } from '../src/db/migrate.js'

// Apply migrations once (idempotent) before the suite. Owner lane (bion_owner).
export default async function setup(): Promise<void> {
  const applied = await runMigrations()
  if (applied.length) console.log(`[globalSetup] applied migrations: ${applied.join(', ')}`)
}
