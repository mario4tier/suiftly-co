/**
 * GM Sync Helper
 *
 * Triggers vault regeneration via the Global Manager.
 * Used when API mutations change data that affects vault content.
 */

// GM endpoint (internal network only)
const GM_HOST = process.env.GM_HOST || 'http://localhost:22600';

/**
 * Trigger vault regeneration via GM
 *
 * Calls the GM's sync-all endpoint to regenerate vaults.
 * Uses async mode by default (returns immediately without waiting).
 *
 * @param waitForCompletion - If true, waits for sync to complete (for tests)
 * @returns Result object with success status
 */
export async function triggerVaultSync(waitForCompletion = false): Promise<{
  success: boolean;
  queued?: boolean;
  completed?: boolean;
  taskId?: string;
  error?: string;
}> {
  try {
    const asyncParam = waitForCompletion ? '' : '?async=true';
    const response = await fetch(`${GM_HOST}/api/queue/sync-all${asyncParam}`, {
      method: 'POST',
    });

    if (!response.ok) {
      const text = await response.text();
      console.warn('[GM-SYNC] Failed to trigger vault sync:', response.status, text);
      return { success: false, error: `HTTP ${response.status}: ${text}` };
    }

    const result = await response.json() as {
      success: boolean;
      queued?: boolean;
      completed?: boolean;
      taskId?: string;
      reason?: string;
    };

    if (result.reason === 'deduplicated') {
      // Sync already in progress - this is fine
      return { success: true, queued: false };
    }

    return {
      success: result.success,
      queued: result.queued,
      completed: result.completed,
      taskId: result.taskId,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    console.warn('[GM-SYNC] Error triggering vault sync:', error);
    // Don't fail the API mutation if GM is unreachable
    // The periodic sync will eventually pick up the changes
    return { success: false, error };
  }
}
