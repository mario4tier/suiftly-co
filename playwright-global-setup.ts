/**
 * Playwright Global Setup/Teardown
 * Simple server health checks - no more complex restarts!
 * JWT expiry is now managed dynamically via /test/jwt-config API
 */

import { FullConfig } from '@playwright/test';

async function globalSetup(config: FullConfig) {
  // Detect which project is ACTUALLY running by checking CLI args
  // Playwright passes all configured projects to globalSetup, not just the one being run
  const cliArgs = process.argv.join(' ');

  // Check what project was explicitly requested via --project flag
  const isShortExpiryRun = cliArgs.includes('--project=short-expiry') || cliArgs.includes('--project short-expiry');
  const isNormalExpiryRun = cliArgs.includes('--project=normal-expiry') || cliArgs.includes('--project normal-expiry');
  const isChromiumRun = cliArgs.includes('--project=chromium') || cliArgs.includes('--project chromium');

  // If no explicit project specified, default to chromium (normal expiry)
  const noProjectSpecified = !isShortExpiryRun && !isNormalExpiryRun && !isChromiumRun;
  const shouldUseNormalExpiry = isNormalExpiryRun || isChromiumRun || noProjectSpecified;

  // Additional check: ensure at least one valid project is detected
  const hasValidProject = isShortExpiryRun || isNormalExpiryRun || isChromiumRun || noProjectSpecified;

  if (isShortExpiryRun) {
    console.log('🧪 Setting up for short-expiry tests (2s access, 10s refresh)...');
    console.log('ℹ️  Short expiry will be set via API (/test/jwt-config) - no server restart needed');

    // Just check if servers are running (no config validation needed)
    try {
      const apiCheck = await fetch('http://localhost:22700/health', { signal: AbortSignal.timeout(2000) });
      if (!apiCheck.ok) throw new Error('API not responding');
      console.log('✅ API server already running');
    } catch {
      console.log('❌ API server not running - please start with: ./scripts/dev/start-dev.sh');
      throw new Error('API server must be running before tests');
    }

    try {
      const webappCheck = await fetch('http://localhost:22710', { signal: AbortSignal.timeout(2000) });
      if (!webappCheck.ok) throw new Error('Webapp not responding');
      console.log('✅ Webapp already running');
    } catch {
      console.log('❌ Webapp not running - please start with: ./scripts/dev/start-dev.sh');
      throw new Error('Webapp must be running before tests');
    }

    console.log('✅ Dev servers ready (JWT expiry will be set dynamically by tests)');

  } else if (shouldUseNormalExpiry) {
    console.log('ℹ️  Setting up for normal tests (15m access, 30d refresh)...');

    // Just check if servers are running
    try {
      const apiCheck = await fetch('http://localhost:22700/health', { signal: AbortSignal.timeout(2000) });
      if (!apiCheck.ok) throw new Error('API not responding');
      console.log('✅ API server already running');
    } catch {
      console.log('❌ API server not running - please start with: ./scripts/dev/start-dev.sh');
      throw new Error('API server must be running before tests');
    }

    try {
      const webappCheck = await fetch('http://localhost:22710', { signal: AbortSignal.timeout(2000) });
      if (!webappCheck.ok) throw new Error('Webapp not responding');
      console.log('✅ Webapp already running');
    } catch {
      console.log('❌ Webapp not running - please start with: ./scripts/dev/start-dev.sh');
      throw new Error('Webapp must be running before tests');
    }

    console.log('✅ Dev servers ready with normal JWT expiry');

  } else if (!hasValidProject) {
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

  // Reset to real database clock (important for cleanup)
  try {
    await fetch('http://localhost:22700/test/clock/real', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    console.log('✅ Reset to real database clock');
  } catch {
    // Server might be down, that's ok
  }
}

export default globalSetup;
export { globalTeardown };
