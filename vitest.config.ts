import { defineConfig } from 'vitest/config'

// Tests share one local Postgres. Run serially in a single fork so DB-touching
// specs don't race on counts / dedup keys.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    // testEnv.ts first: forces BION_DATABASE_URL/BION_MIGRATE_URL to .env.test's bion_test
    // before test/setup.ts (which imports src/db/pool.js -> src/env.js) can lock in .env.local's
    // values (directive-23 Part A).
    setupFiles: ['test/testEnv.ts', 'test/setup.ts'],
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    teardownTimeout: 10_000,
  },
})
