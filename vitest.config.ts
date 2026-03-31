import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // CRITICAL: Tests share a real PostgreSQL database.
    // Parallel file execution causes DB state pollution and flaky tests.
    fileParallelism: false,
  },
});
