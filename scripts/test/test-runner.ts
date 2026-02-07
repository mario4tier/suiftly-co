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
 * PRODUCTION GUARD: Tests MUST only run in development environments.
 * This is enforced at startup before any tests run.
 *
 * Usage:
 *   npm run test:all
 *   ./scripts/test/run-all.ts
 *   tsx scripts/test/run-all.ts
 */

import { spawn, execSync, spawnSync } from 'child_process';
import { writeFileSync, appendFileSync, existsSync, readFileSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { waitForPortFree } from '../../playwright-test-utils';
import { PORT } from '@suiftly/shared/constants';

/**
 * Find system.conf path (searches mhaxbe first, then walrus for migration compatibility)
 */
function findSystemConf(): string | null {
  const home = homedir();
  const paths = [
    join(home, 'mhaxbe', 'system.conf'),
    join(home, 'walrus', 'system.conf'),
    '/etc/mhaxbe/system.conf',
    '/etc/walrus/system.conf',
  ];
  return paths.find(p => existsSync(p)) || null;
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

const LOCK_FILE = '/tmp/suiftly-test-runner.lock';

/**
 * Check if a process with the given PID is still running.
 */
function isProcessRunning(pid: number): boolean {
  try {
    // kill with signal 0 just checks if process exists
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check that no other test run is already in progress.
 * Uses a PID-based lock file that auto-cleans stale locks.
 *
 * This prevents:
 * - Database deadlocks from concurrent test data resets
 * - Port conflicts from multiple server instances
 * - Flaky test failures from shared state corruption
 */
async function checkNoOtherTestsRunning(): Promise<void> {
  const currentPid = process.pid;

  // Check if lock file exists
  if (existsSync(LOCK_FILE)) {
    try {
      const lockContent = readFileSync(LOCK_FILE, 'utf8').trim();
      const lockedPid = parseInt(lockContent);

      if (!isNaN(lockedPid) && lockedPid !== currentPid && isProcessRunning(lockedPid)) {
        // Another test run is in progress
        console.log();
        console.log('\x1b[31m' + '═'.repeat(70) + '\x1b[0m');
        console.log('\x1b[31m\x1b[1m  ERROR: Another test run is already in progress!\x1b[0m');
        console.log('\x1b[31m' + '═'.repeat(70) + '\x1b[0m');
        console.log();
        console.log(`  Found test runner process with PID: \x1b[33m${lockedPid}\x1b[0m`);
        console.log();
        console.log('  Running multiple test suites concurrently causes:');
        console.log('    • Database deadlocks');
        console.log('    • Port conflicts');
        console.log('    • Flaky test failures');
        console.log();
        console.log('  \x1b[36mOptions:\x1b[0m');
        console.log('    1. Wait for the other test run to complete');
        console.log(`    2. Kill the other test run: \x1b[33mkill ${lockedPid}\x1b[0m`);
        console.log();
        process.exit(1);
      } else {
        // Lock file is stale (process not running) - remove it
        try {
          unlinkSync(LOCK_FILE);
          console.log('\x1b[33m⚠️  Removed stale lock file from crashed test run\x1b[0m');
        } catch {
          // Ignore - might have been removed by another process
        }
      }
    } catch (err) {
      // Error reading lock file - try to remove it
      try {
        unlinkSync(LOCK_FILE);
      } catch {
        // Ignore
      }
    }
  }

  // Create lock file with our PID
  writeFileSync(LOCK_FILE, String(currentPid));

  // Register cleanup handler to remove lock file on exit
  const cleanup = () => {
    try {
      // Only remove if it's still our lock
      if (existsSync(LOCK_FILE)) {
        const content = readFileSync(LOCK_FILE, 'utf8').trim();
        if (content === String(currentPid)) {
          unlinkSync(LOCK_FILE);
        }
      }
    } catch {
      // Ignore errors during cleanup
    }
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });

  // Brief sleep then re-check to handle race condition where two start simultaneously
  await new Promise(resolve => setTimeout(resolve, 100));

  // Re-read lock file to verify we still own it (handles race conditions)
  try {
    const lockContent = readFileSync(LOCK_FILE, 'utf8').trim();
    const lockedPid = parseInt(lockContent);

    if (lockedPid !== currentPid) {
      // Another process won the race
      console.log();
      console.log('\x1b[31m' + '═'.repeat(70) + '\x1b[0m');
      console.log('\x1b[31m\x1b[1m  ERROR: Another test run started simultaneously!\x1b[0m');
      console.log('\x1b[31m' + '═'.repeat(70) + '\x1b[0m');
      console.log();
      console.log(`  The other test runner (PID ${lockedPid}) acquired the lock first.`);
      console.log('  Please wait for it to complete or kill it.');
      console.log();
      process.exit(1);
    }
  } catch {
    // Lock file disappeared - something strange happened, but continue
  }

  // Check for orphaned test processes from crashed runs
  try {
    const orphanedPlaywright = execSync(`pgrep -f "playwright test" 2>/dev/null || true`, { encoding: 'utf8' }).trim();
    const orphanedVitest = execSync(`pgrep -f "vitest.*--run" 2>/dev/null || true`, { encoding: 'utf8' }).trim();

    const playwrightPids = orphanedPlaywright.split('\n').filter(p => p);
    const vitestPids = orphanedVitest.split('\n').filter(p => p);

    if (playwrightPids.length > 0 || vitestPids.length > 0) {
      console.log('\x1b[33m⚠️  Found orphaned test processes from a previous run:\x1b[0m');
      if (playwrightPids.length > 0) {
        console.log(`    playwright PID(s): ${playwrightPids.join(', ')}`);
      }
      if (vitestPids.length > 0) {
        console.log(`    vitest PID(s): ${vitestPids.join(', ')}`);
      }
      console.log('\x1b[33m   Cleaning up orphaned processes...\x1b[0m');

      // Kill orphaned processes
      if (playwrightPids.length > 0) {
        execSync('pkill -9 -f "playwright test" 2>/dev/null || true', { stdio: 'ignore' });
      }
      if (vitestPids.length > 0) {
        execSync('pkill -9 -f "vitest.*--run" 2>/dev/null || true', { stdio: 'ignore' });
      }
      // Wait for processes to die
      await new Promise(resolve => setTimeout(resolve, 500));
      console.log('\x1b[32m   ✅ Orphaned processes cleaned up\x1b[0m');
    }
  } catch {
    // Ignore errors checking for orphaned processes
  }
}

/**
 * Run a shell script synchronously.
 */
function runScriptIsolated(scriptPath: string): void {
  // Run script directly with execSync
  // The scripts handle their own process management
  execSync(scriptPath, {
    stdio: 'inherit',
    env: process.env,
  });
}

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
  // IMPORTANT: Run in isolated process group to prevent signals from killing test runner
  try {
    console.log('[DEBUG] Before runScriptIsolated(start-dev.sh)');
    runScriptIsolated('./scripts/dev/start-dev.sh');
    console.log('[DEBUG] After runScriptIsolated(start-dev.sh)');
    startedServers = true;
    success('Dev servers started');
    console.log('[DEBUG] startDevServers complete, returning to caller');
  } catch (err: any) {
    throw new Error(`Failed to start dev servers: ${err.message}`);
  }
}

async function stopDevServers(): Promise<void> {
  // Always stop servers when requested, regardless of who started them
  // This ensures we can restart servers for different test configurations
  section('Stopping dev servers...');

  // Use the robust stop-dev.sh script which handles all cleanup logic
  // IMPORTANT: Run in isolated process group to prevent signals from killing test runner
  try {
    runScriptIsolated('./scripts/dev/stop-dev.sh');
  } catch (err: any) {
    // Script might exit non-zero if processes were already stopped
    warning(`stop-dev.sh exited with error (may be OK): ${err.message}`);
  }

  // Verify ports are free with short timeout (stop-dev.sh already checks)
  // If this times out, it means stop-dev.sh failed to clean up properly
  try {
    await waitForPortFree(3000, 5000); // 5 second timeout
    await waitForPortFree(5173, 5000);
  } catch (err: any) {
    error('Failed to verify ports are free after stop-dev.sh');
    error('This indicates stop-dev.sh failed to clean up properly');
    error('Please check /tmp/suiftly-api.log and /tmp/suiftly-webapp.log');
    error('Manual cleanup may be required: lsof -ti:3000 | xargs kill -9');
    throw new Error(`Port cleanup verification failed: ${err.message}`);
  }

  // Reset state
  startedServers = false;

  success('Dev servers stopped');
}

/**
 * Stop only API and Webapp servers (not GM/LM) - for mid-test restarts
 * This avoids the GM/LM management that may be causing the test runner to die
 */
async function stopApiWebappOnly(): Promise<void> {
  section('Stopping API and Webapp only (keeping GM/LM/Admin)...');

  // Kill API by PID
  try {
    execSync('if [ -f /tmp/suiftly-api.pid ]; then kill -9 $(cat /tmp/suiftly-api.pid) 2>/dev/null; rm /tmp/suiftly-api.pid; fi', { stdio: 'inherit' });
  } catch {
    // Ignore errors - process may already be dead
  }

  // Kill Webapp by PID
  try {
    execSync('if [ -f /tmp/suiftly-webapp.pid ]; then kill -9 $(cat /tmp/suiftly-webapp.pid) 2>/dev/null; rm /tmp/suiftly-webapp.pid; fi', { stdio: 'inherit' });
  } catch {
    // Ignore errors - process may already be dead
  }

  // Note: Don't touch Admin webapp (22601) - it doesn't need restart for E2E tests

  // Fallback: kill by port (ONLY processes LISTENING on the port, not connected clients)
  // IMPORTANT: Must use -sTCP:LISTEN to avoid killing the test runner which has connections to these ports
  try {
    execSync('lsof -ti:22700 -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true', { stdio: 'inherit' });
    execSync('lsof -ti:22710 -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true', { stdio: 'inherit' });
  } catch {
    // Ignore errors
  }

  // Wait for ports to be free
  await new Promise(resolve => setTimeout(resolve, 1000));

  success('API and Webapp stopped (GM/LM/Admin still running)');
}

/**
 * Start only API and Webapp servers (assumes GM/LM already running)
 */
async function startApiWebappOnly(): Promise<void> {
  section('Starting API and Webapp only...');

  // Note: Skip Admin webapp for mid-test restart - not needed for E2E tests
  // and was causing issues with process management

  console.log('[DEBUG] About to start API server...');
  // Start API server using spawn with detached to avoid process group issues
  const apiProc = spawn('npx', ['tsx', 'apps/api/src/server.ts'], {
    cwd: '/home/olet/suiftly-co',
    env: {
      ...process.env,
      MOCK_AUTH: 'true',
      DATABASE_URL: 'postgresql://deploy:deploy_password_change_me@localhost/suiftly_dev',
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  apiProc.unref();

  // Write PID and redirect output
  const fs = await import('fs');
  fs.writeFileSync('/tmp/suiftly-api.pid', String(apiProc.pid));
  const apiLogStream = fs.createWriteStream('/tmp/suiftly-api.log', { flags: 'a' });
  apiProc.stdout?.pipe(apiLogStream);
  apiProc.stderr?.pipe(apiLogStream);

  console.log(`[DEBUG] API server started (PID: ${apiProc.pid})`);

  // Wait for API to be ready
  for (let i = 0; i < 10; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      const response = await fetch('http://localhost:22700/health');
      if (response.ok) break;
    } catch {
      // Keep waiting
    }
    console.log(`  Waiting for API... (${i + 1}/10)`);
  }

  console.log('[DEBUG] About to start Webapp...');
  // Start Webapp using spawn with detached to avoid process group issues
  const webappProc = spawn('npm', ['run', 'dev'], {
    cwd: '/home/olet/suiftly-co/apps/webapp',
    env: process.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  webappProc.unref();

  // Write PID and redirect output
  fs.writeFileSync('/tmp/suiftly-webapp.pid', String(webappProc.pid));
  const webappLogStream = fs.createWriteStream('/tmp/suiftly-webapp.log', { flags: 'a' });
  webappProc.stdout?.pipe(webappLogStream);
  webappProc.stderr?.pipe(webappLogStream);

  console.log(`[DEBUG] Webapp started (PID: ${webappProc.pid})`);

  // Wait for Webapp to be ready
  await new Promise(resolve => setTimeout(resolve, 3000));

  success('API and Webapp started');
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

  // CRITICAL: Check that we're not in a production environment
  // This must run FIRST before any other operations
  checkNotProductionEnvironment();

  // Check that no other test run is in progress
  // This prevents database deadlocks, port conflicts, and flaky test failures
  await checkNoOtherTestsRunning();

  // Initialize summary file
  writeFileSync(SUMMARY_FILE, `Test Summary File: ${SUMMARY_FILE}\n`);
  writeFileSync(SUMMARY_FILE, `Started at: ${new Date().toISOString()}\n\n`, { flag: 'a' });

  console.log(colorize(`📝 Test summary file: ${SUMMARY_FILE}`, 'cyan'));
  console.log();

  const results: TestResult[] = [];

  // Check if dev servers are running
  section('Checking servers...');
  const apiRunning = await checkServerRunning('http://localhost:22700/health');
  const webappRunning = await checkServerRunning('http://localhost:22710');

  if (apiRunning && webappRunning) {
    success('Dev servers already running');
  } else {
    warning('Dev servers not running - will start them automatically');
    try {
      await startDevServers();
    } catch (err: any) {
      error(`Failed to start dev servers: ${err.message}`);
      process.exit(1);
    }
  }

  // 1. Database Unit Tests (Vitest) - billing/stats pure unit tests
  let result = await runCommand(
    'Database Unit Tests',
    'npm',
    ['run', 'test', '--workspace=@suiftly/database', '--', '--run'],
    undefined,
    {
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

  // 2. API Unit Tests (Vitest)
  result = await runCommand(
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

  // 3. Playwright E2E - Normal Expiry (15m/30d)
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

  // 4. Playwright E2E - Short Expiry (2s/10s)
  // These tests need clean server state to avoid JWT pollution from previous tests
  section('Preparing for short-expiry tests (clean server state)...');

  // Clear any JWT-related test data that might cause pollution (while server is still running)
  section('Full clean-slate via sudob reset-all...');
  try {
    const cleanupResponse = await fetch(`http://localhost:${PORT.SUDOB}/api/test/reset-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(60000)
    });
    if (cleanupResponse.ok) {
      success('Full reset-all complete');
    } else {
      warning('reset-all returned non-OK status');
    }
  } catch {
    warning('reset-all failed or timed out');
  }

  // Restart only API and Webapp (keep GM/LM running) to test if GM/LM is causing the issue
  // TODO: If this works, investigate why full stop/start kills the test runner
  console.log('[DEBUG] About to stopApiWebappOnly');
  await stopApiWebappOnly();
  console.log('[DEBUG] stopApiWebappOnly complete');

  console.log('[DEBUG] About to startApiWebappOnly');
  await startApiWebappOnly();
  console.log('[DEBUG] startApiWebappOnly complete - about to run short-expiry tests');

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

  // 5. Other Playwright tests (chromium project)
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
