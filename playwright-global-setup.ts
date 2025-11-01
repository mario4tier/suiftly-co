import { chromium, FullConfig } from '@playwright/test';
import { spawn, ChildProcess } from 'child_process';

let apiServer: ChildProcess | null = null;
let webappServer: ChildProcess | null = null;

async function waitForServer(url: string, timeout = 30000): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        console.log(`✅ Server ready at ${url}`);
        return;
      }
    } catch (error) {
      // Server not ready yet
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Server at ${url} did not start within ${timeout}ms`);
}

async function globalSetup(config: FullConfig) {
  // Check if we're running the short-expiry project
  // This happens when: npx playwright test --project=short-expiry
  const isShortExpiryRun = process.argv.includes('--project=short-expiry') ||
                           process.argv.includes('short-expiry');

  if (isShortExpiryRun) {
    console.log('🧪 Starting test servers with short JWT expiry...');

    // Start API server
    apiServer = spawn('npx', ['tsx', 'apps/api/src/server.ts'], {
      env: {
        ...process.env,
        NODE_ENV: 'development', // Required for JWT config to allow short expiry
        ENABLE_SHORT_JWT_EXPIRY: 'true',
        JWT_SECRET: 'TEST_DEV_SECRET_1234567890abcdef',
        MOCK_AUTH: 'true',
        DATABASE_URL: 'postgresql://deploy:deploy_password_change_me@localhost/suiftly_dev',
      },
      stdio: 'inherit',
    });

    // Wait for API to be ready
    await waitForServer('http://localhost:3000/health');

    // Start webapp
    webappServer = spawn('npm', ['run', 'dev'], {
      cwd: 'apps/webapp',
      env: process.env,
      stdio: 'inherit',
    });

    // Wait for webapp to be ready
    await waitForServer('http://localhost:5173');

    console.log('✅ Test servers ready');
  } else {
    console.log('ℹ️  Skipping global setup (not running short-expiry project)');
  }
}

async function globalTeardown() {
  if (apiServer) {
    console.log('🧹 Stopping API server...');
    apiServer.kill();
  }
  if (webappServer) {
    console.log('🧹 Stopping webapp server...');
    webappServer.kill();
  }
}

export default globalSetup;
export { globalTeardown };
