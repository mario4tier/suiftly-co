import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // CRITICAL: Production environment guard - runs before any tests
    globalSetup: ['../../scripts/test/vitest-global-setup.ts'],
    // Run tests sequentially to avoid database conflicts
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Longer timeout for database operations
    testTimeout: 30000,
  },
});
