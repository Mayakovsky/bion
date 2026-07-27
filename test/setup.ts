import { afterAll } from 'vitest'
import { closePool } from '../src/db/pool.js'

// Close the runtime pool after each test file so the single fork exits cleanly.
// closePool() nulls the ref, so the next file transparently reopens.
afterAll(async () => {
  await closePool()
})
