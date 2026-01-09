/**
 * Unified Periodic Billing Job
 *
 * THE single background job that handles ALL billing operations.
 * Called every 5 minutes in production. Single-threaded. Deterministic order.
 *
 * Design Principles:
 * 1. DETERMINISM: Order of operations is always the same
 * 2. TESTABILITY: One function to call, one result to verify
 * 3. SIMPLICITY: No race conditions between separate jobs
 * 4. DEBUGGABILITY: Single log stream, easy to trace issues
 *
 * Execution Phases (in order):
 * 1. Monthly Billing (1st of month only)
 * 2. Payment Retries
 * 3. Grace Period Expiration
 * 4. Cancellation Cleanup
 * 5. Housekeeping
 *
 * See BILLING_DESIGN.md for detailed requirements.
 */

import type { Database, DatabaseOrTransaction } from '../db';
import { processBilling } from './processor';
import { processCancellationCleanup, cleanupOldCancellationHistory, type CancellationCleanupResult } from './cancellation-cleanup';
import { cleanupIdempotencyRecords } from './idempotency';
import { reconcileStuckInvoices, type ReconciliationResult } from './reconciliation';
import type { BillingProcessorConfig, CustomerBillingResult } from './types';
import type { DBClock } from '@suiftly/shared/db-clock';
import type { ISuiService } from '@suiftly/shared/sui-service';

// ============================================================================
// Types
// ============================================================================

export interface PeriodicJobResult {
  timestamp: Date;
  phases: {
    billing: {
      executed: boolean;
      customersProcessed: number;
      results: CustomerBillingResult[];
    };
    reconciliation: {
      executed: boolean;
      result: ReconciliationResult | null;
    };
    cancellationCleanup: {
      executed: boolean;
      result: CancellationCleanupResult | null;
    };
    housekeeping: {
      idempotencyRecordsDeleted: number;
      cancellationHistoryRecordsDeleted: number;
    };
  };
  errors: string[];
  durationMs: number;
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Run the unified periodic billing job
 *
 * This is THE function that should be called every 5 minutes in production.
 * It handles all billing operations in a deterministic order.
 *
 * In tests, call this via the /test/billing/run-periodic-job API endpoint
 * to simulate realistic production behavior.
 *
 * @param db Database instance
 * @param config Billing processor configuration (includes DBClock)
 * @param suiService Sui service for escrow operations
 * @returns Comprehensive result of all phases
 */
export async function runPeriodicBillingJob(
  db: Database,
  config: BillingProcessorConfig,
  suiService: ISuiService
): Promise<PeriodicJobResult> {
  const startTime = Date.now();
  const result: PeriodicJobResult = {
    timestamp: config.clock.now(),
    phases: {
      billing: {
        executed: false,
        customersProcessed: 0,
        results: [],
      },
      reconciliation: {
        executed: false,
        result: null,
      },
      cancellationCleanup: {
        executed: false,
        result: null,
      },
      housekeeping: {
        idempotencyRecordsDeleted: 0,
        cancellationHistoryRecordsDeleted: 0,
      },
    },
    errors: [],
    durationMs: 0,
  };

  try {
    // =========================================================================
    // PHASE 1: Billing Processing
    // =========================================================================
    // Handles (in order per customer):
    // - Monthly billing (1st of month): scheduled tier changes, cancellations, DRAFT→PENDING, payments
    // - Payment retries for failed invoices
    // - Grace period expiration checks
    //
    // Each customer is processed with customer-level locking to prevent race conditions.

    const billingResults = await processBilling(db, config, suiService);
    result.phases.billing.executed = true;
    result.phases.billing.customersProcessed = billingResults.length;
    result.phases.billing.results = billingResults;

    // Collect any errors from billing
    for (const customerResult of billingResults) {
      for (const error of customerResult.errors) {
        result.errors.push(`Customer ${customerResult.customerId}: ${error.message}`);
      }
    }

    // =========================================================================
    // PHASE 2: Invoice Reconciliation (Two-Phase Commit Recovery)
    // =========================================================================
    // Handles:
    // - 'immediate' invoices stuck in 'pending' for > 10 minutes (crash recovery)
    // - Checks if payment was processed (ledger entry exists)
    // - Marks invoice as 'paid' or 'voided' based on on-chain state

    const reconciliationResult = await reconcileStuckInvoices(db, config.clock);
    result.phases.reconciliation.executed = true;
    result.phases.reconciliation.result = reconciliationResult;

    for (const error of reconciliationResult.errors) {
      result.errors.push(`Reconciliation: ${error}`);
    }

    // =========================================================================
    // PHASE 3: Cancellation Cleanup
    // =========================================================================
    // Handles:
    // - Services in cancellation_pending state for 7+ days
    // - Deletes related data (API keys, Seal keys, packages)
    // - Records cancellation history for cooldown enforcement
    // - Resets service to not_provisioned state

    const cleanupResult = await processCancellationCleanup(db, config.clock);
    result.phases.cancellationCleanup.executed = true;
    result.phases.cancellationCleanup.result = cleanupResult;

    // Collect any errors from cleanup
    for (const error of cleanupResult.errors) {
      result.errors.push(`Cancellation cleanup: ${error}`);
    }

    // =========================================================================
    // PHASE 4: Housekeeping
    // =========================================================================
    // Handles:
    // - Clean up old idempotency records (> 90 days)
    // - Clean up old cancellation history (beyond cooldown period)

    // Clean up idempotency records older than 90 days
    const idempotencyAgeHours = 90 * 24; // 90 days in hours
    result.phases.housekeeping.idempotencyRecordsDeleted = await cleanupIdempotencyRecords(
      db,
      config.clock,
      idempotencyAgeHours
    );

    // Clean up cancellation history older than 30 days (cooldown is 7 days, keep some buffer)
    result.phases.housekeeping.cancellationHistoryRecordsDeleted = await cleanupOldCancellationHistory(
      db,
      config.clock,
      30 // days to keep
    );

  } catch (error) {
    result.errors.push(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
  }

  result.durationMs = Date.now() - startTime;
  return result;
}

/**
 * Run the periodic job for a single customer (for testing)
 *
 * This is useful for API tests that want to simulate the periodic job
 * for a specific customer without processing all customers.
 *
 * @param db Database instance
 * @param customerId Customer ID to process
 * @param config Billing processor configuration
 * @param suiService Sui service for escrow operations
 * @returns Result for the single customer
 */
export async function runPeriodicJobForCustomer(
  db: Database,
  customerId: number,
  config: BillingProcessorConfig,
  suiService: ISuiService
): Promise<PeriodicJobResult> {
  const startTime = Date.now();
  const result: PeriodicJobResult = {
    timestamp: config.clock.now(),
    phases: {
      billing: {
        executed: false,
        customersProcessed: 0,
        results: [],
      },
      reconciliation: {
        executed: false,
        result: null,
      },
      cancellationCleanup: {
        executed: false,
        result: null,
      },
      housekeeping: {
        idempotencyRecordsDeleted: 0,
        cancellationHistoryRecordsDeleted: 0,
      },
    },
    errors: [],
    durationMs: 0,
  };

  try {
    // Import processCustomerBilling for single-customer processing
    const { processCustomerBilling } = await import('./processor');

    // Process single customer
    const customerResult = await processCustomerBilling(db, customerId, config, suiService);
    result.phases.billing.executed = true;
    result.phases.billing.customersProcessed = 1;
    result.phases.billing.results = [customerResult];

    for (const error of customerResult.errors) {
      result.errors.push(`Customer ${customerId}: ${error.message}`);
    }

    // Run reconciliation for stuck invoices
    const reconciliationResult = await reconcileStuckInvoices(db, config.clock);
    result.phases.reconciliation.executed = true;
    result.phases.reconciliation.result = reconciliationResult;

    for (const error of reconciliationResult.errors) {
      result.errors.push(`Reconciliation: ${error}`);
    }

    // Still run cleanup (it's global, but safe to run)
    const cleanupResult = await processCancellationCleanup(db, config.clock);
    result.phases.cancellationCleanup.executed = true;
    result.phases.cancellationCleanup.result = cleanupResult;

    for (const error of cleanupResult.errors) {
      result.errors.push(`Cancellation cleanup: ${error}`);
    }

    // Skip housekeeping for single-customer runs (not critical for tests)

  } catch (error) {
    result.errors.push(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
  }

  result.durationMs = Date.now() - startTime;
  return result;
}
