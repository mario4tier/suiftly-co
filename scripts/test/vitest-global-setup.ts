/**
 * Vitest Global Setup - Production Guard + Dev Server Auto-Start
 *
 * This file runs BEFORE any tests start. It:
 * 1. Prevents tests from running in production environments
 * 2. Checks if dev servers (API, GM) are running and starts them if not
 *
 * Configure in vitest.config.ts:
 *   globalSetup: ['../../scripts/test/vitest-global-setup.ts']
 */

import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';

/**
 * Find system.conf path
 */
function findSystemConf(): string | null {
  const home = homedir();
  const paths = [
    join(home, 'mhaxbe', 'system.conf'),
    '/etc/mhaxbe/system.conf',
  ];
  return paths.find(p => existsSync(p)) || null;
}

/**
 * Check if a service is reachable via its health endpoint
 */
async function isHealthy(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Wait for a service to become healthy, with retries
 */
async function waitForHealthy(url: string, label: string, maxSeconds: number): Promise<boolean> {
  for (let i = 0; i < maxSeconds; i++) {
    if (await isHealthy(url)) return true;
    if (i % 5 === 4) console.log(`  Still waiting for ${label}... (${i + 1}/${maxSeconds}s)`);
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

export default async function setup(): Promise<void> {
  // ---- Production guard ----
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

  console.log('\x1b[32m✅ Environment check passed: Not a production environment\x1b[0m');

  // ---- Dev server auto-start ----
  const gmHealthy = await isHealthy('http://localhost:22600/health');
  const apiHealthy = await isHealthy('http://localhost:22700/health');

  if (gmHealthy && apiHealthy) {
    console.log('\x1b[32m✅ Dev servers already running (GM :22600, API :22700)\x1b[0m');
    return;
  }

  const missing = [
    !gmHealthy && 'GM :22600',
    !apiHealthy && 'API :22700',
  ].filter(Boolean).join(', ');
  console.log(`\x1b[33m⚠ Dev servers not running (${missing}) — launching start-dev.sh...\x1b[0m`);

  // Find the repo root (this file lives at scripts/test/)
  const repoRoot = join(__dirname, '..', '..');
  const startScript = join(repoRoot, 'scripts', 'dev', 'start-dev.sh');

  if (!existsSync(startScript)) {
    console.error(`\x1b[31mERROR: start-dev.sh not found at ${startScript}\x1b[0m`);
    process.exit(1);
  }

  try {
    execSync(startScript, {
      cwd: repoRoot,
      stdio: 'inherit',
      timeout: 120_000, // 2 minutes max
    });
  } catch (err) {
    console.error('\x1b[31mERROR: start-dev.sh failed\x1b[0m');
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // Verify servers are now healthy
  const gmOk = await waitForHealthy('http://localhost:22600/health', 'GM', 15);
  const apiOk = await waitForHealthy('http://localhost:22700/health', 'API', 15);

  if (!gmOk || !apiOk) {
    const still = [!gmOk && 'GM :22600', !apiOk && 'API :22700'].filter(Boolean).join(', ');
    console.error(`\x1b[31mERROR: Servers still not responding after start-dev.sh (${still})\x1b[0m`);
    process.exit(1);
  }

  console.log('\x1b[32m✅ Dev servers started successfully\x1b[0m');
}
