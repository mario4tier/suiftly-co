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

export default function setup(): void {
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
}