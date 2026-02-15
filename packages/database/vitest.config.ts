import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // CRITICAL: Production environment guard - runs before any tests
    globalSetup: ['../../scripts/test/vitest-global-setup.ts'],
    // Run test files sequentially to avoid database conflicts.
    // isolate: true ensures each file gets its own execution context.
    fileParallelism: false,
    pool: 'forks',
    isolate: true,
    // Longer timeout for database operations
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
