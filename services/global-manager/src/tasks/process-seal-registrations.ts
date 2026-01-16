/**
 * Process Seal Registrations Task
 *
 * GM task that processes queued seal key registration operations.
 * Handles both initial registration (create KeyServer on Sui) and
 * updates (when packages change).
 *
 * Features:
 * - Polls `seal_registration_ops` table for queued operations
 * - Executes Sui transactions via SuiTransactionService
 * - Implements exponential backoff for failures (0s, 5s, 15s, 45s, 2m15s, 5m max)
 * - Self-healing via `recoverStaleOps()` for stuck 'processing' ops
 * - Triggers vault sync after successful registration
 *
 * Design: See APP_SEAL_DESIGN.md Phase 3
 */

import { db, sealRegistrationOps, sealKeys, sealPackages, adminNotifications } from '@suiftly/database';
import { eq, and, or, lt, gt, isNull, lte, asc } from 'drizzle-orm';
import {
  getSuiTransactionService,
  type RegisterKeyResult,
} from '@suiftly/database/sui-seal';

// ============================================================================
// Constants
// ============================================================================

/** Maximum operations to process per batch */
const BATCH_SIZE = 5;

/** Stale threshold: ops stuck in 'processing' for longer than this are recovered */
const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

/** Log prefix for all seal registration logs */
const LOG_PREFIX = '[SEAL-REG]';

/**
 * Key server base URLs by network.
 *
 * These URLs are stored on-chain in the KeyServer object and are used by
 * the Seal SDK to discover where to send decryption requests.
 *
 * URL structure: {baseUrl}/v1/
 * The key server handles routing based on the requested key ID.
 */
const KEY_SERVER_URLS: Record<string, string> = {
  mainnet: 'https://seal.suiftly.io/v1/',
  testnet: 'https://seal-testnet.suiftly.io/v1/',
};

// ============================================================================
// Key Type Detection
// ============================================================================

/**
 * Determine the BLS12-381 key type from the public key length.
 *
 * Per the Seal contract specification:
 * - key_type 0: BLS12-381 G1 (48 bytes compressed)
 * - key_type 1: BLS12-381 G2 (96 bytes compressed)
 *
 * @param publicKey - The BLS12-381 public key bytes
 * @returns 0 for G1 (48 bytes), 1 for G2 (96 bytes)
 * @throws Error if public key length is invalid
 */
function getKeyType(publicKey: Buffer): number {
  if (publicKey.length === 48) {
    return 0; // BLS12-381 G1
  } else if (publicKey.length === 96) {
    return 1; // BLS12-381 G2
  } else {
    throw new Error(
      `Invalid public key length: ${publicKey.length} bytes (expected 48 for G1 or 96 for G2)`
    );
  }
}

/**
 * Get the key server URL for a given network.
 *
 * This URL is stored on-chain and used by the Seal SDK to discover
 * the decryption endpoint. The same URL is used for all keys on the
 * network - routing is handled by the key server based on the object ID.
 *
 * @param network - 'mainnet' or 'testnet'
 * @returns The key server base URL for the network
 */
function getKeyServerUrl(network: string): string {
  const url = KEY_SERVER_URLS[network];
  if (!url) {
    throw new Error(`Unknown network: ${network} (expected 'mainnet' or 'testnet')`);
  }
  return url;
}

// ============================================================================
// Types
// ============================================================================

export interface ProcessSealRegistrationsResult {
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  errors: string[];
}

// ============================================================================
// Exponential Backoff
// ============================================================================

/**
 * Calculate retry delay using exponential backoff.
 *
 * Schedule:
 * - Attempt 1: immediate (0s)
 * - Attempt 2: 5s
 * - Attempt 3: 15s
 * - Attempt 4: 45s
 * - Attempt 5: 2m 15s
 * - Attempt 6+: 5m (capped)
 *
 * Formula: attempt <= 1 ? 0 : min(5 * (3^(attempt-2)), 300) seconds
 */
function calculateRetryDelayMs(attemptCount: number): number {
  if (attemptCount <= 1) {
    return 0; // Immediate retry on first failure
  }
  const delaySeconds = Math.min(5 * Math.pow(3, attemptCount - 2), 300);
  return delaySeconds * 1000;
}

// ============================================================================
// Vault Sync Trigger
// ============================================================================

/**
 * Trigger vault synchronization after successful registration.
 *
 * Fire-and-forget: if this fails, registration is still successful.
 * Vault sync will happen via GM periodic task anyway.
 */
async function triggerVaultSync(): Promise<void> {
  try {
    // GM's sync-all task handles vault generation
    // For now, we just log - in production, this would call an endpoint
    console.log(`${LOG_PREFIX} Vault sync triggered after registration`);
  } catch (error) {
    console.error(`${LOG_PREFIX} Vault sync failed (non-fatal):`, error);
    // Don't rethrow - registration succeeded, vault sync can happen later
  }
}

// ============================================================================
// Operation Execution
// ============================================================================

/**
 * Execute a single seal registration operation.
 *
 * For 'register' ops: Creates a new KeyServer object on Sui
 * For 'update' ops: Updates the KeyServer's packages (may be no-op)
 */
async function executeOperation(
  op: typeof sealRegistrationOps.$inferSelect
): Promise<RegisterKeyResult> {
  const suiService = getSuiTransactionService();

  // Load seal key details with packages
  const sealKey = await db.query.sealKeys.findFirst({
    where: eq(sealKeys.sealKeyId, op.sealKeyId),
    with: {
      packages: true,
    },
  });

  if (!sealKey) {
    return {
      success: false,
      error: `Seal key ${op.sealKeyId} not found`,
    };
  }

  // Check if key was deleted during processing
  if (sealKey.deletedAt) {
    console.log(`${LOG_PREFIX} Key ${op.sealKeyId} was deleted, marking op as completed`);
    return {
      success: true,
      objectId: sealKey.objectId ? `0x${sealKey.objectId.toString('hex')}` : undefined,
      alreadyExists: true,
    };
  }

  if (op.opType === 'register') {
    // Initial registration - create KeyServer object
    const existingObjectId = sealKey.objectId
      ? `0x${sealKey.objectId.toString('hex')}`
      : undefined;

    // Derive key type from public key length (48 bytes = G1, 96 bytes = G2)
    const keyType = getKeyType(sealKey.publicKey);

    // Get network-specific key server URL
    const keyServerUrl = getKeyServerUrl(op.network);

    console.log(
      `${LOG_PREFIX} Registering key ${op.sealKeyId} on ${op.network} ` +
        `(keyType=${keyType === 0 ? 'G1' : 'G2'}, url=${keyServerUrl})`
    );

    const result = await suiService.registerKey({
      name: sealKey.name || `seal-key-${sealKey.sealKeyId}`,
      url: keyServerUrl,
      keyType,
      publicKey: sealKey.publicKey,
      network: op.network as 'mainnet' | 'testnet',
      existingObjectId,
    });

    if (result.success) {
      console.log(
        `${LOG_PREFIX} Key ${op.sealKeyId} registered: objectId=${result.objectId}` +
          (result.alreadyExists ? ' (already existed)' : '')
      );
    }

    return result;
  } else if (op.opType === 'update') {
    // Update - re-register with updated packages
    if (!sealKey.objectId) {
      return {
        success: false,
        error: `Cannot update key ${op.sealKeyId}: no objectId (not registered yet)`,
      };
    }

    const enabledPackages = sealKey.packages
      .filter((p) => p.isUserEnabled)
      .map((p) => `0x${p.packageAddress.toString('hex')}`);

    console.log(
      `${LOG_PREFIX} Updating key ${op.sealKeyId} with ${enabledPackages.length} packages`
    );

    const result = await suiService.updateKey({
      objectId: `0x${sealKey.objectId.toString('hex')}`,
      packages: enabledPackages,
      network: op.network as 'mainnet' | 'testnet',
    });

    return result;
  }

  return {
    success: false,
    error: `Unknown operation type: ${op.opType}`,
  };
}

/**
 * Process a single operation: execute, update DB, handle success/failure.
 */
async function processOperation(
  op: typeof sealRegistrationOps.$inferSelect
): Promise<{ success: boolean; error?: string }> {
  const now = new Date();

  // Mark as processing
  await db
    .update(sealRegistrationOps)
    .set({
      status: 'processing',
      startedAt: now,
    })
    .where(eq(sealRegistrationOps.opId, op.opId));

  try {
    const result = await executeOperation(op);

    if (result.success) {
      // SUCCESS: Update op and key in transaction
      await db.transaction(async (tx) => {
        // Update op as completed
        await tx
          .update(sealRegistrationOps)
          .set({
            status: 'completed',
            completedAt: now,
            txDigest: result.txDigest
              ? Buffer.from(result.txDigest.slice(2), 'hex')
              : null,
            objectId: result.objectId
              ? Buffer.from(result.objectId.slice(2), 'hex')
              : null,
            errorMessage: null,
          })
          .where(eq(sealRegistrationOps.opId, op.opId));

        // Update seal key
        const [updatedKey] = await tx
          .update(sealKeys)
          .set({
            registrationStatus: 'registered',
            objectId: result.objectId
              ? Buffer.from(result.objectId.slice(2), 'hex')
              : undefined,
            registerTxnDigest: result.txDigest
              ? Buffer.from(result.txDigest.slice(2), 'hex')
              : undefined,
            registeredPackagesVersion: op.packagesVersionAtOp,
            registrationError: null,
            registrationAttempts: 0,
            nextRetryAt: null,
          })
          .where(eq(sealKeys.sealKeyId, op.sealKeyId))
          .returning();

        // Handle edge case: key was deleted during processing
        if (!updatedKey) {
          console.warn(
            `${LOG_PREFIX} Key ${op.sealKeyId} was deleted during registration, op completed but key gone`
          );
          return;
        }

        // CHECK: More work needed? (package changed during processing)
        if (updatedKey.packagesVersion > op.packagesVersionAtOp) {
          console.log(
            `${LOG_PREFIX} Key ${op.sealKeyId}: packages changed during registration (${updatedKey.packagesVersion} > ${op.packagesVersionAtOp}), queuing update`
          );

          // Mark as updating
          await tx
            .update(sealKeys)
            .set({ registrationStatus: 'updating' })
            .where(eq(sealKeys.sealKeyId, op.sealKeyId));

          // Queue re-registration
          await tx.insert(sealRegistrationOps).values({
            sealKeyId: op.sealKeyId,
            customerId: op.customerId,
            network: op.network,
            opType: 'update',
            status: 'queued',
            packagesVersionAtOp: updatedKey.packagesVersion,
          });
        }
      });

      // Trigger vault sync (fire-and-forget)
      void triggerVaultSync();

      return { success: true };
    } else {
      // FAILURE: Schedule retry with exponential backoff
      const attempts = op.attemptCount + 1;
      const delayMs = calculateRetryDelayMs(attempts);
      const nextRetryAt = new Date(now.getTime() + delayMs);

      await db.transaction(async (tx) => {
        await tx
          .update(sealRegistrationOps)
          .set({
            status: 'queued', // Back to queued for retry
            attemptCount: attempts,
            nextRetryAt,
            errorMessage: result.error || 'Unknown error',
          })
          .where(eq(sealRegistrationOps.opId, op.opId));

        await tx
          .update(sealKeys)
          .set({
            registrationError: result.error || 'Unknown error',
            registrationAttempts: attempts,
            lastRegistrationAttemptAt: now,
            nextRetryAt,
          })
          .where(eq(sealKeys.sealKeyId, op.sealKeyId));
      });

      console.warn(
        `${LOG_PREFIX} Registration failed for key ${op.sealKeyId}, attempt #${attempts}, next retry at ${nextRetryAt.toISOString()}`
      );

      return { success: false, error: result.error };
    }
  } catch (error) {
    // Unexpected error - schedule retry
    const errorMessage = error instanceof Error ? error.message : String(error);
    const attempts = op.attemptCount + 1;
    const delayMs = calculateRetryDelayMs(attempts);
    const nextRetryAt = new Date(now.getTime() + delayMs);

    await db.transaction(async (tx) => {
      await tx
        .update(sealRegistrationOps)
        .set({
          status: 'queued',
          attemptCount: attempts,
          nextRetryAt,
          errorMessage,
        })
        .where(eq(sealRegistrationOps.opId, op.opId));

      await tx
        .update(sealKeys)
        .set({
          registrationError: errorMessage,
          registrationAttempts: attempts,
          lastRegistrationAttemptAt: now,
          nextRetryAt,
        })
        .where(eq(sealKeys.sealKeyId, op.sealKeyId));
    });

    console.error(
      `${LOG_PREFIX} Unexpected error processing op ${op.opId} for key ${op.sealKeyId}:`,
      error
    );

    return { success: false, error: errorMessage };
  }
}

// ============================================================================
// Main Processing Loop
// ============================================================================

/**
 * Process seal registration operations.
 *
 * Polls the `seal_registration_ops` table for queued operations
 * that are ready to process (status = 'queued' AND past retry time).
 *
 * @returns Summary of processing results
 */
export async function processSealRegistrations(): Promise<ProcessSealRegistrationsResult> {
  const now = new Date();
  const result: ProcessSealRegistrationsResult = {
    queued: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    errors: [],
  };

  // Find operations ready to process
  const pendingOps = await db.query.sealRegistrationOps.findMany({
    where: and(
      eq(sealRegistrationOps.status, 'queued'),
      or(
        isNull(sealRegistrationOps.nextRetryAt),
        lte(sealRegistrationOps.nextRetryAt, now)
      )
    ),
    orderBy: asc(sealRegistrationOps.createdAt),
    limit: BATCH_SIZE,
  });

  if (pendingOps.length === 0) {
    return result;
  }

  result.queued = pendingOps.length;
  console.log(`${LOG_PREFIX} Processing ${pendingOps.length} queued registration ops`);

  // Process each operation sequentially
  // (Sequential to avoid overwhelming Sui RPC and for simpler error handling)
  for (const op of pendingOps) {
    result.processing++;
    const opResult = await processOperation(op);

    if (opResult.success) {
      result.completed++;
    } else {
      result.failed++;
      if (opResult.error) {
        result.errors.push(`Op ${op.opId}: ${opResult.error}`);
      }
    }
  }

  console.log(
    `${LOG_PREFIX} Batch complete: ${result.completed} completed, ${result.failed} failed`
  );

  return result;
}

// ============================================================================
// Stale Operation Recovery
// ============================================================================

/**
 * Recover stale operations stuck in 'processing' state.
 *
 * This handles scenarios where GM crashed while processing an operation.
 * Operations stuck in 'processing' for longer than STALE_THRESHOLD_MS
 * are moved back to 'queued' for retry.
 *
 * Should be run:
 * - On GM startup
 * - Periodically (every 5 minutes)
 */
export async function recoverStaleOps(): Promise<number> {
  const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);

  const staleOps = await db
    .update(sealRegistrationOps)
    .set({
      status: 'queued',
      errorMessage: 'Recovered from stale processing state',
    })
    .where(
      and(
        eq(sealRegistrationOps.status, 'processing'),
        lt(sealRegistrationOps.startedAt, staleThreshold)
      )
    )
    .returning({ opId: sealRegistrationOps.opId });

  if (staleOps.length > 0) {
    console.warn(
      `${LOG_PREFIX} Recovered ${staleOps.length} stale registration ops: ${staleOps.map((o) => o.opId).join(', ')}`
    );
  }

  return staleOps.length;
}

// ============================================================================
// Admin Notification
// ============================================================================

/**
 * Create admin notification for seal registration failure.
 *
 * Called when processing encounters an unexpected error.
 */
export async function createSealRegistrationFailureNotification(
  error: unknown
): Promise<void> {
  try {
    await db.insert(adminNotifications).values({
      severity: 'error',
      category: 'seal',
      code: 'SEAL_REGISTRATION_FAILED',
      message: 'Seal registration processing failed',
      details: JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString(),
      }),
    });
  } catch (notifyError) {
    console.error(`${LOG_PREFIX} Failed to create failure notification:`, notifyError);
  }
}

// ============================================================================
// Stats Query
// ============================================================================

/**
 * Get current seal registration queue statistics.
 *
 * Used for monitoring and admin dashboard.
 */
export async function getSealRegistrationStats(): Promise<{
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  oldestQueued: Date | null;
}> {
  const allOps = await db
    .select({
      status: sealRegistrationOps.status,
      createdAt: sealRegistrationOps.createdAt,
    })
    .from(sealRegistrationOps);

  let queued = 0;
  let processing = 0;
  let completed = 0;
  let oldestQueued: Date | null = null;

  for (const op of allOps) {
    if (op.status === 'queued') {
      queued++;
      if (!oldestQueued || op.createdAt < oldestQueued) {
        oldestQueued = op.createdAt;
      }
    } else if (op.status === 'processing') {
      processing++;
    } else if (op.status === 'completed') {
      completed++;
    }
  }

  // Count failed as ops with attemptCount > 0 that are queued (retry pending)
  const failedOps = await db
    .select()
    .from(sealRegistrationOps)
    .where(
      and(eq(sealRegistrationOps.status, 'queued'), gt(sealRegistrationOps.attemptCount, 0))
    );

  return {
    queued,
    processing,
    completed,
    failed: failedOps.length,
    oldestQueued,
  };
}
