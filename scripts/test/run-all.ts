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

import { spawn, execSync } from 'child_process';
import { writeFileSync, appendFileSync } from 'fs';
import { waitForPortFree } from '../../playwright-test-utils';

interface TestResult {
  name: string;
  command: string;
  passed: boolean;
  duration: number;
  output?: string;
}

// Create unique summary file
const SUMMARY_FILE = `/tmp/suiftly-test-summary-${process.pid}-${Date.now()}.txt`;

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

  // Log progress to summary file
  appendFileSync(SUMMARY_FILE, `[STARTED] ${name} at ${new Date().toISOString()}\n`);

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
        appendFileSync(SUMMARY_FILE, `[PASSED] ${name} - ${(duration / 1000).toFixed(2)}s\n`);
      } else {
        error(`${name} failed with exit code ${code} (${(duration / 1000).toFixed(2)}s)`);
        appendFileSync(SUMMARY_FILE, `[FAILED] ${name} - exit code ${code} - ${(duration / 1000).toFixed(2)}s\n`);
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
      appendFileSync(SUMMARY_FILE, `[ERROR] ${name} - ${err.message}\n`);

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

// Track whether we started the servers (so we know to stop them)
let startedServers = false;

async function startDevServers(): Promise<void> {
  section('Starting dev servers...');

  // Use start-dev.sh which handles process backgrounding, detaching, and logging
  // This is simpler and more robust than managing processes directly in Node
  try {
    execSync('./scripts/dev/start-dev.sh', { stdio: 'inherit' });
    startedServers = true;
    success('Dev servers started');
  } catch (error: any) {
    throw new Error(`Failed to start dev servers: ${error.message}`);
  }
}

async function stopDevServers(): Promise<void> {
  // Always stop servers when requested, regardless of who started them
  // This ensures we can restart servers for different test configurations
  section('Stopping dev servers...');

  // Use the robust stop-dev.sh script which handles all cleanup logic
  // This centralizes port cleanup for both manual and automated use
  try {
    execSync('./scripts/dev/stop-dev.sh', { stdio: 'inherit' });
  } catch (error: any) {
    // Script might exit non-zero if processes were already stopped
    warning(`stop-dev.sh exited with error (may be OK): ${error.message}`);
  }

  // Verify ports are free with short timeout (stop-dev.sh already checks)
  // If this times out, it means stop-dev.sh failed to clean up properly
  try {
    await waitForPortFree(3000, 5000); // 5 second timeout
    await waitForPortFree(5173, 5000);
  } catch (error: any) {
    error('Failed to verify ports are free after stop-dev.sh');
    error('This indicates stop-dev.sh failed to clean up properly');
    error('Please check /tmp/suiftly-api.log and /tmp/suiftly-webapp.log');
    error('Manual cleanup may be required: lsof -ti:3000 | xargs kill -9');
    throw new Error(`Port cleanup verification failed: ${error.message}`);
  }

  // Reset state
  startedServers = false;

  success('Dev servers stopped');
}

function printSummary(results: TestResult[]): void {
  header('TEST SUMMARY');

  const passed = results.filter(r => r.passed);
  const failed = results.filter(r => !r.passed);
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

  // Write summary header to file
  appendFileSync(SUMMARY_FILE, '\n========================================\n');
  appendFileSync(SUMMARY_FILE, 'FINAL TEST SUMMARY\n');
  appendFileSync(SUMMARY_FILE, '========================================\n\n');

  console.log();
  results.forEach(result => {
    const icon = result.passed ? '✅' : '❌';
    const statusColor = result.passed ? 'green' : 'red';
    const duration = (result.duration / 1000).toFixed(2);

    const line = `${icon} ${result.name} - ${duration}s`;
    console.log(
      `${icon} ${colorize(result.name, statusColor)} - ${duration}s`
    );
    appendFileSync(SUMMARY_FILE, `${line}\n`);
  });

  console.log();
  console.log(colorize('─'.repeat(80), 'cyan'));

  const summaryLine = `Total: ${results.length} test suites | ${passed.length} passed | ${failed.length} failed | ${(totalDuration / 1000).toFixed(2)}s`;
  console.log(
    `${colorize('Total:', 'bright')} ${results.length} test suites | ` +
    `${colorize(`${passed.length} passed`, 'green')} | ` +
    `${failed.length > 0 ? colorize(`${failed.length} failed`, 'red') : colorize('0 failed', 'green')} | ` +
    `${(totalDuration / 1000).toFixed(2)}s`
  );

  appendFileSync(SUMMARY_FILE, '\n' + summaryLine + '\n');

  if (failed.length > 0) {
    console.log();
    console.log(colorize('Failed test suites:', 'red'));
    appendFileSync(SUMMARY_FILE, '\nFailed test suites:\n');
    failed.forEach(result => {
      console.log(`  • ${result.name}`);
      console.log(`    ${colorize(result.command, 'yellow')}`);
      appendFileSync(SUMMARY_FILE, `  • ${result.name}\n`);
      appendFileSync(SUMMARY_FILE, `    ${result.command}\n`);
    });
  }

  console.log();
  appendFileSync(SUMMARY_FILE, '\n========================================\n');
  appendFileSync(SUMMARY_FILE, failed.length === 0 ? 'ALL TESTS PASSED ✅\n' : 'SOME TESTS FAILED ❌\n');
  appendFileSync(SUMMARY_FILE, '========================================\n');
}

async function main() {
  header('SUIFTLY TEST RUNNER - Running All Tests');

  // Initialize summary file
  writeFileSync(SUMMARY_FILE, `Test Summary File: ${SUMMARY_FILE}\n`);
  writeFileSync(SUMMARY_FILE, `Started at: ${new Date().toISOString()}\n\n`, { flag: 'a' });

  console.log(colorize(`📝 Test summary file: ${SUMMARY_FILE}`, 'cyan'));
  console.log();

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
  let result = await runCommand(
    'API Unit Tests',
    'npm',
    ['run', 'test', '--workspace=@suiftly/api', '--', '--run'],
    undefined,
    {
      MOCK_AUTH: 'true',
      DATABASE_URL: 'postgresql://deploy:deploy_password_change_me@localhost/suiftly_dev',
    }
  );
  results.push(result);

  // Stop on first failure
  if (!result.passed) {
    await stopDevServers();
    printSummary(results);
    error('Tests stopped on first failure');
    process.exit(1);
  }

  // 2. Playwright E2E - Normal Expiry (15m/30d)
  // Uses dev servers (already running or just started)
  result = await runCommand(
    'E2E Tests - Normal Expiry (15m/30d)',
    'npx',
    ['playwright', 'test', '--project=normal-expiry']
  );
  results.push(result);

  // Stop on first failure
  if (!result.passed) {
    await stopDevServers();
    printSummary(results);
    error('Tests stopped on first failure');
    process.exit(1);
  }

  // 3. Playwright E2E - Short Expiry (2s/10s)
  // These tests need clean server state to avoid JWT pollution from previous tests
  section('Preparing for short-expiry tests (clean server state)...');

  // Clear any JWT-related test data that might cause pollution (while server is still running)
  section('Cleaning database for short-expiry tests...');
  try {
    const cleanupResponse = await fetch('http://localhost:3000/test/data/truncate-all', {
      method: 'POST',
      signal: AbortSignal.timeout(5000)
    });
    if (cleanupResponse.ok) {
      success('Database cleaned');
    } else {
      warning('Database cleanup returned non-OK status');
    }
  } catch {
    warning('Database cleanup failed or timed out');
  }

  // Stop servers to ensure clean process state
  await stopDevServers();

  // Restart servers for short-expiry tests
  await startDevServers();

  // Run short-expiry tests (global setup will configure JWT via /test/jwt-config)
  result = await runCommand(
    'E2E Tests - Short Expiry (2s/10s)',
    'npx',
    ['playwright', 'test', '--project=short-expiry']
  );
  results.push(result);

  // Stop on first failure
  if (!result.passed) {
    await stopDevServers();
    printSummary(results);
    error('Tests stopped on first failure');
    process.exit(1);
  }

  // 4. Other Playwright tests (chromium project)
  // Servers are still running from short-expiry tests

  result = await runCommand(
    'E2E Tests - Other',
    'npx',
    ['playwright', 'test', '--project=chromium']
  );
  results.push(result);

  // Stop on first failure
  if (!result.passed) {
    await stopDevServers();
    printSummary(results);
    error('Tests stopped on first failure');
    process.exit(1);
  }

  // Cleanup: Always stop servers at the end of test run
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
