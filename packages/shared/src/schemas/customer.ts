import { z } from 'zod';
import { CUSTOMER_STATUS, MONTHLY_LIMIT } from '../constants';

/**
 * Customer validation schemas
 * Based on customers table in CUSTOMER_SERVICE_SCHEMA.md
 */

// Sui wallet address validation (0x + 64 hex chars)
export const walletAddressSchema = z.string()
  .regex(/^0x[a-fA-F0-9]{64}$/, 'Invalid Sui wallet address format');

// Customer status enum
export const customerStatusSchema = z.enum([
  CUSTOMER_STATUS.ACTIVE,
  CUSTOMER_STATUS.SUSPENDED,
  CUSTOMER_STATUS.CLOSED,
]);

// Monthly spending limit validation
export const monthlyLimitSchema = z.number()
  .int()
  .min(MONTHLY_LIMIT.MINIMUM_USD * 100, `Minimum monthly limit is $${MONTHLY_LIMIT.MINIMUM_USD}`)
  .nullable();

// Complete customer schema
export const customerSchema = z.object({
  customerId: z.number().int().positive(),
  walletAddress: walletAddressSchema,
  escrowContractId: z.string().regex(/^0x[a-fA-F0-9]{64}$/).nullable().optional(),
  status: customerStatusSchema,
  maxMonthlyUsdCents: monthlyLimitSchema.nullable().optional(),
  currentBalanceUsdCents: z.number().int().nonnegative().nullable().optional(),
  currentMonthChargedUsdCents: z.number().int().nonnegative().nullable().optional(),
  lastMonthChargedUsdCents: z.number().int().nonnegative().nullable().optional(),
  currentMonthStart: z.string().date().nullable().optional(),
  createdAt: z.date().or(z.string().datetime()),
  updatedAt: z.date().or(z.string().datetime()),
});

// Insert schema (for creating new customers)
export const customerInsertSchema = customerSchema.omit({
  createdAt: true,
  updatedAt: true,
});

// Update schema (for updating existing customers)
export const customerUpdateSchema = customerSchema.partial().required({
  customerId: true,
});

// Public profile schema (what frontend sees)
export const customerPublicSchema = customerSchema.pick({
  customerId: true,
  walletAddress: true,
  status: true,
  currentBalanceUsdCents: true,
  maxMonthlyUsdCents: true,
  currentMonthChargedUsdCents: true,
  lastMonthChargedUsdCents: true,
});
