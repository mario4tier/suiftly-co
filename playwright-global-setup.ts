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
  ExpectedConfig,
} from './playwright-test-utils';

let apiServer: ChildProcess | null = null;
let webappServer: ChildProcess | null = null;

async function globalSetup(config: FullConfig) {
  // Detect which project is running
  const isShortExpiryRun = process.argv.includes('--project=short-expiry') ||
                           process.argv.includes('short-expiry');
  const isNormalExpiryRun = process.argv.includes('--project=normal-expiry') ||
                           process.argv.includes('normal-expiry');
  const isChromiumRun = process.argv.includes('--project=chromium') ||
                       process.argv.includes('chromium');

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

      console.log('🚀 Starting webapp...');
      webappServer = spawn('npm', ['run', 'dev'], {
        cwd: 'apps/webapp',
        env: process.env,
        stdio: 'inherit',
      });

      await waitForServer('http://localhost:5173');
    }

    console.log('✅ Test servers ready with short JWT expiry');

  } else if (isNormalExpiryRun || isChromiumRun) {
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

      console.log('🚀 Starting webapp...');
      webappServer = spawn('npm', ['run', 'dev'], {
        cwd: 'apps/webapp',
        env: process.env,
        stdio: 'inherit',
      });

      await waitForServer('http://localhost:5173');
    }

    console.log('✅ Dev servers ready with normal JWT expiry');

  } else {
    console.log('ℹ️  Skipping global setup (no specific project detected)');
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
