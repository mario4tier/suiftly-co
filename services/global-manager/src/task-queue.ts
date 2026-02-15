/**
 * Task Queue for Global Manager
 *
 * In-memory queue with "at most 2" deduplication for background processing tasks.
 * Three task types:
 * - sync-customer: On-demand sync for a specific customer (from API or test)
 * - sync-all: Periodic billing, vault generation, and drift detection
 * - sync-lm-status: Fast LM status polling (every 5s) for quick "Updating..." feedback
 *
 * Deduplication strategy (per-customer for sync-customer, global for sync-all/sync-lm-status):
 * - If not processing: start processing immediately
 * - If processing and no pending: mark one pending
 * - If processing and already pending: deduplicate (ignore)
 *
 * This ensures at most 2 instances: 1 processing + 1 pending.
 * The pending one catches any state changes that occurred during processing.
 *
 * Interval configuration:
 * - sync-lm-status: 5s (both dev and prod) - fast status updates for UX
 * - sync-all: 30s (test/dev), 5 min (prod) - billing and drift detection
 *
 * Await mode (for testing):
 * - Use queueSyncCustomerAwait() or queueSyncAllAwait() to wait for completion
 * - Returns only after the task (and any pending follow-up) completes
 */

import { db, adminNotifications } from '@suiftly/database';
import { runPeriodicBillingJob } from '@suiftly/database/billing';
import { getSuiService } from '@suiftly/database/sui-mock';
import { getStripeService } from '@suiftly/database/stripe-mock';
import { getMockClockState, setMockClockState } from '@suiftly/database/test-kv';
import { dbClockProvider } from '@suiftly/shared/db-clock';
import { reconcilePayments } from './reconcile-payments.js';
import { generateAllVaults } from './tasks/generate-vault.js';
import { pollLMStatus } from './tasks/poll-lm-status.js';
import {
  processSealRegistrations,
  recoverStaleOps,
  createSealRegistrationFailureNotification,
} from './tasks/process-seal-registrations.js';
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

export type TaskType = 'sync-customer' | 'sync-all' | 'sync-lm-status';

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
  syncLMStatusProcessing: boolean;
  syncLMStatusPending: boolean;
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

// Global sync-lm-status state (fast LM polling)
let syncLMStatusProcessing = false;
let syncLMStatusPendingAfterCurrent = false;
let syncLMStatusLastSource: QueuedTask['source'] = 'periodic';
let syncLMStatusCompletionPromise: Promise<void> | null = null;
let syncLMStatusResolveCompletion: (() => void) | null = null;

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
 * Queue a sync-customer task and wait for completion
 * Returns after the task (and any pending follow-up) completes
 */
export async function queueSyncCustomerAwait(
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
 * Queue a sync-all task and wait for completion
 * Returns after the task (and any pending follow-up) completes
 */
export async function queueSyncAllAwait(
  source: QueuedTask['source'] = 'test'
): Promise<QueuedTask | null> {
  const task = queueSyncAll(source);

  if (syncAllCompletionPromise) {
    await syncAllCompletionPromise;
  }

  return task;
}

/**
 * Queue a sync-lm-status task with "at most 2" deduplication
 * Fast LM polling for quick "Updating..." feedback (every 5s)
 * Returns the task if queued/will run, null if deduplicated
 */
export function queueSyncLMStatus(source: QueuedTask['source'] = 'periodic'): QueuedTask | null {
  if (!syncLMStatusProcessing) {
    // Not processing - start immediately
    syncLMStatusProcessing = true;
    syncLMStatusLastSource = source;

    // Create completion promise for sync callers
    syncLMStatusCompletionPromise = new Promise<void>((resolve) => {
      syncLMStatusResolveCompletion = resolve;
    });

    const task: QueuedTask = {
      id: generateTaskId(),
      type: 'sync-lm-status',
      createdAt: new Date(),
      source,
    };

    // Process async (don't await) - silent mode, no logging for periodic polls
    void processSyncLMStatusTask(task.id, source !== 'periodic');

    return task;
  } else if (!syncLMStatusPendingAfterCurrent) {
    // Processing but no pending - queue one more
    syncLMStatusPendingAfterCurrent = true;
    syncLMStatusLastSource = source;

    const task: QueuedTask = {
      id: generateTaskId(),
      type: 'sync-lm-status',
      createdAt: new Date(),
      source,
    };

    // Silent: don't log periodic pending
    if (source !== 'periodic') {
      console.log(`[QUEUE] Queued pending sync-lm-status (source: ${source})`);
    }
    return task;
  } else {
    // Already processing with one pending - deduplicate silently
    return null;
  }
}

/**
 * Queue a sync-lm-status task and wait for completion
 * Returns after the task (and any pending follow-up) completes
 */
export async function queueSyncLMStatusAwait(
  source: QueuedTask['source'] = 'test'
): Promise<QueuedTask | null> {
  const task = queueSyncLMStatus(source);

  if (syncLMStatusCompletionPromise) {
    await syncLMStatusCompletionPromise;
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
    syncLMStatusProcessing,
    syncLMStatusPending: syncLMStatusPendingAfterCurrent,
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
 * Process a sync-lm-status task (fast LM polling)
 */
async function processSyncLMStatusTask(taskId: string, verbose: boolean = false): Promise<void> {
  const startTime = Date.now();

  try {
    await executeSyncLMStatus();
    totalProcessed++;
    lastProcessedAt = new Date();

    if (verbose) {
      const duration = Date.now() - startTime;
      console.log(`[QUEUE] Completed sync-lm-status ${taskId} in ${duration}ms`);
    }
  } catch (error) {
    totalFailed++;
    console.error(`[QUEUE] Task ${taskId} (sync-lm-status) failed:`, error);

    // Create admin notification for failed LM polling
    await createLMPollFailureNotification(error);
  } finally {
    // Check if there's a pending request
    if (syncLMStatusPendingAfterCurrent) {
      syncLMStatusPendingAfterCurrent = false;
      const newTaskId = generateTaskId();
      // Recursively process the pending one (await to chain completion)
      await processSyncLMStatusTask(newTaskId, verbose);
    } else {
      // No more pending - mark as not processing and resolve completion
      syncLMStatusProcessing = false;
      if (syncLMStatusResolveCompletion) {
        syncLMStatusResolveCompletion();
        syncLMStatusResolveCompletion = null;
        syncLMStatusCompletionPromise = null;
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
  const paymentServices = { suiService: getSuiService(), stripeService: getStripeService() };

  const billingConfig = {
    clock,
    gracePeriodDays: 14,
    maxRetryAttempts: 3,
    retryIntervalHours: 24,
    usageChargeThresholdCents: 500, // $5 threshold
  };

  const result = await runPeriodicBillingJob(db, billingConfig, paymentServices);

  if (result.errors.length > 0) {
    console.warn(`[SYNC] sync-all completed with errors: ${result.errors.join(', ')}`);
  }

  console.log(
    `[SYNC] sync-all billing: ${result.phases.billing.customersProcessed} customers processed in ${result.durationMs}ms`
  );

  // Process seal registrations before vault generation
  // This ensures newly registered keys are included in the vault
  try {
    // First, recover any stale ops stuck in 'processing' state
    const recoveredOps = await recoverStaleOps();
    if (recoveredOps > 0) {
      console.log(`[SYNC] sync-all recovered ${recoveredOps} stale seal registration ops`);
    }

    // Then process queued registrations
    const sealResults = await processSealRegistrations();
    if (sealResults.queued > 0) {
      console.log(
        `[SYNC] sync-all seal registrations: ${sealResults.completed} completed, ` +
          `${sealResults.failed} failed, ${sealResults.queued - sealResults.completed - sealResults.failed} remaining`
      );
    }
  } catch (sealError) {
    console.error('[SYNC] sync-all seal registration processing failed:', sealError);
    await createSealRegistrationFailureNotification(sealError);
    // Don't fail the entire sync-all for seal registration errors
  }

  // Generate vaults after billing and seal registration (captures any changes)
  // Vault generation handles two scenarios:
  // - Scenario 1 (Reactive): Customer has configChangeVaultSeq > currentVaultSeq
  // - Scenario 2 (Drift): DB content differs from data_tx content
  try {
    const vaultStartTime = Date.now();
    const vaultResults = await generateAllVaults();
    const vaultDurationMs = Date.now() - vaultStartTime;

    const generated = Object.entries(vaultResults)
      .filter(([_, r]) => r.generated)
      .map(([type, r]) => `${type}:${r.seq}(${r.trigger})`)
      .join(', ');
    const unchanged = Object.entries(vaultResults)
      .filter(([_, r]) => !r.generated)
      .map(([type]) => type)
      .join(', ');

    if (generated) {
      console.log(`[SYNC] sync-all vaults generated: ${generated} (${vaultDurationMs}ms)`);
    }
    if (unchanged) {
      console.log(`[SYNC] sync-all vaults unchanged: ${unchanged} (${vaultDurationMs}ms)`);
    }

    // Check for slow vault generation (threshold: 4 seconds)
    // Deduplicated notification - only fires once per slow period
    if (vaultDurationMs > VAULT_GENERATION_SLOW_THRESHOLD_MS) {
      await createSlowVaultNotification(vaultDurationMs, vaultResults);
    }
  } catch (vaultError) {
    console.error('[SYNC] sync-all vault generation failed:', vaultError);
    // Create admin notification for vault generation failure
    await createVaultFailureNotification(vaultError);
    // Don't fail the entire sync-all for vault errors
  }

  // Note: LM status polling is now handled by the separate sync-lm-status task
  // which runs every 5 seconds for fast "Updating..." feedback
}

/**
 * Execute sync-lm-status: poll LM status for fast UI updates
 * Runs frequently (every 5s) to quickly reflect vault sync status
 */
async function executeSyncLMStatus(): Promise<void> {
  const lmResult = await pollLMStatus();

  // Only log if there are issues (silent for normal operation)
  if (lmResult.down > 0) {
    console.log(
      `[SYNC] LM poll: ${lmResult.up}/${lmResult.polled} up, ${lmResult.down} down, minAppliedSeq: ${Object.entries(lmResult.minAppliedSeqByVault).map(([t, s]) => `${t}=${s}`).join(', ') || 'N/A'}`
    );
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
 * Deduplication state for slow vault notifications
 * Only notify once per hour to avoid spam during prolonged slowness
 */
let lastSlowVaultNotificationAt: Date | null = null;
const SLOW_VAULT_NOTIFICATION_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

/**
 * Create a deduplicated admin notification for slow vault generation
 * Only creates notification if:
 * 1. No notification has been sent in the last hour, OR
 * 2. The duration is significantly worse (>2x) than the threshold
 */
async function createSlowVaultNotification(
  durationMs: number,
  vaultResults: Record<string, { generated: boolean; seq: number; entryCount: number }>
): Promise<void> {
  const now = new Date();

  // Check cooldown (1 hour between notifications)
  if (lastSlowVaultNotificationAt) {
    const timeSinceLastNotification = now.getTime() - lastSlowVaultNotificationAt.getTime();
    if (timeSinceLastNotification < SLOW_VAULT_NOTIFICATION_COOLDOWN_MS) {
      // Still in cooldown - skip notification but log for debugging
      console.warn(
        `[QUEUE] Slow vault generation (${durationMs}ms) - notification suppressed (cooldown: ${Math.round((SLOW_VAULT_NOTIFICATION_COOLDOWN_MS - timeSinceLastNotification) / 1000)}s remaining)`
      );
      return;
    }
  }

  // Create notification
  try {
    const totalEntries = Object.values(vaultResults).reduce((sum, r) => sum + r.entryCount, 0);
    const generatedVaults = Object.entries(vaultResults)
      .filter(([_, r]) => r.generated)
      .map(([type, r]) => `${type}:${r.seq}`)
      .join(', ');

    await db.insert(adminNotifications).values({
      severity: 'warning',
      category: 'vault',
      code: 'VAULT_GENERATION_SLOW',
      message: `Vault generation took ${durationMs}ms (threshold: ${VAULT_GENERATION_SLOW_THRESHOLD_MS}ms)`,
      details: JSON.stringify({
        durationMs,
        thresholdMs: VAULT_GENERATION_SLOW_THRESHOLD_MS,
        totalEntries,
        generatedVaults: generatedVaults || 'none',
        timestamp: now.toISOString(),
      }),
    });

    // Update last notification time
    lastSlowVaultNotificationAt = now;

    console.warn(
      `[QUEUE] ADMIN NOTIFICATION: Slow vault generation (${durationMs}ms > ${VAULT_GENERATION_SLOW_THRESHOLD_MS}ms threshold)`
    );
  } catch (notifyError) {
    console.error('[QUEUE] Failed to create slow vault notification:', notifyError);
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

let periodicSyncAllInterval: ReturnType<typeof setInterval> | null = null;
let periodicLMStatusInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Interval constants for periodic tasks
 */
export const LM_STATUS_INTERVAL_MS = 5 * 1000; // 5 seconds (both dev and prod)
export const SYNC_ALL_INTERVAL_DEV_MS = 5 * 1000; // 5 seconds (test/dev)
export const SYNC_ALL_INTERVAL_PROD_MS = 5 * 1000; // 5 seconds (production)

// Threshold for slow vault generation warning (ms)
const VAULT_GENERATION_SLOW_THRESHOLD_MS = 4000;

/**
 * Start periodic sync-all processing (billing, vault generation, drift detection)
 * @param intervalMs - Interval between sync-all runs
 */
export function startPeriodicSyncAll(intervalMs: number): void {
  if (periodicSyncAllInterval) {
    console.log('[QUEUE] Periodic sync-all already running');
    return;
  }

  console.log(`[QUEUE] Starting periodic sync-all every ${intervalMs / 1000}s`);

  // Queue initial sync-all
  queueSyncAll('periodic');

  // Schedule periodic sync-all
  periodicSyncAllInterval = setInterval(() => {
    queueSyncAll('periodic');
  }, intervalMs);
}

/**
 * Start periodic LM status polling (fast, for quick UI updates)
 * @param intervalMs - Interval between LM polls (default: 5s)
 */
export function startPeriodicLMStatus(intervalMs: number = LM_STATUS_INTERVAL_MS): void {
  if (periodicLMStatusInterval) {
    console.log('[QUEUE] Periodic LM status already running');
    return;
  }

  console.log(`[QUEUE] Starting periodic LM status every ${intervalMs / 1000}s`);

  // Queue initial LM status poll
  queueSyncLMStatus('periodic');

  // Schedule periodic LM status polling
  periodicLMStatusInterval = setInterval(() => {
    queueSyncLMStatus('periodic');
  }, intervalMs);
}

/**
 * Start all periodic processing (convenience function)
 * @param syncAllIntervalMs - Interval for sync-all (billing, drift detection)
 * @param lmStatusIntervalMs - Interval for LM status polling (default: 5s)
 */
export function startPeriodicSync(
  syncAllIntervalMs: number,
  lmStatusIntervalMs: number = LM_STATUS_INTERVAL_MS
): void {
  startPeriodicSyncAll(syncAllIntervalMs);
  startPeriodicLMStatus(lmStatusIntervalMs);
}

/**
 * Stop all periodic processing
 */
export function stopPeriodicSync(): void {
  if (periodicSyncAllInterval) {
    clearInterval(periodicSyncAllInterval);
    periodicSyncAllInterval = null;
  }
  if (periodicLMStatusInterval) {
    clearInterval(periodicLMStatusInterval);
    periodicLMStatusInterval = null;
  }
  console.log('[QUEUE] Stopped all periodic sync');
}
