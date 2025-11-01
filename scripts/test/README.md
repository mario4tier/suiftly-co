# Test Scripts

This directory contains test automation scripts for the Suiftly project.

## run-all.ts

Comprehensive test runner that executes ALL tests in the project.

### What it runs

1. **API Unit Tests** (Vitest)
   - Cookie security tests
   - Auth flow tests
   - All unit tests in `apps/api/tests/`

2. **E2E Tests - Normal Expiry** (Playwright)
   - Tests with production JWT config (15m access, 30d refresh)
   - Verifies tokens work correctly over time

3. **E2E Tests - Short Expiry** (Playwright)
   - Tests with test JWT config (2s access, 10s refresh)
   - Simulates 30-day lifecycle in ~15 seconds
   - Tests auto-refresh and token expiry
   - Starts test servers automatically via global setup
   - Includes automatic retry (up to 2 retries) for timing-sensitive tests

4. **E2E Tests - Other** (Playwright)
   - Dashboard, seal config, and other E2E tests

### Usage

**Prerequisites:**
- PostgreSQL database must be running with `suiftly_dev` database
- No manual server setup needed! The test runner manages servers automatically

**Run all tests:**
```bash
# Using npm script (recommended) - fully self-contained!
npm run test:all

# Direct execution
./scripts/test/run-all.ts

# Using tsx
tsx scripts/test/run-all.ts
```

**How it works:**
1. Checks if dev servers are running on ports 3000/5173
2. If not running, starts them automatically
3. Runs all test suites in sequence (unit → E2E normal → E2E short → E2E chromium)
4. Cleans up (stops servers if we started them, leaves existing servers alone)

The test runner is **fully robust** and can run in any environment - whether servers are running or not!

### Output

The script provides:
- Real-time test output from each suite
- Colored status indicators (✅/❌)
- Duration for each test suite
- Comprehensive summary at the end
- Exit code 0 (success) or 1 (failure)

### Example Output

```
================================================================================
SUIFTLY TEST RUNNER - Running All Tests
================================================================================

▶ Running: API Unit Tests
Command: npm run test --workspace=@suiftly/api -- --run
✅ API Unit Tests passed (3.45s)

▶ Running: E2E Tests - Normal Expiry (15m/30d)
Command: npx playwright test --project=normal-expiry
✅ E2E Tests - Normal Expiry (15m/30d) passed (12.34s)

▶ Running: E2E Tests - Short Expiry (2s/10s)
Command: npx playwright test --project=short-expiry
✅ E2E Tests - Short Expiry (2s/10s) passed (18.67s)

▶ Running: E2E Tests - Other
Command: npx playwright test --project=chromium
✅ E2E Tests - Other passed (8.92s)

================================================================================
TEST SUMMARY
================================================================================

✅ API Unit Tests - 3.45s
✅ E2E Tests - Normal Expiry (15m/30d) - 12.34s
✅ E2E Tests - Short Expiry (2s/10s) - 18.67s
✅ E2E Tests - Other - 8.92s

────────────────────────────────────────────────────────────────────────────────
Total: 4 test suites | 4 passed | 0 failed | 43.38s

✅ All tests passed! 🎉
```

## Other Scripts

### start-test-api.sh

Starts the API server with test configuration (short JWT expiry for testing).

**Environment:**
- `NODE_ENV=development`
- `ENABLE_SHORT_JWT_EXPIRY=true`
- `JWT_SECRET=TEST_DEV_SECRET_1234567890abcdef`
- `MOCK_AUTH=true`
- 2s access token, 10s refresh token

**Usage:**
```bash
./scripts/test/start-test-api.sh
```

The PID is written to `/tmp/suiftly-api-test.pid` and logs to `/tmp/suiftly-api-test.log`.

### start-test-servers.sh

Starts both API and webapp servers with test configuration.

**Usage:**
```bash
./scripts/test/start-test-servers.sh
```

## Notes

- **Server Management (Fully Automatic):**
  - The test runner automatically detects if dev servers are running
  - If not running, it starts them and manages their lifecycle
  - Short expiry tests kill existing servers and start test servers with short JWT config (via Playwright global setup)
  - After short expiry tests, dev servers are restarted for chromium tests
  - Cleanup happens automatically - servers started by the test runner are stopped, existing servers are left alone
  - **Individual test projects are also self-contained:**
    - Running `npx playwright test --project=short-expiry` cleans up ports and starts test servers
    - Running `npx playwright test --project=normal-expiry` or `--project=chromium` checks if dev servers are running and fails fast with a clear message if they're not

- **Test Execution:**
  - The test runner uses sequential execution to avoid race conditions
  - Timing-sensitive tests (e.g., token expiry) include automatic retries for robustness
  - Short-expiry tests have 1 automatic retry configured
  - Port conflict resolution: short-expiry tests forcefully clean up ports 3000/5173/5174/5175 before starting

- **Database:**
  - Database migrations should be run before tests: `npm run db:push`
  - Tests use the `suiftly_dev` database by default

- **Running in Any Order:**
  - Tests are robust and can run in any order
  - Each test gets the servers it needs, regardless of what came before
  - The global setup ([playwright-global-setup.ts](/playwright-global-setup.ts)) handles project-specific server requirements
