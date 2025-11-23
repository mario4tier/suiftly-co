/**
 * Billing module exports
 *
 * Provides billing-specific calculations and types
 * Uses the global clock for consistent time handling
 */

// Export all billing period calculations
export {
  type BillingPeriod,
  getCurrentBillingPeriodStart,
  getCurrentBillingPeriodEnd,
  getCurrentPeriodDaysUsed,
  getCurrentPeriodDaysRemaining,
  getBillingPeriodInfo,
  isWithinGracePeriod,
  calculateProRatedAmount,
  getNextBillingPeriodStart,
  isLastDayOfBillingPeriod,
  hasNewPeriodStarted,
} from './periods';