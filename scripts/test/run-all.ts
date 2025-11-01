#!/usr/bin/env tsx
/**
 * Comprehensive Test Runner
 *
 * Runs ALL tests in the project:
 * - API unit tests (Vitest)
 * - Cookie security tests (Vitest)
 * - E2E tests (Playwright - normal expiry)
 * - E2E tests (Playwright - short expiry)
 *
 * Usage:
 *   npm run test:all
 *   ./scripts/test/run-all.ts
 *   tsx scripts/test/run-all.ts
 */

import { spawn, ChildProcess, execSync } from 'child_process';
import { basename } from 'path';

interface TestResult {
  name: string;
  command: string;
  passed: boolean;
  duration: number;
  output?: string;
}

const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function colorize(text: string, color: keyof typeof COLORS): string {
  return `${COLORS[color]}${text}${COLORS.reset}`;
}

function header(text: string): void {
  console.log('\n' + colorize('='.repeat(80), 'cyan'));
  console.log(colorize(text, 'bright'));
  console.log(colorize('='.repeat(80), 'cyan'));
}

function section(text: string): void {
  console.log('\n' + colorize(`▶ ${text}`, 'blue'));
}

function success(text: string): void {
  console.log(colorize(`✅ ${text}`, 'green'));
}

function error(text: string): void {
  console.log(colorize(`❌ ${text}`, 'red'));
}

function warning(text: string): void {
  console.log(colorize(`⚠️  ${text}`, 'yellow'));
}

async function runCommand(
  name: string,
  command: string,
  args: string[],
  cwd?: string,
  env?: Record<string, string>
): Promise<TestResult> {
  section(`Running: ${name}`);
  console.log(colorize(`Command: ${command} ${args.join(' ')}`, 'cyan'));

  const startTime = Date.now();

  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...env },
      stdio: 'inherit',
    });

    proc.on('close', (code) => {
      const duration = Date.now() - startTime;
      const passed = code === 0;

      if (passed) {
        success(`${name} passed (${(duration / 1000).toFixed(2)}s)`);
      } else {
        error(`${name} failed with exit code ${code} (${(duration / 1000).toFixed(2)}s)`);
      }

      resolve({
        name,
        command: `${command} ${args.join(' ')}`,
        passed,
        duration,
      });
    });

    proc.on('error', (err) => {
      const duration = Date.now() - startTime;
      error(`${name} error: ${err.message}`);

      resolve({
        name,
        command: `${command} ${args.join(' ')}`,
        passed: false,
        duration,
        output: err.message,
      });
    });
  });
}

async function checkServerRunning(url: string): Promise<boolean> {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServer(url: string, timeout = 30000): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch (error) {
      // Server not ready yet
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Server at ${url} did not start within ${timeout}ms`);
}

let apiServer: ChildProcess | null = null;
let webappServer: ChildProcess | null = null;
let startedServers = false;

async function startDevServers(): Promise<void> {
  section('Starting dev servers...');

  // Start API server
  // Note: These servers will be killed by short-expiry tests, which is expected
  apiServer = spawn('npx', ['tsx', 'apps/api/src/server.ts'], {
    env: {
      ...process.env,
      NODE_ENV: 'development',
      MOCK_AUTH: 'true',
      DATABASE_URL: 'postgresql://deploy:deploy_password_change_me@localhost/suiftly_dev',
    },
    stdio: 'inherit',
  });

  // Wait for API to be ready
  await waitForServer('http://localhost:3000/health');
  success('API server ready');

  // Start webapp
  webappServer = spawn('npm', ['run', 'dev'], {
    cwd: 'apps/webapp',
    env: process.env,
    stdio: 'inherit',
  });

  // Wait for webapp to be ready
  await waitForServer('http://localhost:5173');
  success('Webapp ready');

  startedServers = true;
}

async function stopDevServers(): Promise<void> {
  if (!startedServers) {
    return;
  }

  section('Stopping dev servers...');

  if (apiServer) {
    apiServer.kill('SIGTERM');
    setTimeout(() => {
      if (apiServer && !apiServer.killed) {
        apiServer.kill('SIGKILL');
      }
    }, 2000);
  }

  if (webappServer) {
    webappServer.kill('SIGTERM');
    setTimeout(() => {
      if (webappServer && !webappServer.killed) {
        webappServer.kill('SIGKILL');
      }
    }, 2000);
  }

  // Wait for graceful shutdown
  await new Promise(resolve => setTimeout(resolve, 3000));

  success('Dev servers stopped');
}

function printSummary(results: TestResult[]): void {
  header('TEST SUMMARY');

  const passed = results.filter(r => r.passed);
  const failed = results.filter(r => !r.passed);
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

  console.log();
  results.forEach(result => {
    const icon = result.passed ? '✅' : '❌';
    const statusColor = result.passed ? 'green' : 'red';
    const duration = (result.duration / 1000).toFixed(2);

    console.log(
      `${icon} ${colorize(result.name, statusColor)} - ${duration}s`
    );
  });

  console.log();
  console.log(colorize('─'.repeat(80), 'cyan'));
  console.log(
    `${colorize('Total:', 'bright')} ${results.length} test suites | ` +
    `${colorize(`${passed.length} passed`, 'green')} | ` +
    `${failed.length > 0 ? colorize(`${failed.length} failed`, 'red') : colorize('0 failed', 'green')} | ` +
    `${(totalDuration / 1000).toFixed(2)}s`
  );

  if (failed.length > 0) {
    console.log();
    console.log(colorize('Failed test suites:', 'red'));
    failed.forEach(result => {
      console.log(`  • ${result.name}`);
      console.log(`    ${colorize(result.command, 'yellow')}`);
    });
  }

  console.log();
}

async function main() {
  header('SUIFTLY TEST RUNNER - Running All Tests');

  const results: TestResult[] = [];

  // Check if dev servers are running
  section('Checking servers...');
  const apiRunning = await checkServerRunning('http://localhost:3000/health');
  const webappRunning = await checkServerRunning('http://localhost:5173');

  if (apiRunning && webappRunning) {
    success('Dev servers already running');
  } else {
    warning('Dev servers not running - will start them automatically');
    try {
      await startDevServers();
    } catch (error: any) {
      error(`Failed to start dev servers: ${error.message}`);
      process.exit(1);
    }
  }

  // 1. API Unit Tests (Vitest)
  results.push(await runCommand(
    'API Unit Tests',
    'npm',
    ['run', 'test', '--workspace=@suiftly/api', '--', '--run'],
    undefined,
    {
      MOCK_AUTH: 'true',
      DATABASE_URL: 'postgresql://deploy:deploy_password_change_me@localhost/suiftly_dev',
    }
  ));

  // 2. Playwright E2E - Normal Expiry (15m/30d)
  // Uses dev servers (already running or just started)
  results.push(await runCommand(
    'E2E Tests - Normal Expiry (15m/30d)',
    'npx',
    ['playwright', 'test', '--project=normal-expiry']
  ));

  // 3. Playwright E2E - Short Expiry (2s/10s)
  // Short-expiry tests need servers with special JWT config
  // We must stop our servers first to avoid kill conflicts
  section('Preparing for short-expiry tests (requires test servers)...');

  // Stop our dev servers cleanly before short-expiry tests start
  // This prevents the global setup's port cleanup from killing our processes
  await stopDevServers();

  // Global setup will kill any remaining processes on ports and start test servers
  // Includes robust retry logic for timing-sensitive tests
  results.push(await runCommand(
    'E2E Tests - Short Expiry (2s/10s)',
    'npx',
    ['playwright', 'test', '--project=short-expiry']
  ));

  // 4. Other Playwright tests (chromium project)
  // After short-expiry tests, dev servers are stopped, so we need to restart them
  section('Restarting dev servers for chromium tests...');
  await startDevServers();

  results.push(await runCommand(
    'E2E Tests - Other',
    'npx',
    ['playwright', 'test', '--project=chromium']
  ));

  // Cleanup: Stop servers if we started them
  await stopDevServers();

  // Print summary
  printSummary(results);

  // Exit with appropriate code
  const allPassed = results.every(r => r.passed);
  if (allPassed) {
    success('All tests passed! 🎉');
    process.exit(0);
  } else {
    error('Some tests failed');
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (err) => {
    error(`Fatal error: ${err.message}`);
    console.error(err);

    // Ensure cleanup happens even on fatal error
    await stopDevServers();

    process.exit(1);
  });
}
