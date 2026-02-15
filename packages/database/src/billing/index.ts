/**
 * Billing Processor Module (Phase 1B + Phase 2 + Phase 1C)
 *
 * Complete billing engine with service integration and tier change/cancellation support.
 */

// Unified Periodic Job (THE main entry point for background billing)
export {
  runPeriodicBillingJob,
  runPeriodicJobForCustomer,
} from './periodic-job';

export type {
  PeriodicJobResult,
} from './periodic-job';

// Core processor (internal - prefer runPeriodicBillingJob for production)
export {
  processBilling,
  processCustomerBilling,
  forceSyncUsageToDraft, // On-demand usage sync with force=true (bypasses debouncing)
} from './processor';

// Payment processing
export {
  processInvoicePayment,
  getInvoicePaidAmount,
} from './payments';

// Payment providers
export {
  getCustomerProviders,
  EscrowPaymentProvider,
  StripePaymentProvider,
  PayPalPaymentProvider,
} from './providers';

export type {
  PaymentServices,
} from './providers';

// Credit management
export {
  applyCreditsToInvoice,
  issueCredit,
  getAvailableCredits,
} from './credits';

// Grace period management
export {
  startGracePeriod,
  clearGracePeriod,
  isGracePeriodExpired,
  suspendCustomerForNonPayment,
  resumeCustomerAccount,
  getCustomersWithExpiredGracePeriod,
  recordGracePeriodNotification,
} from './grace-period';

// Idempotency
export {
  withIdempotency,
  generateMonthlyBillingKey,
  generateUsageBillingKey,
  cleanupIdempotencyRecords,
} from './idempotency';

// Locking utilities (re-exported from top-level)
// Prefer importing directly from '@suiftly/database' for new code
export {
  withCustomerLockForAPI,
  withCustomerLock,
  tryCustomerLock,
  unsafeAsLockedTransaction, // Test helper only
} from './locking';

export type {
  LockedTransaction,
} from './locking';

// Invoice management (Phase 2)
export {
  createInvoice,
  getOrCreateDraftInvoice,
  updateDraftInvoiceAmount,
  transitionDraftToPending,
  createAndChargeImmediately,
  voidInvoice,
  // Two-phase commit support
  createPendingInvoiceCommitted,
  markInvoicePaid,
  getInvoiceById,
} from './invoices';

export type {
  InvoiceLineItem,
  CreateInvoiceParams,
} from './invoices';

// Service billing integration (Phase 2)
export {
  handleSubscriptionBilling,
  handleSubscriptionBillingLocked,
  recalculateDraftInvoice,
  calculateProRatedUpgradeCharge,
} from './service-billing';

export type {
  SubscriptionBillingResult,
} from './service-billing';

// Tier change and cancellation (Phase 1C)
// Note: Locked functions require LockedTransaction - call via withCustomerLockForAPI
// Two-Phase Commit for Upgrades (crash-safe):
//   Phase 1: withCustomerLockForAPI → prepareTierUpgradePhase1Locked
//   Between: createUpgradeInvoiceCommitted (commits immediately, no lock)
//   Phase 2: withCustomerLockForAPI → executeTierUpgradePhase2Locked
export {
  handleTierUpgradeLocked, // Single-phase (simpler but less crash-safe)
  // Two-phase commit for tier upgrades (crash-safe)
  prepareTierUpgradePhase1Locked,
  createUpgradeInvoiceCommitted,
  executeTierUpgradePhase2Locked,
  // Other tier operations
  scheduleTierDowngradeLocked,
  cancelScheduledTierChangeLocked,
  scheduleCancellationLocked,
  undoCancellationLocked,
  canProvisionService,
  canPerformKeyOperation,
  getTierChangeOptions,
  applyScheduledTierChanges,
  processScheduledCancellations,
} from './tier-changes';

// Invoice reconciliation (two-phase commit crash recovery)
export {
  reconcileStuckInvoices,
} from './reconciliation';

export type {
  ReconciliationResult,
} from './reconciliation';

// Payment reconciliation moved to Global Manager (services/global-manager/src/reconcile-payments.ts)
// to ensure single-threaded execution via task queue

export type {
  TierUpgradeResult,
  TierUpgradePhase1Result, // Two-phase commit Phase 1 result
  TierDowngradeResult,
  CancellationResult,
  UndoCancellationResult,
  CanProvisionResult,
  CanPerformKeyOperationResult,
  TierChangeOptions,
} from './tier-changes';

// Cancellation cleanup job (Phase 1C)
export {
  processCancellationCleanup,
  getServicesApproachingDeletion,
  cleanupOldCancellationHistory,
} from './cancellation-cleanup';

export type {
  CancellationCleanupResult,
} from './cancellation-cleanup';

// Usage charges (STATS_DESIGN.md D3)
export {
  updateUsageChargesToDraft,
  getUsageChargePreview,
  syncUsageToDraft,
} from './usage-charges';

export type {
  UsageChargeResult,
  UsageSyncResult,
} from './usage-charges';

// Invoice validation (defensive checks)
export {
  validateInvoiceBeforeCharging,
  ensureInvoiceValid,
} from './validation';

export type {
  ValidationSeverity,
  ValidationIssue,
  InvoiceValidationResult,
} from './validation';

// Admin notifications (internal error logging)
export {
  logInternalError,
  logValidationIssues,
} from './admin-notifications';

// Error classes (typed errors for idempotency logic)
export {
  ValidationError,
  SystemError,
} from './errors';

export type {
  NotificationSeverity,
  LogInternalErrorParams,
} from './admin-notifications';


// Types
export type {
  CustomerBillingResult,
  BillingOperation,
  BillingError,
  BillingProcessorConfig,
  CreditApplicationResult,
  InvoicePaymentResult,
  IdempotencyResult,
} from './types';
