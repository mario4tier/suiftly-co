/**
 * Playwright Global Setup/Teardown
 * Robust server management with config verification and graceful shutdown
 */

import { FullConfig } from '@playwright/test';
import { spawn, ChildProcess } from 'child_process';
import {
  ensureCorrectServer,
  shutdownServer,
  waitForServer,
  waitForPortFree,
  ExpectedConfig,
} from './playwright-test-utils';

let apiServer: ChildProcess | null = null;
let webappServer: ChildProcess | null = null;

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

    const expectedConfig: ExpectedConfig = {
      shortJWTExpiry: true,
      jwtAccessExpiry: '2s',
      jwtRefreshExpiry: '10s',
      mockAuth: true,
    };

    // Check if correct server is already running
    const apiStatus = await ensureCorrectServer(
      'http://localhost:3000/health',
      3000,
      expectedConfig
    );

    if (apiStatus.needsRestart) {
      console.log(`🔄 API server needs restart: ${apiStatus.reason}`);
      await shutdownServer('http://localhost:3000', 3000, 'API server');
      await waitForPortFree(3000);

      // Start test API server with short JWT expiry
      console.log('🚀 Starting API server with short JWT expiry...');
      apiServer = spawn('npx', ['tsx', 'apps/api/src/server.ts'], {
        env: {
          ...process.env,
          NODE_ENV: 'development',
          ENABLE_SHORT_JWT_EXPIRY: 'true',
          JWT_SECRET: 'TEST_DEV_SECRET_1234567890abcdef',
          MOCK_AUTH: 'true',
          DATABASE_URL: 'postgresql://deploy:deploy_password_change_me@localhost/suiftly_dev',
        },
        stdio: 'inherit',
      });

      await waitForServer('http://localhost:3000/health');
    }

    // Check webapp (webapp doesn't have config, so just check if it's running)
    try {
      const webappCheck = await fetch('http://localhost:5173', { signal: AbortSignal.timeout(2000) });
      if (!webappCheck.ok) throw new Error('Webapp not responding');
      console.log('✅ Webapp already running');
    } catch {
      console.log('🔄 Webapp needs restart');
      await shutdownServer('http://localhost:5173', 5173, 'Webapp');
      await waitForPortFree(5173);

      console.log('🚀 Starting webapp...');
      webappServer = spawn('npm', ['run', 'dev'], {
        cwd: 'apps/webapp',
        env: process.env,
        stdio: 'inherit',
      });

      await waitForServer('http://localhost:5173');
    }

    console.log('✅ Test servers ready with short JWT expiry');

  } else if (shouldUseNormalExpiry) {
    console.log('ℹ️  Setting up for normal tests (15m access, 30d refresh)...');

    const expectedConfig: ExpectedConfig = {
      shortJWTExpiry: false,
      jwtAccessExpiry: '15m',
      jwtRefreshExpiry: '30d',
      mockAuth: true,
    };

    // Check if correct server is running
    const apiStatus = await ensureCorrectServer(
      'http://localhost:3000/health',
      3000,
      expectedConfig
    );

    if (apiStatus.needsRestart) {
      console.log(`🔄 API server needs restart: ${apiStatus.reason}`);
      await shutdownServer('http://localhost:3000', 3000, 'API server');
      await waitForPortFree(3000);

      // Start API server with normal JWT expiry
      console.log('🚀 Starting API server with normal JWT expiry...');
      apiServer = spawn('npx', ['tsx', 'apps/api/src/server.ts'], {
        env: {
          ...process.env,
          NODE_ENV: 'development',
          JWT_SECRET: 'TEST_DEV_SECRET_1234567890abcdef',
          MOCK_AUTH: 'true',
          DATABASE_URL: 'postgresql://deploy:deploy_password_change_me@localhost/suiftly_dev',
        },
        stdio: 'inherit',
      });

      await waitForServer('http://localhost:3000/health');
    }

    // Check webapp
    try {
      const webappCheck = await fetch('http://localhost:5173', { signal: AbortSignal.timeout(2000) });
      if (!webappCheck.ok) throw new Error('Webapp not responding');
      console.log('✅ Webapp already running');
    } catch {
      console.log('🔄 Webapp needs restart');
      await shutdownServer('http://localhost:5173', 5173, 'Webapp');
      await waitForPortFree(5173);

      console.log('🚀 Starting webapp...');
      webappServer = spawn('npm', ['run', 'dev'], {
        cwd: 'apps/webapp',
        env: process.env,
        stdio: 'inherit',
      });

      await waitForServer('http://localhost:5173');
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
  // Only teardown if we started servers (short-expiry tests)
  // For normal/chromium tests, leave dev servers running

  if (apiServer || webappServer) {
    console.log('🧹 Cleaning up test servers...');

    if (apiServer) {
      console.log('🧹 Stopping API server...');
      apiServer.kill('SIGTERM');
      setTimeout(() => {
        if (apiServer && !apiServer.killed) {
          apiServer.kill('SIGKILL');
        }
      }, 2000);
    }

    if (webappServer) {
      console.log('🧹 Stopping webapp server...');
      webappServer.kill('SIGTERM');
      setTimeout(() => {
        if (webappServer && !webappServer.killed) {
          webappServer.kill('SIGKILL');
        }
      }, 2000);
    }

    // Wait for graceful shutdown
    await new Promise(resolve => setTimeout(resolve, 3000));
    console.log('✅ Test servers stopped');
  }
}

export default globalSetup;
export { globalTeardown };
