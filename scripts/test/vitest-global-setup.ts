/**
 * Vitest Global Setup - Production Environment Guard
 *
 * This file runs BEFORE any tests start. It prevents tests from running
 * in production environments to avoid data corruption or service disruption.
 *
 * Configure in vitest.config.ts:
 *   globalSetup: ['../../scripts/test/vitest-global-setup.ts']
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/**
 * Check if this is a production environment by reading system.conf files.
 *
 * Checks two locations:
 * 1. ~/walrus/system.conf - ENVIRONMENT variable (development/staging/production)
 * 2. /etc/walrus/system.conf - DEPLOYMENT_TYPE variable (production/test)
 */
function isProductionEnvironment(): { isProd: boolean; reason: string } {
  const home = homedir();
  const walrusConfig = join(home, 'walrus', 'system.conf');
  const etcConfig = '/etc/walrus/system.conf';

  // Check ~/walrus/system.conf (primary)
  if (existsSync(walrusConfig)) {
    try {
      const content = readFileSync(walrusConfig, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#') || !trimmed) continue;
        if (trimmed.startsWith('ENVIRONMENT=')) {
          const value = trimmed.split('=')[1]?.replace(/["']/g, '').toLowerCase();
          if (value === 'production') {
            return { isProd: true, reason: `ENVIRONMENT=production in ${walrusConfig}` };
          }
        }
      }
    } catch (err) {
      // Log but don't fail - default to allowing tests if we can't read config
      console.warn(`Warning: Could not read ${walrusConfig}:`, err);
    }
  }

  // Check /etc/walrus/system.conf (secondary - production servers)
  if (existsSync(etcConfig)) {
    try {
      const content = readFileSync(etcConfig, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#') || !trimmed) continue;
        if (trimmed.startsWith('DEPLOYMENT_TYPE=')) {
          const value = trimmed.split('=')[1]?.replace(/["']/g, '').toLowerCase();
          if (value === 'production') {
            return { isProd: true, reason: `DEPLOYMENT_TYPE=production in ${etcConfig}` };
          }
        }
      }
    } catch (err) {
      // Log but don't fail - default to allowing tests if we can't read config
      console.warn(`Warning: Could not read ${etcConfig}:`, err);
    }
  }

  return { isProd: false, reason: '' };
}

export default function setup(): void {
  const { isProd, reason } = isProductionEnvironment();

  if (isProd) {
    console.log('\n' + '='.repeat(70));
    console.log('\x1b[31m\x1b[1mFATAL: CANNOT RUN TESTS IN PRODUCTION ENVIRONMENT!\x1b[0m');
    console.log('='.repeat(70));
    console.log(`\nDetected: ${reason}`);
    console.log('\nTests are ONLY allowed in development environments.');
    console.log('This prevents accidental data corruption or service disruption.');
    console.log('\nTo run tests, ensure your system.conf has:');
    console.log('  ENVIRONMENT=development  (in ~/walrus/system.conf)');
    console.log('='.repeat(70) + '\n');
    process.exit(1);
  }

  console.log('\x1b[32m✅ Environment check passed: Not a production environment\x1b[0m');
}