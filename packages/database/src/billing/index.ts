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
} from './processor';

// Payment processing
export {
  processInvoicePayment,
  getInvoicePaidAmount,
} from './payments';

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

// Locking utilities
export {
  withCustomerLock,
  tryCustomerLock,
} from './locking';

// Invoice management (Phase 2)
export {
  createInvoice,
  getOrCreateDraftInvoice,
  generateInvoiceNumber,
  updateDraftInvoiceAmount,
  transitionDraftToPending,
  createAndChargeImmediately,
  voidInvoice,
} from './invoices';

export type {
  InvoiceLineItem,
  CreateInvoiceParams,
} from './invoices';

// Service billing integration (Phase 2)
export {
  handleSubscriptionBilling,
  recalculateDraftInvoice,
  calculateProRatedUpgradeCharge,
} from './service-billing';

export type {
  SubscriptionBillingResult,
} from './service-billing';

// Tier change and cancellation (Phase 1C)
export {
  handleTierUpgrade,
  scheduleTierDowngrade,
  cancelScheduledTierChange,
  scheduleCancellation,
  undoCancellation,
  canProvisionService,
  canPerformKeyOperation,
  getTierChangeOptions,
  applyScheduledTierChanges,
  processScheduledCancellations,
} from './tier-changes';

export type {
  TierUpgradeResult,
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
