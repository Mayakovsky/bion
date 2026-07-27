import { defineConfig } from 'vitest/config'

// Tests share one local Postgres. Run serially in a single fork so DB-touching
// specs don't race on counts / dedup keys.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    setupFiles: ['test/setup.ts'],
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    teardownTimeout: 10_000,
  },
})
