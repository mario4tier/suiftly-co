/**
 * Billing Processor Module (Phase 1B + Phase 2)
 *
 * Complete billing engine with service integration.
 */

// Core processor
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
