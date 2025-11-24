import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
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
