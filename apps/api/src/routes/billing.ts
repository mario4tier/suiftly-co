/**
 * Billing tRPC router
 * Handles balance queries, transaction history, and billing information
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../lib/trpc';
import { getSuiService } from '../services/sui';
import { db, logActivity } from '@suiftly/database';
import { ledgerEntries, customers } from '@suiftly/database/schema';
import { eq, desc } from 'drizzle-orm';
import { SPENDING_LIMIT } from '@suiftly/shared/constants';

export const billingRouter = router({
  /**
   * Get current balance and spending info
   * Queries blockchain/mock state as source of truth
   */
  getBalance: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.user) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Not authenticated',
      });
    }

    const suiService = getSuiService();
    const account = await suiService.getAccount(ctx.user.walletAddress);

    if (!account) {
      // No escrow account yet - return zeros
      return {
        found: false,
        balanceUsd: 0,
        spendingLimitUsd: 0,
        currentPeriodChargedUsd: 0,
        currentPeriodRemainingUsd: 0,
        periodEndsAt: null,
        message: 'No escrow account created yet',
      };
    }

    // Calculate period end time
    const periodEndsAt = new Date(
      account.currentPeriodStartMs + 28 * 24 * 60 * 60 * 1000
    ).toISOString();

    // Calculate remaining in period
    const remaining = account.spendingLimitUsdCents === 0
      ? null // Unlimited
      : Math.max(
          0,
          (account.spendingLimitUsdCents - account.currentPeriodChargedUsdCents) / 100
        );

    return {
      found: true,
      balanceUsd: account.balanceUsdcCents / 100,
      spendingLimitUsd:
        account.spendingLimitUsdCents === 0
          ? null // Unlimited
          : account.spendingLimitUsdCents / 100,
      currentPeriodChargedUsd: account.currentPeriodChargedUsdCents / 100,
      currentPeriodRemainingUsd: remaining,
      periodEndsAt,
      accountAddress: account.accountAddress,
    };
  }),

  /**
   * Get recent transaction history
   * Returns ledger entries for the current user
   */
  getTransactions: protectedProcedure
    .input(
      z
        .object({
          limit: z.number().min(1).max(100).optional().default(20),
          offset: z.number().min(0).optional().default(0),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      const limit = input?.limit ?? 20;
      const offset = input?.offset ?? 0;

      // Get customer to find customer_id
      const customer = await db.query.customers.findFirst({
        where: eq(customers.walletAddress, ctx.user.walletAddress),
      });

      if (!customer) {
        return {
          transactions: [],
          total: 0,
        };
      }

      // Get ledger entries
      const entries = await db.query.ledgerEntries.findMany({
        where: eq(ledgerEntries.customerId, customer.customerId),
        orderBy: [desc(ledgerEntries.createdAt)],
        limit,
        offset,
      });

      // Count total
      const totalResult = await db
        .select({ count: ledgerEntries.customerId })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.customerId, customer.customerId));

      return {
        transactions: entries.map((entry) => ({
          id: entry.id,
          type: entry.type,
          amountUsd: Number(entry.amountUsdCents) / 100,
          description: entry.description,
          txHash: entry.txHash,
          createdAt: entry.createdAt.toISOString(),
        })),
        total: totalResult.length,
        hasMore: offset + entries.length < totalResult.length,
      };
    }),

  /**
   * Sync account balance from blockchain
   * Forces refresh of local cache from blockchain state
   */
  syncBalance: protectedProcedure.mutation(async ({ ctx }) => {
    if (!ctx.user) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Not authenticated',
      });
    }

    const suiService = getSuiService();
    const account = await suiService.syncAccount(ctx.user.walletAddress);

    if (!account) {
      return {
        synced: false,
        message: 'No account found to sync',
      };
    }

    return {
      synced: true,
      balanceUsd: account.balanceUsdcCents / 100,
      message: 'Balance synced from blockchain',
    };
  }),

  /**
   * Deposit funds to escrow account
   * Auto-creates account if it doesn't exist
   */
  deposit: protectedProcedure
    .input(
      z.object({
        amountUsd: z.number().min(0.01).max(1000000),
        initialSpendingLimitUsd: z.number().min(0).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      const suiService = getSuiService();

      // Convert USD to cents
      const amountCents = Math.round(input.amountUsd * 100);
      const spendingLimitCents = input.initialSpendingLimitUsd !== undefined
        ? Math.round(input.initialSpendingLimitUsd * 100)
        : undefined;

      // Execute deposit on blockchain/mock
      const result = await suiService.deposit({
        userAddress: ctx.user.walletAddress,
        amountUsdcCents: amountCents,
        initialSpendingLimitUsdCents: spendingLimitCents,
      });

      if (!result.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: result.error || 'Deposit failed',
        });
      }

      // Get customer ID for ledger entry
      const customer = await db.query.customers.findFirst({
        where: eq(customers.walletAddress, ctx.user.walletAddress),
      });

      if (!customer) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Customer not found after deposit',
        });
      }

      // Create ledger entry
      await db.insert(ledgerEntries).values({
        customerId: customer.customerId,
        type: 'deposit',
        amountUsdCents: amountCents,
        txHash: result.digest,
        description: `Deposited $${input.amountUsd.toFixed(2)} to escrow account`,
      });

      // Log activity
      await logActivity({
        customerId: customer.customerId,
        clientIp: ctx.req.ip || ctx.req.socket.remoteAddress || '127.0.0.1',
        message: `Deposited $${input.amountUsd.toFixed(2)} to escrow account`,
      });

      // Get new balance
      const account = await suiService.getAccount(ctx.user.walletAddress);

      return {
        success: true,
        newBalanceUsd: account ? account.balanceUsdcCents / 100 : 0,
        accountCreated: result.accountCreated || false,
        txHash: result.digest,
      };
    }),

  /**
   * Withdraw funds from escrow account
   */
  withdraw: protectedProcedure
    .input(
      z.object({
        amountUsd: z.number().min(0.01).max(1000000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      const suiService = getSuiService();

      // Convert USD to cents
      const amountCents = Math.round(input.amountUsd * 100);

      // Execute withdrawal on blockchain/mock
      const result = await suiService.withdraw({
        userAddress: ctx.user.walletAddress,
        amountUsdcCents: amountCents,
      });

      if (!result.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: result.error || 'Withdrawal failed',
        });
      }

      // Get customer ID for ledger entry
      const customer = await db.query.customers.findFirst({
        where: eq(customers.walletAddress, ctx.user.walletAddress),
      });

      if (!customer) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Customer not found after withdrawal',
        });
      }

      // Create ledger entry
      await db.insert(ledgerEntries).values({
        customerId: customer.customerId,
        type: 'withdraw',
        amountUsdCents: amountCents,
        txHash: result.digest,
        description: `Withdrew $${input.amountUsd.toFixed(2)} from escrow account`,
      });

      // Log activity
      await logActivity({
        customerId: customer.customerId,
        clientIp: ctx.req.ip || ctx.req.socket.remoteAddress || '127.0.0.1',
        message: `Withdrew $${input.amountUsd.toFixed(2)} from escrow account`,
      });

      // Get new balance
      const account = await suiService.getAccount(ctx.user.walletAddress);

      return {
        success: true,
        newBalanceUsd: account ? account.balanceUsdcCents / 100 : 0,
        txHash: result.digest,
      };
    }),

  /**
   * Update spending limit
   */
  updateSpendingLimit: protectedProcedure
    .input(
      z.object({
        newLimitUsd: z.number().min(0),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // Validate spending limit
      if (input.newLimitUsd > 0 && input.newLimitUsd < SPENDING_LIMIT.MINIMUM_USD) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Spending limit must be at least $${SPENDING_LIMIT.MINIMUM_USD} or 0 (unlimited)`,
        });
      }

      const suiService = getSuiService();

      // Convert USD to cents (0 = unlimited)
      const limitCents = Math.round(input.newLimitUsd * 100);

      // Execute update on blockchain/mock
      const result = await suiService.updateSpendingLimit({
        userAddress: ctx.user.walletAddress,
        newLimitUsdCents: limitCents,
      });

      if (!result.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: result.error || 'Update spending limit failed',
        });
      }

      // Get customer ID for activity log
      const customer = await db.query.customers.findFirst({
        where: eq(customers.walletAddress, ctx.user.walletAddress),
      });

      if (!customer) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Customer not found after update',
        });
      }

      // Log activity
      const limitText = input.newLimitUsd === 0 ? 'unlimited' : `$${input.newLimitUsd.toFixed(2)}`;
      await logActivity({
        customerId: customer.customerId,
        clientIp: ctx.req.ip || ctx.req.socket.remoteAddress || '127.0.0.1',
        message: `Updated 28-day spending limit to ${limitText}`,
      });

      return {
        success: true,
        newLimit: input.newLimitUsd === 0 ? null : input.newLimitUsd,
        accountCreated: result.accountCreated || false,
        txHash: result.digest,
      };
    }),
});
