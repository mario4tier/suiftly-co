/**
 * Playwright Global Setup/Teardown
 *
 * Ensures servers are running with correct config before tests start.
 * Starts servers automatically if needed, validates config if already running.
 * JWT expiry is managed dynamically via /test/jwt-config API.
 *
 * PRODUCTION GUARD: Tests MUST only run in development environments.
 */

import { FullConfig } from '@playwright/test';
import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';

/**
 * Find system.conf path
 */
function findSystemConf(): string | null {
  const path = '/etc/mhaxbe/system.conf';
  return existsSync(path) ? path : null;
}

/**
 * Check if this is a production environment by reading system.conf.
 * CRITICAL: Must run before any tests to prevent production data corruption.
 */
function checkNotProductionEnvironment(): void {
  const confPath = findSystemConf();

  if (confPath) {
    try {
      const content = readFileSync(confPath, 'utf8');
      if (/^ENVIRONMENT\s*=\s*production/mi.test(content) ||
          /^DEPLOYMENT_TYPE\s*=\s*production/mi.test(content)) {
        console.log('\n' + '='.repeat(70));
        console.log('\x1b[31m\x1b[1mFATAL: CANNOT RUN TESTS IN PRODUCTION ENVIRONMENT!\x1b[0m');
        console.log('='.repeat(70));
        console.log(`\nDetected: production environment in ${confPath}`);
        console.log('\nTests are ONLY allowed in development environments.');
        console.log('This prevents accidental data corruption or service disruption.');
        console.log('\nTo run tests, ensure your system.conf has:');
        console.log('  ENVIRONMENT=development');
        console.log('='.repeat(70) + '\n');
        process.exit(1);
      }
    } catch (err) {
      console.warn(`Warning: Could not read ${confPath}:`, err);
    }
  }

  // No production markers found - safe to proceed
  console.log('\x1b[32m✅ Environment check passed: Not a production environment\x1b[0m');
}

/**
 * Ensure dev servers are running with correct test config.
 * - If not running: start them via start-dev.sh
 * - If running: validate MOCK_AUTH is enabled (required for E2E tests)
 */
async function ensureDevServersReady(): Promise<void> {
  // Check API server health + config
  let apiRunning = false;
  try {
    const resp = await fetch('http://localhost:22700/health', { signal: AbortSignal.timeout(2000) });
    if (resp.ok) {
      const health = await resp.json() as { mockAuth?: boolean };
      apiRunning = true;
      if (!health.mockAuth) {
        console.error('❌ API server is running but MOCK_AUTH is not enabled.');
        console.error('   Tests require MOCK_AUTH=true. Restart with: ./scripts/dev/start-dev.sh');
        throw new Error('API server running without MOCK_AUTH — tests cannot proceed');
      }
      console.log('✅ API server running (MOCK_AUTH=true)');
    }
  } catch (err: any) {
    if (err.message?.includes('MOCK_AUTH')) throw err; // re-throw config error
  }

  // Check Webapp
  let webappRunning = false;
  try {
    const resp = await fetch('http://localhost:22710', { signal: AbortSignal.timeout(2000) });
    webappRunning = resp.ok;
    if (webappRunning) console.log('✅ Webapp running');
  } catch { /* not running */ }

  // If either server is down, start them
  if (!apiRunning || !webappRunning) {
    const missing = [!apiRunning && 'API', !webappRunning && 'Webapp'].filter(Boolean).join(', ');
    console.log(`⚙️  ${missing} not running — starting dev servers...`);
    try {
      execSync('./scripts/dev/start-dev.sh', { stdio: 'inherit', timeout: 60000 });
      console.log('✅ Dev servers started');
    } catch (err: any) {
      console.error('❌ Failed to start dev servers:', err.message);
      throw new Error('Could not start dev servers. Run manually: ./scripts/dev/start-dev.sh');
    }
  }
}

async function globalSetup(_config: FullConfig) {
  // CRITICAL: Check that we're not in a production environment
  // This must run FIRST before any other operations
  checkNotProductionEnvironment();

  // Detect which project is ACTUALLY running by checking CLI args
  // Playwright passes all configured projects to globalSetup, not just the one being run
  const cliArgs = process.argv.join(' ');

  // Check what project was explicitly requested via --project flag
  const isShortExpiryRun = cliArgs.includes('--project=short-expiry') || cliArgs.includes('--project short-expiry');
  const isNormalExpiryRun = cliArgs.includes('--project=normal-expiry') || cliArgs.includes('--project normal-expiry');
  const isChromiumRun = cliArgs.includes('--project=chromium') || cliArgs.includes('--project chromium');

  // Detect invalid --project values (e.g. --project=foobar)
  const hasProjectFlag = cliArgs.includes('--project=') || cliArgs.includes('--project ');
  const hasKnownProject = isShortExpiryRun || isNormalExpiryRun || isChromiumRun;

  if (hasProjectFlag && !hasKnownProject) {
    console.error('\n❌ ERROR: Tests must be run properly from the project root!\n');
    console.error('CLI args:', cliArgs);
    console.error('\n📋 To run ALL tests:');
    console.error('  npm run test:all');
    console.error('\n🎯 To run a specific test file:');
    console.error('  npx playwright test <test-file> --project=chromium');
    console.error('\n🎯 To run a specific test case:');
    console.error('  npx playwright test <test-file>:<line> --project=chromium');
    console.error('\n📝 Examples:');
    console.error('  npm run test:all                                               # Run all tests');
    console.error('  npx playwright test billing-operations.spec.ts --project=chromium  # Run entire file');
    console.error('  npx playwright test billing-operations.spec.ts:246 --project=chromium  # Run specific test');
    console.error('  npx playwright test token-refresh.spec.ts --project=short-expiry  # Token refresh tests\n');
    throw new Error('Test must be run with --project=chromium|normal-expiry|short-expiry from project root, or use npm run test:all');
  }

  if (isShortExpiryRun) {
    console.log('🧪 Setting up for short-expiry tests (2s access, 10s refresh)...');
    console.log('ℹ️  Short expiry will be set via API (/test/jwt-config) - no server restart needed');
  } else {
    console.log('ℹ️  Setting up for normal tests (15m access, 30d refresh)...');
  }

  // Ensure servers are running with correct config (shared for all projects)
  await ensureDevServersReady();
  console.log('✅ Dev servers ready');
}

async function globalTeardown() {
  // Clear any runtime JWT config overrides
  try {
    await fetch('http://localhost:22700/test/jwt-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clear: true }),
    });
    console.log('✅ Cleared runtime JWT config');
  } catch {
    // Server might be down, that's ok
  }

  // Reset to real database clock via GM (important for cleanup)
  // GM is the single source of truth for mock clock time
  try {
    await fetch('http://localhost:22600/api/test/clock/real', {
      method: 'POST',
    });
    console.log('✅ Reset to real database clock (via GM)');
  } catch {
    // GM might be down, that's ok
  }
}

export default globalSetup;
export { globalTeardown };
