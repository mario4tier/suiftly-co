import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // CRITICAL: Production environment guard - runs before any tests
    globalSetup: ['../../scripts/test/vitest-global-setup.ts'],
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // Run tests sequentially to avoid database conflicts (like E2E tests)
    // All tests share the same database and may use the same wallet addresses
    pool: 'forks',
    maxWorkers: 1,
    isolate: false,
  },
});
