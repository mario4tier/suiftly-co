/**
 * Database-specific vitest global setup/teardown
 *
 * Database unit tests suspend GM processing (via resetTestState) to prevent
 * interference during direct DB operations. This teardown resumes GM so that
 * API integration tests running after database tests can use GM normally.
 */

const GM_PORT = 22600;

export default async function setup(): Promise<() => Promise<void>> {
  // Return teardown function
  return async () => {
    try {
      const res = await fetch(`http://localhost:${GM_PORT}/api/test/processing/resume`, { method: 'POST' });
      if (res.ok) {
        console.log('[DB teardown] GM processing resumed');
      }
    } catch {
      // GM not running — nothing to resume
    }
  };
}
