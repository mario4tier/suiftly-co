/**
 * Tests for billing period calculations
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { dbClockProvider, MockDBClock } from '../db-clock';
import {
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

describe('Billing Period Calculations', () => {
  let clock: MockDBClock;

  beforeEach(() => {
    dbClockProvider.reset();
    clock = dbClockProvider.useMockClock({
      currentTime: new Date('2024-01-15T12:00:00Z'),
      autoAdvance: false,
    });
  });

  describe('getCurrentBillingPeriodStart', () => {
    it('should return customer creation date for first period', () => {
      const customerCreatedAt = new Date('2024-01-15T00:00:00Z');
      const periodStart = getCurrentBillingPeriodStart(customerCreatedAt);
      expect(periodStart.toISOString()).toBe('2024-01-15T00:00:00.000Z');
    });

    it('should calculate correct period start after 28 days', () => {
      const customerCreatedAt = new Date('2024-01-01T00:00:00Z');

      // Set clock to day 29 (second period)
      clock.setTime(new Date('2024-01-29T12:00:00Z'));
      const periodStart = getCurrentBillingPeriodStart(customerCreatedAt);
      expect(periodStart.toISOString()).toBe('2024-01-29T00:00:00.000Z');
    });

    it('should handle multiple period transitions', () => {
      const customerCreatedAt = new Date('2024-01-01T00:00:00Z');

      // Third period (day 57-84)
      clock.setTime(new Date('2024-02-26T12:00:00Z'));
      const periodStart = getCurrentBillingPeriodStart(customerCreatedAt);
      expect(periodStart.toISOString()).toBe('2024-02-26T00:00:00.000Z');
    });
  });

  describe('getCurrentBillingPeriodEnd', () => {
    it('should return 28 days after period start', () => {
      const customerCreatedAt = new Date('2024-01-01T00:00:00Z');
      clock.setTime(new Date('2024-01-15T12:00:00Z'));

      const periodEnd = getCurrentBillingPeriodEnd(customerCreatedAt);
      expect(periodEnd.toISOString()).toBe('2024-01-29T00:00:00.000Z');
    });
  });

  describe('getCurrentPeriodDaysUsed', () => {
    it('should return 0 on first day', () => {
      const customerCreatedAt = new Date('2024-01-15T00:00:00Z');
      clock.setTime(new Date('2024-01-15T00:00:01Z'));

      const daysUsed = getCurrentPeriodDaysUsed(customerCreatedAt);
      expect(daysUsed).toBe(0);
    });

    it('should return correct days mid-period', () => {
      const customerCreatedAt = new Date('2024-01-01T00:00:00Z');
      clock.setTime(new Date('2024-01-15T12:00:00Z'));

      const daysUsed = getCurrentPeriodDaysUsed(customerCreatedAt);
      expect(daysUsed).toBe(14);
    });

    it('should return 27 on last day', () => {
      const customerCreatedAt = new Date('2024-01-01T00:00:00Z');
      clock.setTime(new Date('2024-01-28T23:59:59Z'));

      const daysUsed = getCurrentPeriodDaysUsed(customerCreatedAt);
      expect(daysUsed).toBe(27);
    });

    it('should reset to 0 on new period', () => {
      const customerCreatedAt = new Date('2024-01-01T00:00:00Z');
      clock.setTime(new Date('2024-01-29T00:00:01Z'));

      const daysUsed = getCurrentPeriodDaysUsed(customerCreatedAt);
      expect(daysUsed).toBe(0);
    });
  });

  describe('getCurrentPeriodDaysRemaining', () => {
    it('should return 28 on first day', () => {
      const customerCreatedAt = new Date('2024-01-15T00:00:00Z');
      clock.setTime(new Date('2024-01-15T00:00:01Z'));

      const daysRemaining = getCurrentPeriodDaysRemaining(customerCreatedAt);
      expect(daysRemaining).toBe(28);
    });

    it('should return correct days mid-period', () => {
      const customerCreatedAt = new Date('2024-01-01T00:00:00Z');
      clock.setTime(new Date('2024-01-15T12:00:00Z'));

      const daysRemaining = getCurrentPeriodDaysRemaining(customerCreatedAt);
      expect(daysRemaining).toBe(14);
    });

    it('should return 1 on last day', () => {
      const customerCreatedAt = new Date('2024-01-01T00:00:00Z');
      clock.setTime(new Date('2024-01-28T12:00:00Z'));

      const daysRemaining = getCurrentPeriodDaysRemaining(customerCreatedAt);
      expect(daysRemaining).toBe(1);
    });
  });

  describe('getBillingPeriodInfo', () => {
    it('should return complete period information', () => {
      const customerCreatedAt = new Date('2024-01-01T00:00:00Z');
      clock.setTime(new Date('2024-01-15T12:00:00Z'));

      const info = getBillingPeriodInfo(customerCreatedAt);

      expect(info.start.toISOString()).toBe('2024-01-01T00:00:00.000Z');
      expect(info.end.toISOString()).toBe('2024-01-29T00:00:00.000Z');
      expect(info.daysInPeriod).toBe(28);
      expect(info.daysElapsed).toBe(14);
      expect(info.daysRemaining).toBe(14);
    });
  });

  describe('isWithinGracePeriod', () => {
    it('should return true within default 14-day grace period', () => {
      const lastPaymentDate = new Date('2024-01-01T00:00:00Z');

      // Day 10 of grace period
      clock.setTime(new Date('2024-01-11T00:00:00Z'));
      expect(isWithinGracePeriod(lastPaymentDate)).toBe(true);

      // Day 14 (last hour of grace)
      clock.setTime(new Date('2024-01-14T23:00:00Z'));
      expect(isWithinGracePeriod(lastPaymentDate)).toBe(true);
    });

    it('should return false after grace period', () => {
      const lastPaymentDate = new Date('2024-01-01T00:00:00Z');

      // Day 15 (grace expired)
      clock.setTime(new Date('2024-01-15T00:00:01Z'));
      expect(isWithinGracePeriod(lastPaymentDate)).toBe(false);
    });

    it('should handle custom grace period', () => {
      const lastPaymentDate = new Date('2024-01-01T00:00:00Z');

      // Day 7 with 7-day grace
      clock.setTime(new Date('2024-01-07T12:00:00Z'));
      expect(isWithinGracePeriod(lastPaymentDate, 7)).toBe(true);

      // Day 8 with 7-day grace
      clock.setTime(new Date('2024-01-08T00:00:01Z'));
      expect(isWithinGracePeriod(lastPaymentDate, 7)).toBe(false);
    });
  });

  describe('calculateProRatedAmount', () => {
    it('should return full amount on first day', () => {
      const customerCreatedAt = new Date('2024-01-15T00:00:00Z');
      clock.setTime(new Date('2024-01-15T00:00:01Z'));

      const prorated = calculateProRatedAmount(2800, customerCreatedAt); // $28.00
      expect(prorated).toBe(2800);
    });

    it('should return half amount at mid-period', () => {
      const customerCreatedAt = new Date('2024-01-01T00:00:00Z');
      clock.setTime(new Date('2024-01-15T00:00:00Z')); // Day 15, 14 days remaining

      const prorated = calculateProRatedAmount(2800, customerCreatedAt);
      expect(prorated).toBe(1400); // Half of $28.00
    });

    it('should return minimal amount on last day', () => {
      const customerCreatedAt = new Date('2024-01-01T00:00:00Z');
      clock.setTime(new Date('2024-01-28T00:00:00Z')); // Day 28, 1 day remaining

      const prorated = calculateProRatedAmount(2800, customerCreatedAt);
      expect(prorated).toBe(100); // 1/28 of $28.00
    });

    it('should handle rounding correctly', () => {
      const customerCreatedAt = new Date('2024-01-01T00:00:00Z');
      clock.setTime(new Date('2024-01-18T00:00:00Z')); // Day 18, 11 days remaining

      const prorated = calculateProRatedAmount(1000, customerCreatedAt); // $10.00
      expect(prorated).toBe(393); // Round(1000 * 11/28) = Round(392.857) = 393
    });
  });

  describe('getNextBillingPeriodStart', () => {
    it('should return end of current period', () => {
      const customerCreatedAt = new Date('2024-01-01T00:00:00Z');
      clock.setTime(new Date('2024-01-15T00:00:00Z'));

      const nextStart = getNextBillingPeriodStart(customerCreatedAt);
      expect(nextStart.toISOString()).toBe('2024-01-29T00:00:00.000Z');
    });
  });

  describe('isLastDayOfBillingPeriod', () => {
    it('should return false for most days', () => {
      const customerCreatedAt = new Date('2024-01-01T00:00:00Z');

      clock.setTime(new Date('2024-01-15T00:00:00Z'));
      expect(isLastDayOfBillingPeriod(customerCreatedAt)).toBe(false);

      clock.setTime(new Date('2024-01-27T00:00:00Z'));
      expect(isLastDayOfBillingPeriod(customerCreatedAt)).toBe(false);
    });

    it('should return true on day 28', () => {
      const customerCreatedAt = new Date('2024-01-01T00:00:00Z');
      clock.setTime(new Date('2024-01-28T12:00:00Z'));

      expect(isLastDayOfBillingPeriod(customerCreatedAt)).toBe(true);
    });
  });

  describe('hasNewPeriodStarted', () => {
    it('should return false within same period', () => {
      const customerCreatedAt = new Date('2024-01-01T00:00:00Z');
      const checkDate = new Date('2024-01-10T00:00:00Z');

      clock.setTime(new Date('2024-01-15T00:00:00Z'));
      expect(hasNewPeriodStarted(customerCreatedAt, checkDate)).toBe(false);
    });

    it('should return true when period has rolled over', () => {
      const customerCreatedAt = new Date('2024-01-01T00:00:00Z');
      const checkDate = new Date('2024-01-15T00:00:00Z');

      // Move to next period
      clock.setTime(new Date('2024-01-30T00:00:00Z'));
      expect(hasNewPeriodStarted(customerCreatedAt, checkDate)).toBe(true);
    });

    it('should handle multiple period transitions', () => {
      const customerCreatedAt = new Date('2024-01-01T00:00:00Z');
      const checkDate = new Date('2024-01-15T00:00:00Z');

      // Move to third period
      clock.setTime(new Date('2024-03-01T00:00:00Z'));
      expect(hasNewPeriodStarted(customerCreatedAt, checkDate)).toBe(true);
    });
  });

  describe('Complete Billing Cycle Simulation', () => {
    it('should simulate a complete billing cycle', () => {
      const customerCreatedAt = new Date('2024-01-01T00:00:00Z');
      const lastPayment = new Date('2024-01-01T00:00:00Z');
      const monthlyCharge = 10000; // $100.00

      // Day 1: Customer signs up
      clock.setTime(new Date('2024-01-01T00:00:00Z'));
      expect(getCurrentPeriodDaysUsed(customerCreatedAt)).toBe(0);
      expect(getCurrentPeriodDaysRemaining(customerCreatedAt)).toBe(28);
      expect(isWithinGracePeriod(lastPayment)).toBe(true);

      // Day 10: Mid-period check
      clock.advanceDays(9);
      expect(getCurrentPeriodDaysUsed(customerCreatedAt)).toBe(9);
      expect(getCurrentPeriodDaysRemaining(customerCreatedAt)).toBe(19);
      expect(isWithinGracePeriod(lastPayment)).toBe(true);

      // Pro-rated amount for remaining days
      const prorated = calculateProRatedAmount(monthlyCharge, customerCreatedAt);
      expect(prorated).toBe(6786); // Round(10000 * 19/28)

      // Day 15: Grace period expires
      clock.setTime(new Date('2024-01-15T00:00:00Z'));
      expect(isWithinGracePeriod(lastPayment)).toBe(false);

      // Day 28: Last day of period
      clock.setTime(new Date('2024-01-28T12:00:00Z'));
      expect(isLastDayOfBillingPeriod(customerCreatedAt)).toBe(true);
      expect(getCurrentPeriodDaysRemaining(customerCreatedAt)).toBe(1);

      // Day 29: New period starts
      clock.setTime(new Date('2024-01-29T00:00:01Z'));
      expect(hasNewPeriodStarted(customerCreatedAt, lastPayment)).toBe(true);
      expect(getCurrentPeriodDaysUsed(customerCreatedAt)).toBe(0);
      expect(getCurrentPeriodDaysRemaining(customerCreatedAt)).toBe(28);

      const newPeriodInfo = getBillingPeriodInfo(customerCreatedAt);
      expect(newPeriodInfo.start.toISOString()).toBe('2024-01-29T00:00:00.000Z');
      expect(newPeriodInfo.end.toISOString()).toBe('2024-02-26T00:00:00.000Z');
    });

    it('should handle year transitions correctly', () => {
      const customerCreatedAt = new Date('2023-12-15T00:00:00Z');

      // Set to January 2024 (second period)
      clock.setTime(new Date('2024-01-12T00:00:00Z'));

      const periodInfo = getBillingPeriodInfo(customerCreatedAt);
      expect(periodInfo.start.toISOString()).toBe('2024-01-12T00:00:00.000Z');
      expect(periodInfo.end.toISOString()).toBe('2024-02-09T00:00:00.000Z');
    });
  });
});