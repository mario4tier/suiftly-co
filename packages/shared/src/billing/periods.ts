/**
 * Billing period calculations using the database clock
 *
 * These functions provide billing-specific date calculations
 * while using the unified DBClock for timestamp consistency.
 */

import { getDBClock } from '../db-clock';

/**
 * Billing period information
 */
export interface BillingPeriod {
  start: Date;
  end: Date;
  daysInPeriod: number;
  daysElapsed: number;
  daysRemaining: number;
}

/**
 * Get the start of the current 28-day billing period for a customer
 *
 * @param customerCreatedAt - When the customer account was created
 * @returns Start date of the current 28-day period
 */
export function getCurrentBillingPeriodStart(customerCreatedAt: Date): Date {
  const clock = getDBClock();
  const now = clock.now();
  // Work entirely in UTC to avoid timezone issues
  const created = new Date(Date.UTC(
    customerCreatedAt.getUTCFullYear(),
    customerCreatedAt.getUTCMonth(),
    customerCreatedAt.getUTCDate(),
    0, 0, 0, 0
  ));

  // Calculate how many complete 28-day periods have passed
  const daysSinceCreation = Math.floor((now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24));
  const completePeriods = Math.floor(daysSinceCreation / 28);

  // Start of current period is created date + (completePeriods * 28 days)
  const periodStart = new Date(created);
  periodStart.setUTCDate(periodStart.getUTCDate() + (completePeriods * 28));

  return periodStart;
}

/**
 * Get the end of the current 28-day billing period for a customer
 *
 * @param customerCreatedAt - When the customer account was created
 * @returns End date of the current 28-day period (exclusive)
 */
export function getCurrentBillingPeriodEnd(customerCreatedAt: Date): Date {
  const periodStart = getCurrentBillingPeriodStart(customerCreatedAt);
  const periodEnd = new Date(periodStart);
  periodEnd.setUTCDate(periodEnd.getUTCDate() + 28);
  return periodEnd;
}

/**
 * Calculate the number of days in the current billing period that have been used
 *
 * @param customerCreatedAt - When the customer was created
 * @returns Number of days used in current period
 */
export function getCurrentPeriodDaysUsed(customerCreatedAt: Date): number {
  const clock = getDBClock();
  const periodStart = getCurrentBillingPeriodStart(customerCreatedAt);
  const now = clock.now();
  const msUsed = now.getTime() - periodStart.getTime();
  return Math.floor(msUsed / (1000 * 60 * 60 * 24));
}

/**
 * Calculate the number of days remaining in the current billing period
 *
 * @param customerCreatedAt - When the customer was created
 * @returns Number of days remaining
 */
export function getCurrentPeriodDaysRemaining(customerCreatedAt: Date): number {
  const daysUsed = getCurrentPeriodDaysUsed(customerCreatedAt);
  return Math.max(0, 28 - daysUsed);
}

/**
 * Get complete billing period information
 *
 * @param customerCreatedAt - When the customer was created
 * @returns Billing period details
 */
export function getBillingPeriodInfo(customerCreatedAt: Date): BillingPeriod {
  const start = getCurrentBillingPeriodStart(customerCreatedAt);
  const end = getCurrentBillingPeriodEnd(customerCreatedAt);
  const daysElapsed = getCurrentPeriodDaysUsed(customerCreatedAt);
  const daysRemaining = getCurrentPeriodDaysRemaining(customerCreatedAt);

  return {
    start,
    end,
    daysInPeriod: 28,
    daysElapsed,
    daysRemaining,
  };
}

/**
 * Check if a given date is within the grace period
 *
 * @param lastPaymentDate - Date of the last successful payment
 * @param gracePeriodDays - Number of days for grace period (default 14)
 * @returns True if currently within grace period
 */
export function isWithinGracePeriod(lastPaymentDate: Date, gracePeriodDays: number = 14): boolean {
  const clock = getDBClock();
  const now = clock.now();
  const graceEndDate = new Date(lastPaymentDate);
  graceEndDate.setDate(graceEndDate.getDate() + gracePeriodDays);
  return now < graceEndDate;
}

/**
 * Calculate pro-rated amount for remaining days in period
 *
 * @param fullAmount - The full 28-day period amount
 * @param customerCreatedAt - When the customer was created
 * @returns Pro-rated amount for remaining days
 */
export function calculateProRatedAmount(fullAmount: number, customerCreatedAt: Date): number {
  const daysRemaining = getCurrentPeriodDaysRemaining(customerCreatedAt);
  return Math.round((fullAmount * daysRemaining) / 28);
}

/**
 * Get the next billing period start date
 *
 * @param customerCreatedAt - When the customer was created
 * @returns Start of the next billing period
 */
export function getNextBillingPeriodStart(customerCreatedAt: Date): Date {
  return getCurrentBillingPeriodEnd(customerCreatedAt);
}

/**
 * Check if we're in the last day of the billing period
 *
 * @param customerCreatedAt - When the customer was created
 * @returns True if this is the last day
 */
export function isLastDayOfBillingPeriod(customerCreatedAt: Date): boolean {
  return getCurrentPeriodDaysRemaining(customerCreatedAt) === 1;
}

/**
 * Check if a new billing period has started since a given date
 *
 * @param customerCreatedAt - When the customer was created
 * @param sinceDate - Date to check from
 * @returns True if a new period has started
 */
export function hasNewPeriodStarted(customerCreatedAt: Date, sinceDate: Date): boolean {
  const currentPeriodStart = getCurrentBillingPeriodStart(customerCreatedAt);
  return currentPeriodStart > sinceDate;
}