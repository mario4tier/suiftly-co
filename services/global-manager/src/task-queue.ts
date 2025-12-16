/**
 * Task Queue for Global Manager
 *
 * In-memory queue with "at most 2" deduplication for background processing tasks.
 * Two task types:
 * - sync-customer: On-demand sync for a specific customer (from API or test)
 * - sync-all: Periodic or on-demand sync for all customers (billing, reconciliation, etc.)
 *
 * Deduplication strategy (per-customer for sync-customer, global for sync-all):
 * - If not processing: start processing immediately
 * - If processing and no pending: mark one pending
 * - If processing and already pending: deduplicate (ignore)
 *
 * This ensures at most 2 instances: 1 processing + 1 pending.
 * The pending one catches any state changes that occurred during processing.
 *
 * Synchronous mode (for testing):
 * - Use queueSyncCustomerSync() or queueSyncAllSync() to wait for completion
 * - Returns only after the task (and any pending follow-up) completes
 */

import { db, adminNotifications } from '@suiftly/database';
import { runPeriodicBillingJob } from '@suiftly/database/billing';
import { getSuiService } from '@suiftly/database/sui-mock';
import { getMockClockState, setMockClockState } from '@suiftly/database/test-kv';
import { dbClockProvider } from '@suiftly/shared/db-clock';
import { reconcilePayments } from './reconcile-payments.js';
import { generateAllVaults } from './tasks/generate-vault.js';
import { pollLMStatus } from './tasks/poll-lm-status.js';
import { isTestDeployment } from './config/lm-config.js';

// Configure test_kv sync if not in production
// This allows GM to read mock clock state from the database
if (isTestDeployment()) {
  dbClockProvider.configureTestKvSync(getMockClockState, setMockClockState);
  dbClockProvider.enableTestKvSync();
}

// ============================================================================
// Types
// ============================================================================

export type TaskType = 'sync-customer' | 'sync-all';

export interface QueuedTask {
  id: string;
  type: TaskType;
  customerId?: number; // Only for sync-customer
  createdAt: Date;
  source: 'api' | 'periodic' | 'test' | 'manual';
}

interface CustomerSyncState {
  processing: boolean;
  pendingAfterCurrent: boolean;
  lastSource: QueuedTask['source'];
  // Promise that resolves when current processing (and any pending) completes
  completionPromise: Promise<void> | null;
  resolveCompletion: (() => void) | null;
}

interface QueueStats {
  customersProcessing: number;
  customersPending: number;
  syncAllProcessing: boolean;
  syncAllPending: boolean;
  lastProcessedAt: Date | null;
  totalProcessed: number;
  totalFailed: number;
}

// ============================================================================
// Queue State
// ============================================================================

// Per-customer sync state
const customerSyncStates = new Map<number, CustomerSyncState>();

// Global sync-all state
let syncAllProcessing = false;
let syncAllPendingAfterCurrent = false;
let syncAllLastSource: QueuedTask['source'] = 'periodic';
let syncAllCompletionPromise: Promise<void> | null = null;
let syncAllResolveCompletion: (() => void) | null = null;

// Stats
let lastProcessedAt: Date | null = null;
let totalProcessed = 0;
let totalFailed = 0;

// ============================================================================
// Queue Operations
// ============================================================================

/**
 * Generate a unique task ID
 */
function generateTaskId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Get or create customer sync state
 */
function getCustomerState(customerId: number): CustomerSyncState {
  let state = customerSyncStates.get(customerId);
  if (!state) {
    state = {
      processing: false,
      pendingAfterCurrent: false,
      lastSource: 'api',
      completionPromise: null,
      resolveCompletion: null,
    };
    customerSyncStates.set(customerId, state);
  }
  return state;
}

/**
 * Queue a sync-customer task with "at most 2" deduplication
 * Returns the task if queued/will run, null if deduplicated
 */
export function queueSyncCustomer(
  customerId: number,
  source: QueuedTask['source'] = 'api'
): QueuedTask | null {
  const state = getCustomerState(customerId);

  if (!state.processing) {
    // Not processing - start immediately
    state.processing = true;
    state.lastSource = source;

    // Create completion promise for sync callers
    state.completionPromise = new Promise<void>((resolve) => {
      state.resolveCompletion = resolve;
    });

    const task: QueuedTask = {
      id: generateTaskId(),
      type: 'sync-customer',
      customerId,
      createdAt: new Date(),
      source,
    };

    console.log(`[QUEUE] Processing sync-customer for customer ${customerId} (source: ${source})`);

    // Process async (don't await)
    void processCustomerSync(customerId, state, task.id);

    return task;
  } else if (!state.pendingAfterCurrent) {
    // Processing but no pending - queue one more
    state.pendingAfterCurrent = true;
    state.lastSource = source;

    const task: QueuedTask = {
      id: generateTaskId(),
      type: 'sync-customer',
      customerId,
      createdAt: new Date(),
      source,
    };

    console.log(`[QUEUE] Queued pending sync-customer for customer ${customerId} (source: ${source})`);
    return task;
  } else {
    // Already processing with one pending - deduplicate
    console.log(`[QUEUE] Deduplicated sync-customer for customer ${customerId}`);
    return null;
  }
}

/**
 * Queue a sync-customer task and wait for completion (synchronous mode for testing)
 * Returns after the task (and any pending follow-up) completes
 */
export async function queueSyncCustomerSync(
  customerId: number,
  source: QueuedTask['source'] = 'test'
): Promise<QueuedTask | null> {
  const task = queueSyncCustomer(customerId, source);
  const state = customerSyncStates.get(customerId);

  if (state?.completionPromise) {
    await state.completionPromise;
  }

  return task;
}

/**
 * Queue a sync-all task with "at most 2" deduplication
 * Returns the task if queued/will run, null if deduplicated
 */
export function queueSyncAll(source: QueuedTask['source'] = 'periodic'): QueuedTask | null {
  if (!syncAllProcessing) {
    // Not processing - start immediately
    syncAllProcessing = true;
    syncAllLastSource = source;

    // Create completion promise for sync callers
    syncAllCompletionPromise = new Promise<void>((resolve) => {
      syncAllResolveCompletion = resolve;
    });

    const task: QueuedTask = {
      id: generateTaskId(),
      type: 'sync-all',
      createdAt: new Date(),
      source,
    };

    console.log(`[QUEUE] Processing sync-all (source: ${source})`);

    // Process async (don't await)
    void processSyncAllTask(task.id);

    return task;
  } else if (!syncAllPendingAfterCurrent) {
    // Processing but no pending - queue one more
    syncAllPendingAfterCurrent = true;
    syncAllLastSource = source;

    const task: QueuedTask = {
      id: generateTaskId(),
      type: 'sync-all',
      createdAt: new Date(),
      source,
    };

    console.log(`[QUEUE] Queued pending sync-all (source: ${source})`);
    return task;
  } else {
    // Already processing with one pending - deduplicate
    console.log(`[QUEUE] Deduplicated sync-all (already pending)`);
    return null;
  }
}

/**
 * Queue a sync-all task and wait for completion (synchronous mode for testing)
 * Returns after the task (and any pending follow-up) completes
 */
export async function queueSyncAllSync(
  source: QueuedTask['source'] = 'test'
): Promise<QueuedTask | null> {
  const task = queueSyncAll(source);

  if (syncAllCompletionPromise) {
    await syncAllCompletionPromise;
  }

  return task;
}

/**
 * Get current queue statistics
 */
export function getQueueStats(): QueueStats {
  let customersProcessing = 0;
  let customersPending = 0;

  for (const state of customerSyncStates.values()) {
    if (state.processing) customersProcessing++;
    if (state.pendingAfterCurrent) customersPending++;
  }

  return {
    customersProcessing,
    customersPending,
    syncAllProcessing,
    syncAllPending: syncAllPendingAfterCurrent,
    lastProcessedAt,
    totalProcessed,
    totalFailed,
  };
}

/**
 * Get pending tasks (for debugging/monitoring)
 */
export function getPendingTasks(): { customerId: number; source: string }[] {
  const pending: { customerId: number; source: string }[] = [];

  for (const [customerId, state] of customerSyncStates.entries()) {
    if (state.pendingAfterCurrent) {
      pending.push({ customerId, source: state.lastSource });
    }
  }

  return pending;
}

// ============================================================================
// Task Processing
// ============================================================================

/**
 * Process a customer sync task
 */
async function processCustomerSync(
  customerId: number,
  state: CustomerSyncState,
  taskId: string
): Promise<void> {
  const startTime = Date.now();

  try {
    await executeSyncCustomer(customerId);
    totalProcessed++;
    lastProcessedAt = new Date();

    const duration = Date.now() - startTime;
    console.log(`[QUEUE] Completed sync-customer ${taskId} for customer ${customerId} in ${duration}ms`);
  } catch (error) {
    totalFailed++;
    console.error(`[QUEUE] Task ${taskId} failed for customer ${customerId}:`, error);

    // Create admin notification for failed task
    await createFailureNotification('sync-customer', customerId, error);
  } finally {
    // Check if there's a pending request
    if (state.pendingAfterCurrent) {
      state.pendingAfterCurrent = false;
      const newTaskId = generateTaskId();
      console.log(`[QUEUE] Running pending sync-customer ${newTaskId} for customer ${customerId}`);
      // Recursively process the pending one (await to chain completion)
      await processCustomerSync(customerId, state, newTaskId);
    } else {
      // No more pending - mark as not processing and resolve completion
      state.processing = false;
      if (state.resolveCompletion) {
        state.resolveCompletion();
        state.resolveCompletion = null;
        state.completionPromise = null;
      }
      // Clean up state if idle
      customerSyncStates.delete(customerId);
    }
  }
}

/**
 * Process a sync-all task
 */
async function processSyncAllTask(taskId: string): Promise<void> {
  const startTime = Date.now();

  try {
    await executeSyncAll();
    totalProcessed++;
    lastProcessedAt = new Date();

    const duration = Date.now() - startTime;
    console.log(`[QUEUE] Completed sync-all ${taskId} in ${duration}ms`);
  } catch (error) {
    totalFailed++;
    console.error(`[QUEUE] Task ${taskId} (sync-all) failed:`, error);

    // Create admin notification for failed task
    await createFailureNotification('sync-all', undefined, error);
  } finally {
    // Check if there's a pending request
    if (syncAllPendingAfterCurrent) {
      syncAllPendingAfterCurrent = false;
      const newTaskId = generateTaskId();
      console.log(`[QUEUE] Running pending sync-all ${newTaskId}`);
      // Recursively process the pending one (await to chain completion)
      await processSyncAllTask(newTaskId);
    } else {
      // No more pending - mark as not processing and resolve completion
      syncAllProcessing = false;
      if (syncAllResolveCompletion) {
        syncAllResolveCompletion();
        syncAllResolveCompletion = null;
        syncAllCompletionPromise = null;
      }
    }
  }
}

/**
 * Execute sync-customer: reconcile payments for a specific customer
 * Calls the shared reconcilePayments function directly
 */
async function executeSyncCustomer(customerId: number): Promise<void> {
  // Sync clock from test_kv before running (for testing)
  await dbClockProvider.syncFromTestKv();

  const result = await reconcilePayments(customerId);

  console.log(
    `[SYNC] Customer ${customerId}: ${result.chargesSucceeded} succeeded, ${result.chargesFailed} failed`
  );
}

/**
 * Execute sync-all: run the unified periodic billing job
 * Calls the shared billing functions directly. Handles:
 * - Monthly billing cycle processing
 * - Payment retries
 * - Grace period expiration
 * - Cancellation cleanup
 * - Housekeeping
 */
async function executeSyncAll(): Promise<void> {
  // Sync clock from test_kv before running (for testing)
  await dbClockProvider.syncFromTestKv();

  const clock = dbClockProvider.getClock();
  const suiService = getSuiService();

  const billingConfig = {
    clock,
    gracePeriodDays: 14,
    maxRetryAttempts: 3,
    retryIntervalHours: 24,
    usageChargeThresholdCents: 500, // $5 threshold
  };

  const result = await runPeriodicBillingJob(db, billingConfig, suiService);

  if (result.errors.length > 0) {
    console.warn(`[SYNC] sync-all completed with errors: ${result.errors.join(', ')}`);
  }

  console.log(
    `[SYNC] sync-all billing: ${result.phases.billing.customersProcessed} customers processed in ${result.durationMs}ms`
  );

  // Generate vaults after billing (captures any subscription changes)
  // Vault generation handles two scenarios:
  // - Scenario 1 (Reactive): Customer has configChangeVaultSeq > currentVaultSeq
  // - Scenario 2 (Drift): DB content differs from data_tx content
  try {
    const vaultResults = await generateAllVaults();
    const generated = Object.entries(vaultResults)
      .filter(([_, r]) => r.generated)
      .map(([type, r]) => `${type}:${r.seq}(${r.trigger})`)
      .join(', ');
    const unchanged = Object.entries(vaultResults)
      .filter(([_, r]) => !r.generated)
      .map(([type]) => type)
      .join(', ');

    if (generated) {
      console.log(`[SYNC] sync-all vaults generated: ${generated}`);
    }
    if (unchanged) {
      console.log(`[SYNC] sync-all vaults unchanged: ${unchanged}`);
    }
  } catch (vaultError) {
    console.error('[SYNC] sync-all vault generation failed:', vaultError);
    // Create admin notification for vault generation failure
    await createVaultFailureNotification(vaultError);
    // Don't fail the entire sync-all for vault errors
  }

  // Poll LM status after vault generation (tracks propagation)
  try {
    const lmResult = await pollLMStatus();
    console.log(
      `[SYNC] sync-all LM poll: ${lmResult.up}/${lmResult.polled} up, minAppliedSeq=${lmResult.minAppliedSeq ?? 'N/A'}`
    );
  } catch (lmError) {
    console.error('[SYNC] sync-all LM polling failed:', lmError);
    // Create admin notification for LM polling failure
    await createLMPollFailureNotification(lmError);
    // Don't fail the entire sync-all for LM polling errors
  }
}

/**
 * Create an admin notification for vault generation failure
 */
async function createVaultFailureNotification(error: unknown): Promise<void> {
  try {
    await db.insert(adminNotifications).values({
      severity: 'error',
      category: 'vault',
      code: 'VAULT_GENERATION_FAILED',
      message: 'Vault generation failed during sync-all',
      details: JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString(),
      }),
    });
  } catch (notifyError) {
    console.error('[QUEUE] Failed to create vault failure notification:', notifyError);
  }
}

/**
 * Create an admin notification for LM polling failure
 */
async function createLMPollFailureNotification(error: unknown): Promise<void> {
  try {
    await db.insert(adminNotifications).values({
      severity: 'warning',
      category: 'lm',
      code: 'LM_POLL_FAILED',
      message: 'LM status polling failed during sync-all',
      details: JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString(),
      }),
    });
  } catch (notifyError) {
    console.error('[QUEUE] Failed to create LM poll failure notification:', notifyError);
  }
}

/**
 * Create an admin notification for a failed task
 */
async function createFailureNotification(
  taskType: TaskType,
  customerId: number | undefined,
  error: unknown
): Promise<void> {
  try {
    await db.insert(adminNotifications).values({
      severity: 'error',
      category: 'sync',
      code: 'SYNC_TASK_FAILED',
      message: `${taskType} task failed${customerId ? ` for customer ${customerId}` : ''}`,
      details: JSON.stringify({
        taskType,
        customerId,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }),
    });
  } catch (notifyError) {
    console.error('[QUEUE] Failed to create failure notification:', notifyError);
  }
}

// ============================================================================
// Periodic Processing
// ============================================================================

let periodicInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start periodic sync-all processing
 * @param intervalMs - Interval between sync-all runs (default: 1 hour)
 */
export function startPeriodicSync(intervalMs: number = 60 * 60 * 1000): void {
  if (periodicInterval) {
    console.log('[QUEUE] Periodic sync already running');
    return;
  }

  console.log(`[QUEUE] Starting periodic sync-all every ${intervalMs / 1000}s`);

  // Queue initial sync-all
  queueSyncAll('periodic');

  // Schedule periodic sync-all
  periodicInterval = setInterval(() => {
    queueSyncAll('periodic');
  }, intervalMs);
}

/**
 * Stop periodic sync-all processing
 */
export function stopPeriodicSync(): void {
  if (periodicInterval) {
    clearInterval(periodicInterval);
    periodicInterval = null;
    console.log('[QUEUE] Stopped periodic sync');
  }
}
