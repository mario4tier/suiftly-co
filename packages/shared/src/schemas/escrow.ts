import { z } from 'zod';
import { TRANSACTION_TYPE, BILLING_STATUS, SPENDING_LIMIT, FIELD_LIMITS } from '../constants';

/**
 * Escrow and financial validation schemas
 * Based on escrow_transactions, ledger_entries, billing_records tables
 */

// Blockchain transaction digest (Sui)
export const txDigestSchema = z.string()
  .regex(/^[a-fA-F0-9]{64}$/, 'Invalid transaction digest');

// Escrow transaction schema
export const escrowTransactionSchema = z.object({
  txId: z.number().int().positive(),
  customerId: z.number().int().positive(),
  txDigest: txDigestSchema,
  txType: z.enum([
    TRANSACTION_TYPE.DEPOSIT,
    TRANSACTION_TYPE.WITHDRAW,
    TRANSACTION_TYPE.CHARGE,
    TRANSACTION_TYPE.CREDIT,
  ]),
  amount: z.string().regex(/^\d+(\.\d{1,8})?$/), // Decimal with up to 8 decimals
  assetType: z.string().optional().nullable(),
  timestamp: z.date().or(z.string().datetime()),
});

// Ledger entry schema (with SUI/USD conversion rates)
export const ledgerEntrySchema = z.object({
  id: z.string().uuid(),
  customerId: z.number().int().positive(),
  type: z.enum([
    TRANSACTION_TYPE.DEPOSIT,
    TRANSACTION_TYPE.WITHDRAW,
    TRANSACTION_TYPE.CHARGE,
    TRANSACTION_TYPE.CREDIT,
  ]),
  amountUsdCents: z.number().int(), // Can be negative for withdrawals
  amountSuiMist: z.number().int().positive().nullable().optional(), // NULL for charges/credits
  suiUsdRateCents: z.number().int().positive().nullable().optional(), // e.g., 245 = $2.45/SUI
  txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).nullable().optional(),
  description: z.string().max(500).nullable().optional(), // TEXT field, no constant needed
  invoiceId: z.string().max(FIELD_LIMITS.INVOICE_ID).nullable().optional(),
  createdAt: z.date().or(z.string().datetime()),
});

// Billing record schema
export const billingRecordSchema = z.object({
  id: z.string().uuid(),
  customerId: z.number().int().positive(),
  billingPeriodStart: z.date().or(z.string().datetime()),
  billingPeriodEnd: z.date().or(z.string().datetime()),
  amountUsdCents: z.number().int(), // Positive for charges, negative for credits
  type: z.enum(['charge', 'credit', 'refund']),
  status: z.enum([
    BILLING_STATUS.PENDING,
    BILLING_STATUS.PAID,
    BILLING_STATUS.FAILED,
  ]),
  txDigest: txDigestSchema.nullable().optional(),
  createdAt: z.date().or(z.string().datetime()),
});

// Deposit request (frontend → backend)
export const depositRequestSchema = z.object({
  amountSui: z.number().positive(), // SUI amount (will be converted to mist)
});

// Withdraw request (frontend → backend)
export const withdrawRequestSchema = z.object({
  amountUsd: z.number().positive().min(1), // USD amount (minimum $1)
});

// Update spending limit request (28-day period)
export const updateSpendingLimitSchema = z.object({
  limitUsdCents: z.number().int().min(SPENDING_LIMIT.MINIMUM_USD * 100).nullable(), // NULL = unlimited
});
