import { z } from 'zod';
import { customerStatusEnum } from '@suiftly/database/schema';
import { SPENDING_LIMIT } from '../constants';

/**
 * Customer validation schemas
 * Based on customers table in CUSTOMER_SERVICE_SCHEMA.md
 *
 * IMPORTANT: Enum schemas derive from database enum definitions.
 * See docs/ENUM_IMPLEMENTATION.md for the complete enum architecture.
 */

// Sui wallet address validation (0x + 64 hex chars)
export const walletAddressSchema = z.string()
  .regex(/^0x[a-fA-F0-9]{64}$/, 'Invalid Sui wallet address format');

// Customer status enum - derived from database
export const customerStatusSchema = z.enum(customerStatusEnum.enumValues);

// 28-day spending limit validation
export const spendingLimitSchema = z.number()
  .int()
  .min(SPENDING_LIMIT.MINIMUM_USD * 100, `Minimum spending limit is $${SPENDING_LIMIT.MINIMUM_USD}`)
  .nullable();

// Complete customer schema
export const customerSchema = z.object({
  customerId: z.number().int().positive(),
  walletAddress: walletAddressSchema,
  escrowContractId: z.string().regex(/^0x[a-fA-F0-9]{64}$/).nullable().optional(),
  status: customerStatusSchema,
  maxMonthlyUsdCents: spendingLimitSchema.nullable().optional(),
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
