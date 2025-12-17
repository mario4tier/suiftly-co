/**
 * Billing tRPC router
 * Handles balance queries, transaction history, and billing information
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../lib/trpc';
import { getSuiService } from '@suiftly/database/sui-mock';
import { db, logActivity } from '@suiftly/database';
import { ledgerEntries, customers, billingRecords, customerCredits, invoiceLineItems } from '@suiftly/database/schema';
import { eq, and, desc, sql, gt } from 'drizzle-orm';
import { SPENDING_LIMIT, INVOICE_LINE_ITEM_TYPE } from '@suiftly/shared/constants';
import { config } from '../lib/config';
import { dbClock } from '@suiftly/shared/db-clock';
import { buildDraftLineItems } from '../lib/invoice-formatter';

/**
 * Format a semantic line item into a human-readable description
 * Used for billing history display
 *
 * @param itemType - The semantic item type (e.g., TIER_UPGRADE, SUBSCRIPTION_PRO)
 * @param serviceType - The service type (e.g., 'seal')
 * @param quantity - Item quantity
 * @param unitPriceUsdCents - Unit price in cents
 * @param creditMonth - Credit month for CREDIT items
 * @param description - Optional description to append (e.g., "starter → pro" for tier upgrades)
 */
function formatLineItemDescription(
  itemType: string,
  serviceType: string | null,
  quantity: number,
  unitPriceUsdCents: number,
  creditMonth: string | null,
  description: string | null
): string {
  const serviceName = serviceType
    ? serviceType.charAt(0).toUpperCase() + serviceType.slice(1)
    : '';

  const unitPriceUsd = unitPriceUsdCents / 100;

  switch (itemType) {
    case INVOICE_LINE_ITEM_TYPE.SUBSCRIPTION_STARTER:
      return `${serviceName} Starter tier subscription`;
    case INVOICE_LINE_ITEM_TYPE.SUBSCRIPTION_PRO:
      return `${serviceName} Pro tier subscription`;
    case INVOICE_LINE_ITEM_TYPE.SUBSCRIPTION_ENTERPRISE:
      return `${serviceName} Enterprise tier subscription`;
    case INVOICE_LINE_ITEM_TYPE.TIER_UPGRADE: {
      const base = `${serviceName} tier upgrade (pro-rated)`;
      return description ? `${base}: ${description}` : base;
    }
    case INVOICE_LINE_ITEM_TYPE.REQUESTS:
      return `${serviceName} usage: ${quantity.toLocaleString()} requests`;
    case INVOICE_LINE_ITEM_TYPE.EXTRA_API_KEYS:
      return `${serviceName} extra API keys: ${quantity}`;
    case INVOICE_LINE_ITEM_TYPE.EXTRA_SEAL_KEYS:
      return `${serviceName} extra seal keys: ${quantity}`;
    case INVOICE_LINE_ITEM_TYPE.EXTRA_ALLOWLIST_IPS:
      return `${serviceName} extra allowlist IPs: ${quantity}`;
    case INVOICE_LINE_ITEM_TYPE.EXTRA_PACKAGES:
      return `${serviceName} extra packages: ${quantity}`;
    case INVOICE_LINE_ITEM_TYPE.CREDIT:
      return creditMonth
        ? `${serviceName ? serviceName + ' ' : ''}partial month credit (${creditMonth})`
        : `${serviceName ? serviceName + ' ' : ''}credit`;
    case INVOICE_LINE_ITEM_TYPE.TAX:
      return 'Tax';
    default:
      // Log unexpected itemType - indicates new enum value or bad data
      console.error(`[billing] Unhandled itemType in formatLineItemDescription: ${JSON.stringify(itemType)}`);
      return 'Charge';
  }
}

/**
 * Convert hex string to Buffer for BYTEA fields
 * Handles both 0x-prefixed and non-prefixed hex strings
 */
function hexToBuffer(hex: string): Buffer {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  return Buffer.from(cleanHex, 'hex');
}

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

    // First, check if we have an escrow address stored in the database
    const customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, ctx.user.walletAddress),
    });

    const suiService = getSuiService();
    const account = await suiService.getAccount(ctx.user.walletAddress);

    if (!account) {
      // No escrow account yet - return zeros but with default spending limit
      // Also return escrowContractId from DB if we have it (for client to use)
      return {
        found: false,
        balanceUsd: 0,
        spendingLimitUsd: SPENDING_LIMIT.DEFAULT_USD, // $250 default
        currentPeriodChargedUsd: 0,
        currentPeriodRemainingUsd: SPENDING_LIMIT.DEFAULT_USD, // Full default limit available
        periodEndsAt: null,
        message: 'No escrow account created yet',
        escrowContractId: customer?.escrowContractId || null, // Return DB value if available
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
      balanceUsd: account.balanceUsdCents / 100,
      spendingLimitUsd:
        account.spendingLimitUsdCents === 0
          ? null // Unlimited
          : account.spendingLimitUsdCents / 100,
      currentPeriodChargedUsd: account.currentPeriodChargedUsdCents / 100,
      currentPeriodRemainingUsd: remaining,
      periodEndsAt,
      accountAddress: account.accountAddress,
      escrowContractId: customer?.escrowContractId || account.accountAddress, // Prefer DB value, fallback to on-chain
    };
  }),

  /**
   * Get recent transaction history
   * Returns combined ledger entries (deposits/withdrawals) and invoices (charges/refunds)
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

      // Get ledger entries (deposits/withdrawals only - charges are in billing_records)
      const ledgerResults = await db.query.ledgerEntries.findMany({
        where: and(
          eq(ledgerEntries.customerId, customer.customerId),
          sql`${ledgerEntries.type} IN ('deposit', 'withdraw')`
        ),
        orderBy: [desc(ledgerEntries.createdAt)],
      });

      // Get billing records with their line items (invoices - charges/refunds)
      // Exclude from history:
      // - draft: Not yet charged (next month's projection)
      // - failed: Payment attempts that didn't succeed (will be retried or voided)
      // - voided: Cancelled operations (e.g., failed immediate charges like upgrades)
      //
      // Only show: 'pending' (awaiting payment) and 'paid' (completed)
      // Users only care about what they owe and what they've paid.
      const invoiceResults = await db
        .select({
          id: billingRecords.id,
          type: billingRecords.type,
          status: billingRecords.status,
          amountUsdCents: billingRecords.amountUsdCents,
          txDigest: billingRecords.txDigest,
          createdAt: billingRecords.createdAt,
          invoiceNumber: billingRecords.invoiceNumber,
          // Get semantic line item fields
          itemType: invoiceLineItems.itemType,
          serviceType: invoiceLineItems.serviceType,
          quantity: invoiceLineItems.quantity,
          unitPriceUsdCents: invoiceLineItems.unitPriceUsdCents,
          creditMonth: invoiceLineItems.creditMonth,
          lineItemDescription: invoiceLineItems.description, // Optional description to append
        })
        .from(billingRecords)
        .leftJoin(invoiceLineItems, eq(billingRecords.id, invoiceLineItems.billingRecordId))
        .where(and(
          eq(billingRecords.customerId, customer.customerId),
          sql`${billingRecords.status} IN ('pending', 'paid')`
        ))
        .orderBy(desc(billingRecords.createdAt));

      // Group line items by invoice (in case of multiple line items)
      const invoiceMap = new Map<number, {
        id: number;
        type: string;
        status: string;
        amountUsdCents: number;
        txDigest: Buffer | null;
        createdAt: Date;
        invoiceNumber: string;
        lineItemDescriptions: string[];
      }>();

      for (const row of invoiceResults) {
        // Format line item into description if present
        const lineItemDescription = row.itemType
          ? formatLineItemDescription(
              row.itemType,
              row.serviceType,
              Number(row.quantity ?? 1),
              Number(row.unitPriceUsdCents ?? 0),
              row.creditMonth,
              row.lineItemDescription ?? null
            )
          : null;

        const existing = invoiceMap.get(row.id);
        if (existing) {
          if (lineItemDescription) {
            existing.lineItemDescriptions.push(lineItemDescription);
          }
        } else {
          invoiceMap.set(row.id, {
            id: row.id,
            type: row.type,
            status: row.status,
            amountUsdCents: Number(row.amountUsdCents),
            txDigest: row.txDigest,
            createdAt: row.createdAt,
            invoiceNumber: row.invoiceNumber,
            lineItemDescriptions: lineItemDescription ? [lineItemDescription] : [],
          });
        }
      }

      // Combine and format both sources
      const allTransactions: Array<{
        id: string;
        type: string;
        amountUsd: number;
        description: string | null;
        txDigest: string | null;
        createdAt: string;
        invoiceNumber?: string;
        status?: string;
        source: 'ledger' | 'invoice';
      }> = [];

      // Add ledger entries (deposits/withdrawals)
      for (const entry of ledgerResults) {
        allTransactions.push({
          id: entry.id,
          type: entry.type,
          amountUsd: Number(entry.amountUsdCents) / 100,
          description: entry.description,
          txDigest: entry.txDigest ? `0x${entry.txDigest.toString('hex')}` : null,
          createdAt: entry.createdAt.toISOString(),
          source: 'ledger',
        });
      }

      // Add billing records (invoices - charges/credits)
      for (const invoice of invoiceMap.values()) {
        // Build description from line items
        let invoiceDescription: string;
        if (invoice.lineItemDescriptions.length === 0) {
          invoiceDescription = invoice.type === 'charge' ? 'Charge' : 'Credit';
        } else if (invoice.lineItemDescriptions.length === 1) {
          invoiceDescription = invoice.lineItemDescriptions[0];
        } else {
          // Multiple line items: show first + count
          invoiceDescription = `${invoice.lineItemDescriptions[0]} +${invoice.lineItemDescriptions.length - 1} more`;
        }

        allTransactions.push({
          id: String(invoice.id), // Convert number ID to string for API response
          type: invoice.type, // 'charge' or 'credit'
          amountUsd: invoice.amountUsdCents / 100,
          description: invoiceDescription,
          txDigest: invoice.txDigest ? `0x${invoice.txDigest.toString('hex')}` : null,
          createdAt: invoice.createdAt.toISOString(),
          invoiceNumber: invoice.invoiceNumber,
          status: invoice.status,
          source: 'invoice',
        });
      }

      // Sort by createdAt descending
      allTransactions.sort((a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      // Apply pagination
      const total = allTransactions.length;
      const paginatedTransactions = allTransactions.slice(offset, offset + limit);

      return {
        transactions: paginatedTransactions,
        total,
        hasMore: offset + paginatedTransactions.length < total,
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
      balanceUsd: account.balanceUsdCents / 100,
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

      // Check if we have an escrow address stored in the database
      let customer = await db.query.customers.findFirst({
        where: eq(customers.walletAddress, ctx.user.walletAddress),
      });

      // Convert USD to cents
      const amountCents = Math.round(input.amountUsd * 100);
      const spendingLimitCents = input.initialSpendingLimitUsd !== undefined
        ? Math.round(input.initialSpendingLimitUsd * 100)
        : undefined;

      // Execute deposit on blockchain/mock
      // Pass escrowAddress if we have it in DB, otherwise let it create new account
      const result = await suiService.deposit({
        userAddress: ctx.user.walletAddress,
        amountUsdCents: amountCents,
        initialSpendingLimitUsdCents: spendingLimitCents,
        escrowAddress: customer?.escrowContractId || undefined,
      });

      if (!result.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: result.error || 'Deposit failed',
        });
      }

      // If account was created, update the database with the escrow address
      if (result.accountCreated && result.createdObjects) {
        if (!customer) {
          // Create new customer record with escrow address
          const newCustomer = await db
            .insert(customers)
            .values({
              customerId: Math.floor(Math.random() * 1000000000),
              walletAddress: ctx.user.walletAddress,
              escrowContractId: result.createdObjects.escrowAddress,
            })
            .returning();
          customer = newCustomer[0];
        } else if (!customer.escrowContractId) {
          // Update existing customer with escrow address
          await db
            .update(customers)
            .set({
              escrowContractId: result.createdObjects.escrowAddress,
              updatedAt: dbClock.now(),
            })
            .where(eq(customers.customerId, customer.customerId));
        }
      }

      // Get customer ID for ledger entry (re-fetch if needed)
      if (!customer) {
        customer = await db.query.customers.findFirst({
          where: eq(customers.walletAddress, ctx.user.walletAddress),
        });
      }

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
        txDigest: hexToBuffer(result.digest),
        description: `Deposited $${input.amountUsd.toFixed(2)} to escrow account`,
      });

      // Log activity
      await logActivity({
        customerId: customer.customerId,
        clientIp: ctx.req.ip || ctx.req.socket.remoteAddress || '127.0.0.1',
        message: `Deposited $${input.amountUsd.toFixed(2)} to escrow account`,
      });

      // Sync with Global Manager to reconcile pending subscription charges
      // This waits for completion so the response reflects the updated state
      // (better UX - user sees subscription activated immediately after deposit)
      const gmUrl = config.GM_URL || 'http://localhost:22600';
      try {
        await fetch(`${gmUrl}/api/queue/sync-customer/${customer.customerId}?source=api`, {
          method: 'POST',
        });
      } catch (err: any) {
        // Log but don't fail - the deposit itself succeeded
        console.error(`[DEPOSIT] Failed to sync with GM:`, err.message);
      }

      // Get new balance
      const account = await suiService.getAccount(ctx.user.walletAddress);

      return {
        success: true,
        newBalanceUsd: account ? account.balanceUsdCents / 100 : 0,
        accountCreated: result.accountCreated || false,
        txDigest: result.digest,
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

      // Check if we have an escrow address stored in the database
      let customer = await db.query.customers.findFirst({
        where: eq(customers.walletAddress, ctx.user.walletAddress),
      });

      // Convert USD to cents
      const amountCents = Math.round(input.amountUsd * 100);

      // Execute withdrawal on blockchain/mock
      // Pass escrowAddress if we have it in DB, otherwise let it create new account
      const result = await suiService.withdraw({
        userAddress: ctx.user.walletAddress,
        amountUsdCents: amountCents,
        escrowAddress: customer?.escrowContractId || undefined,
      });

      if (!result.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: result.error || 'Withdrawal failed',
        });
      }

      // If account was created, update the database with the escrow address
      if (result.accountCreated && result.createdObjects) {
        if (!customer) {
          // Create new customer record with escrow address
          const newCustomer = await db
            .insert(customers)
            .values({
              customerId: Math.floor(Math.random() * 1000000000),
              walletAddress: ctx.user.walletAddress,
              escrowContractId: result.createdObjects.escrowAddress,
            })
            .returning();
          customer = newCustomer[0];
        } else if (!customer.escrowContractId) {
          // Update existing customer with escrow address
          await db
            .update(customers)
            .set({
              escrowContractId: result.createdObjects.escrowAddress,
              updatedAt: dbClock.now(),
            })
            .where(eq(customers.customerId, customer.customerId));
        }
      }

      // Get customer ID for ledger entry (re-fetch if needed)
      if (!customer) {
        customer = await db.query.customers.findFirst({
          where: eq(customers.walletAddress, ctx.user.walletAddress),
        });
      }

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
        txDigest: hexToBuffer(result.digest),
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
        newBalanceUsd: account ? account.balanceUsdCents / 100 : 0,
        txDigest: result.digest,
      };
    }),

  /**
   * Report escrow account address
   * Called by client after creating an escrow account on-chain
   * This updates our database with the escrow address for future operations
   */
  reportEscrowAddress: protectedProcedure
    .input(
      z.object({
        escrowAddress: z.string()
          .regex(/^0x[0-9a-fA-F]{64}$/, 'Invalid Sui address format (must be 0x + 64 hex chars)'),
        userTrackingAddress: z.string()
          .regex(/^0x[0-9a-fA-F]{64}$/, 'Invalid Sui address format')
          .optional(),
        suiftlyTrackingAddress: z.string()
          .regex(/^0x[0-9a-fA-F]{64}$/, 'Invalid Sui address format')
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // Validate escrow address is not empty or invalid
      if (!input.escrowAddress || input.escrowAddress === '0x0000000000000000000000000000000000000000000000000000000000000000') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Invalid escrow address: cannot be empty or zero address',
        });
      }

      // Find or create the customer record
      let customer = await db.query.customers.findFirst({
        where: eq(customers.walletAddress, ctx.user.walletAddress),
      });

      if (!customer) {
        // Create customer record if doesn't exist
        const result = await db
          .insert(customers)
          .values({
            customerId: Math.floor(Math.random() * 1000000000), // Generate random ID
            walletAddress: ctx.user.walletAddress,
            escrowContractId: input.escrowAddress,
          })
          .returning();
        customer = result[0];
      } else if (!customer.escrowContractId) {
        // Update existing customer with escrow address
        await db
          .update(customers)
          .set({
            escrowContractId: input.escrowAddress,
            updatedAt: dbClock.now(),
          })
          .where(eq(customers.customerId, customer.customerId));
      } else if (customer.escrowContractId !== input.escrowAddress) {
        // Customer already has a different escrow address - this is an error
        throw new TRPCError({
          code: 'CONFLICT',
          message: `Customer already has escrow address ${customer.escrowContractId}`,
        });
      }

      // Log the activity
      await logActivity({
        customerId: customer.customerId,
        clientIp: ctx.req.ip || ctx.req.socket.remoteAddress || '127.0.0.1',
        message: `Reported escrow account address: ${input.escrowAddress}`,
      });

      // Sync the account state from blockchain
      const suiService = getSuiService();
      const account = await suiService.syncAccount(ctx.user.walletAddress);

      return {
        success: true,
        escrowAddress: input.escrowAddress,
        synced: !!account,
        accountState: account ? {
          balanceUsd: account.balanceUsdCents / 100,
          spendingLimitUsd: account.spendingLimitUsdCents === 0 ? null : account.spendingLimitUsdCents / 100,
          currentPeriodChargedUsd: account.currentPeriodChargedUsdCents / 100,
        } : null,
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

      // Check if we have an escrow address stored in the database
      let customer = await db.query.customers.findFirst({
        where: eq(customers.walletAddress, ctx.user.walletAddress),
      });

      // Convert USD to cents (0 = unlimited)
      const limitCents = Math.round(input.newLimitUsd * 100);

      // Execute update on blockchain/mock
      // Pass escrowAddress if we have it in DB, otherwise let it create new account
      const result = await suiService.updateSpendingLimit({
        userAddress: ctx.user.walletAddress,
        newLimitUsdCents: limitCents,
        escrowAddress: customer?.escrowContractId || undefined,
      });

      if (!result.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: result.error || 'Update spending limit failed',
        });
      }

      // If account was created, update the database with the escrow address
      if (result.accountCreated && result.createdObjects) {
        if (!customer) {
          // Create new customer record with escrow address
          const newCustomer = await db
            .insert(customers)
            .values({
              customerId: Math.floor(Math.random() * 1000000000),
              walletAddress: ctx.user.walletAddress,
              escrowContractId: result.createdObjects.escrowAddress,
            })
            .returning();
          customer = newCustomer[0];
        } else if (!customer.escrowContractId) {
          // Update existing customer with escrow address
          await db
            .update(customers)
            .set({
              escrowContractId: result.createdObjects.escrowAddress,
              updatedAt: dbClock.now(),
            })
            .where(eq(customers.customerId, customer.customerId));
        }
      }

      // Get customer ID for activity log (re-fetch if needed)
      if (!customer) {
        customer = await db.query.customers.findFirst({
          where: eq(customers.walletAddress, ctx.user.walletAddress),
        });
      }

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
        txDigest: result.digest,
      };
    }),

  /**
   * Get next scheduled payment (DRAFT invoice)
   * Returns upcoming charges for the next billing cycle
   */
  getNextScheduledPayment: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.user) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Not authenticated',
      });
    }

    // Get customer
    const customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, ctx.user.walletAddress),
    });

    if (!customer) {
      return {
        found: false,
        totalUsd: 0,
        subscriptionChargesUsd: 0,
        usageChargesUsd: 0,
        dueDate: null,
      };
    }

    // Query for DRAFT invoice
    const draft = await db.query.billingRecords.findFirst({
      where: and(
        eq(billingRecords.customerId, customer.customerId),
        eq(billingRecords.status, 'draft')
      ),
    });

    if (!draft) {
      return {
        found: false,
        totalUsd: 0,
        subscriptionChargesUsd: 0,
        usageChargesUsd: 0,
        dueDate: null,
      };
    }

    // Build line items using shared formatter (reusable for historical invoices too)
    const lineItems = await buildDraftLineItems(
      customer.customerId,
      Number(draft.amountUsdCents),
      draft.billingPeriodStart || undefined,
      draft.id
    );

    // Calculate total (sum of all line items)
    const totalUsd = lineItems.reduce((sum, item) => sum + item.amountUsd, 0);

    // Per TIME_DESIGN.md: All timestamps are UTC
    // WORKAROUND: Database plain timestamp is interpreted as local time by node-postgres
    // Extract date components and re-create as UTC to get correct ISO string
    const dueDate = draft.billingPeriodStart
      ? new Date(Date.UTC(
          draft.billingPeriodStart.getUTCFullYear(),
          draft.billingPeriodStart.getUTCMonth(),
          draft.billingPeriodStart.getUTCDate(),
          0, 0, 0, 0
        )).toISOString()
      : null;

    // Convert lastUpdatedAt to ISO string if present
    const lastUpdatedAt = draft.lastUpdatedAt
      ? new Date(Date.UTC(
          draft.lastUpdatedAt.getUTCFullYear(),
          draft.lastUpdatedAt.getUTCMonth(),
          draft.lastUpdatedAt.getUTCDate(),
          draft.lastUpdatedAt.getUTCHours(),
          draft.lastUpdatedAt.getUTCMinutes(),
          draft.lastUpdatedAt.getUTCSeconds()
        )).toISOString()
      : null;

    return {
      found: true,
      lineItems,
      totalUsd,
      dueDate,
      invoiceNumber: draft.invoiceNumber,
      lastUpdatedAt,
    };
  }),
});
