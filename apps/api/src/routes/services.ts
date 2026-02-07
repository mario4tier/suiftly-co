/**
 * Services tRPC router
 * Handles service subscription, configuration, and management
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../lib/trpc';
import { db, withCustomerLockForAPI } from '@suiftly/database';
import { customers, serviceInstances, systemControl, lmStatus, apiKeys, sealKeys, sealPackages } from '@suiftly/database/schema';
import { eq, and, sql, min, ne, isNull, count } from 'drizzle-orm';
import { SERVICE_TYPE, SERVICE_TIER, SERVICE_STATE, BALANCE_LIMITS } from '@suiftly/shared/constants';
import type { ValidationResult, ValidationError, ValidationWarning } from '@suiftly/shared/types';
import { testDelayManager } from '../lib/test-delays';
import { getTierPriceUsdCents } from '../lib/config-cache';
import { getSuiService } from '@suiftly/database/sui-mock';
import { storeApiKey } from '../lib/api-keys';
import {
  handleSubscriptionBilling,
  handleSubscriptionBillingLocked,
  handleTierUpgradeLocked,
  scheduleTierDowngradeLocked,
  cancelScheduledTierChangeLocked,
  scheduleCancellationLocked,
  undoCancellationLocked,
  canProvisionService,
  getTierChangeOptions,
} from '@suiftly/database/billing';
import { dbClock } from '@suiftly/shared/db-clock';
import { triggerVaultSync, markConfigChanged } from '../lib/gm-sync';

// Zod schemas for input validation
const serviceTypeSchema = z.enum([SERVICE_TYPE.SEAL, SERVICE_TYPE.GRPC, SERVICE_TYPE.GRAPHQL]);
const serviceTierSchema = z.enum([SERVICE_TIER.STARTER, SERVICE_TIER.PRO, SERVICE_TIER.ENTERPRISE]);

const subscribeInputSchema = z.object({
  serviceType: serviceTypeSchema,
  tier: serviceTierSchema,
  config: z.any().optional(),
});

/**
 * Shared validation logic
 * Checks balance, limits, and business rules
 */
async function validateSubscription(
  customerId: number,
  serviceType: string,
  tier: string
): Promise<ValidationResult> {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // 1. Check if service already exists
  const existing = await db.query.serviceInstances.findFirst({
    where: and(
      eq(serviceInstances.customerId, customerId),
      eq(serviceInstances.serviceType, serviceType as 'seal' | 'grpc' | 'graphql')
    ),
  });

  if (existing) {
    return {
      valid: false,
      errors: [{
        code: 'ALREADY_SUBSCRIBED',
        message: `Already subscribed to ${serviceType}`,
        field: 'serviceType',
      }],
    };
  }

  // 2. Get customer balance
  const customer = await db.query.customers.findFirst({
    where: eq(customers.customerId, customerId),
  });

  if (!customer) {
    return {
      valid: false,
      errors: [{
        code: 'CUSTOMER_NOT_FOUND',
        message: 'Customer not found',
      }],
    };
  }

  // 3. Get tier price (from in-memory cache - O(1) lookup, no database query)
  const priceUsdCents = getTierPriceUsdCents(tier);

  // 4. Get balance info for warnings only
  // NOTE: Balance/spending limit enforcement happens at charge time (service-first pattern)
  const currentBalance = customer.currentBalanceUsdCents ?? 0;
  const required = priceUsdCents;
  const currentPeriodCharged = customer.currentPeriodChargedUsdCents ?? 0;
  const spendingLimit = customer.spendingLimitUsdCents ?? 25000; // $250 default

  // 5. Add warnings for low balance or spending limit concerns
  if (currentBalance < required) {
    warnings.push({
      code: 'INSUFFICIENT_BALANCE_WARNING',
      message: `Balance may be insufficient. Need $${required / 100}, have $${currentBalance / 100}. Service will be created but may fail to charge.`,
      details: {
        required: required / 100,
        current: currentBalance / 100,
        shortfall: (required - currentBalance) / 100,
      },
    });
  }

  if (spendingLimit > 0 && currentPeriodCharged + required > spendingLimit) {
    warnings.push({
      code: 'SPENDING_LIMIT_WARNING',
      message: `May exceed spending limit of $${spendingLimit / 100}. Service will be created but may fail to charge.`,
      details: {
        limit: spendingLimit / 100,
        currentSpent: currentPeriodCharged / 100,
        additionalCharge: required / 100,
        total: (currentPeriodCharged + required) / 100,
      },
    });
  }

  // 6. Check remaining balance after charge
  const remainingBalance = currentBalance - required;
  const minimumBalanceUsdCents = BALANCE_LIMITS.MINIMUM_ACTIVE_SERVICES_USD * 100;

  if (remainingBalance < minimumBalanceUsdCents) {
    warnings.push({
      code: 'LOW_BALANCE_WARNING',
      message: `Balance after subscription will be $${remainingBalance / 100} (minimum recommended: $${minimumBalanceUsdCents / 100})`,
      details: {
        remainingBalance: remainingBalance / 100,
        minimumRecommended: minimumBalanceUsdCents / 100,
      },
    });
  }

  // All checks passed
  return {
    valid: true,
    warnings: warnings.length > 0 ? warnings : undefined,
    balance: {
      current: currentBalance / 100,
      required: required / 100,
      remaining: remainingBalance / 100,
    },
  };
}

/**
 * Services router
 */
export const servicesRouter = router({
  /**
   * Subscribe to a service
   *
   * Uses customer-level advisory lock for the entire operation to prevent
   * race conditions between API and Global Manager.
   *
   * Service-First pattern: Create service → Charge → Update pending flag
   * This ensures audit trail exists before any payment attempt.
   */
  subscribe: protectedProcedure
    .input(subscribeInputSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // Apply test delay if configured
      await testDelayManager.applyDelay('subscribe');

      // Get tier price upfront (from in-memory cache - O(1) lookup, no database query)
      const priceUsdCents = getTierPriceUsdCents(input.tier);
      const suiService = getSuiService();

      // Wrap entire operation in customer advisory lock
      // This prevents race conditions between concurrent API requests
      // and the Global Manager billing processor
      return await withCustomerLockForAPI(
        ctx.user.customerId,
        'subscribe',
        async (tx) => {
          // 1. Get customer (inside lock)
          const [customer] = await tx
          .select()
          .from(customers)
          .where(eq(customers.customerId, ctx.user!.customerId))
          .limit(1);

        if (!customer) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Customer not found',
          });
        }

        // 2. Check if service already exists (idempotency check)
        const existing = await tx.query.serviceInstances.findFirst({
          where: and(
            eq(serviceInstances.customerId, ctx.user!.customerId),
            eq(serviceInstances.serviceType, input.serviceType)
          ),
        });

        if (existing) {
          // Already subscribed - return existing instance (idempotent)
          // Note: API key was already created, won't be returned again
          return {
            ...existing,
            subPendingInvoiceId: existing.subPendingInvoiceId,
            apiKey: null as string | null,
            paymentPending: existing.subPendingInvoiceId !== null,
          };
        }

        // 3. Initialize config with defaults based on tier
        const defaultConfig = {
          tier: input.tier,
          burstEnabled: input.tier !== SERVICE_TIER.STARTER, // Enabled by default for Pro/Enterprise
          totalSealKeys: 1,
          packagesPerSealKey: 3,
          totalApiKeys: 2,
          purchasedSealKeys: 0,
          purchasedPackages: 0,
          purchasedApiKeys: 0,
          ipAllowlist: [],
        };

        // 4. Create service in DISABLED state (subPendingInvoiceId will be set after billing)
        // This creates an audit trail BEFORE attempting any payment
        const [newService] = await tx
          .insert(serviceInstances)
          .values({
            customerId: ctx.user!.customerId,
            serviceType: input.serviceType,
            tier: input.tier,
            state: SERVICE_STATE.DISABLED,
            config: input.config || defaultConfig,
            isUserEnabled: false,
            // subPendingInvoiceId will be set if payment fails
          })
          .returning();

        // 5. Generate initial API key immediately (part of service creation)
        // Only pass sealType for Seal services - other services use default metadata
        const { plainKey } = await storeApiKey({
          customerId: ctx.user!.customerId,
          serviceType: input.serviceType,
          // sealType is Seal-specific metadata (network + access mode)
          // Future gRPC/GraphQL services will have their own metadata encoding
          ...(input.serviceType === SERVICE_TYPE.SEAL && {
            sealType: { network: 'mainnet', access: 'open' },
          }),
          metadata: {
            generatedAt: 'subscription',
            instanceId: newService.instanceId,
          },
          tx, // Pass locked transaction
        });

        // 6. Process billing (using locked version - we already hold the lock)
        let billingResult;
        try {
          billingResult = await handleSubscriptionBillingLocked(
            tx,
            ctx.user!.customerId,
            input.serviceType,
            input.tier,
            priceUsdCents,
            suiService,
            dbClock
          );
        } catch (billingError) {
          // Unexpected error during billing - service created but payment failed
          console.error('[SUBSCRIBE] Unexpected billing error:', billingError);
          // Note: Invoice may not exist if billing failed early, so subPendingInvoiceId is null
          return {
            ...newService,
            subPendingInvoiceId: null,
            apiKey: plainKey,
            paymentPending: true,
            paymentError: 'UNEXPECTED_ERROR',
            paymentErrorMessage: billingError instanceof Error ? billingError.message : 'Unexpected error',
          };
        }

        if (!billingResult.paymentSuccessful) {
          // Payment failed - service exists but can't be enabled
          console.log('[SUBSCRIBE] Billing failed, returning service with pending payment:', billingResult.error);

          // Map errors to user-friendly messages
          let paymentErrorMessage: string;
          if (billingResult.error?.includes('Account does not exist') ||
              billingResult.error?.includes('Insufficient balance') ||
              billingResult.error?.includes('No escrow account')) {
            paymentErrorMessage = 'Subscription payment pending. Add funds via Billing';
          } else {
            paymentErrorMessage = billingResult.error || 'Payment failed';
          }

          // Store subPendingInvoiceId on the service for later reconciliation
          await tx
            .update(serviceInstances)
            .set({ subPendingInvoiceId: billingResult.subPendingInvoiceId })
            .where(eq(serviceInstances.instanceId, newService.instanceId));

          return {
            ...newService,
            subPendingInvoiceId: billingResult.subPendingInvoiceId,
            apiKey: plainKey,
            paymentPending: true,
            paymentError: billingResult.error?.includes('No escrow account')
              ? 'NO_ESCROW_ACCOUNT'
              : 'PAYMENT_FAILED',
            paymentErrorMessage,
          };
        }

        // 7. Payment succeeded - keep subPendingInvoiceId as NULL (same transaction)
        await tx
          .update(serviceInstances)
          .set({
            state: SERVICE_STATE.DISABLED, // Keep disabled - user must manually enable after config
            subPendingInvoiceId: null, // Explicitly clear (should already be NULL)
            isUserEnabled: false, // Service stays OFF - user enables when ready
          })
          .where(eq(serviceInstances.instanceId, newService.instanceId));

        // Note: Charges are recorded in billing_records (invoices), not ledger_entries
        // Ledger entries are only for deposits/withdrawals from escrow

        // 8. Return service with API key
        return {
          ...newService,
          subPendingInvoiceId: null,
          isUserEnabled: false, // Service OFF - user must manually enable
          apiKey: plainKey,
          paymentPending: false,
        };
      },
      { serviceType: input.serviceType, tier: input.tier }
    );
  }),

  /**
   * Get service by type for current user
   */
  getByType: protectedProcedure
    .input(z.object({
      serviceType: serviceTypeSchema,
    }))
    .query(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      const service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, ctx.user.customerId),
          eq(serviceInstances.serviceType, input.serviceType)
        ),
      });

      return service || null;
    }),

  /**
   * List all services for current user
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.user) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Not authenticated',
      });
    }

    const services = await db.query.serviceInstances.findMany({
      where: eq(serviceInstances.customerId, ctx.user.customerId),
    });

    return services;
  }),

  /**
   * Toggle service enabled/disabled state
   * Transitions between State 3 (Disabled) ↔ State 4 (Enabled)
   *
   * Uses customer-level advisory lock to prevent race conditions.
   */
  toggleService: protectedProcedure
    .input(z.object({
      serviceType: serviceTypeSchema,
      enabled: z.boolean(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Apply test delay if configured
      const { testDelayManager } = await import('../lib/test-delays.js');
      await testDelayManager.applyDelay('sealFormMutation');

      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // Wrap entire operation in customer advisory lock
      const result = await withCustomerLockForAPI(
        ctx.user.customerId,
        'toggleService',
        async (tx) => {
          const service = await tx.query.serviceInstances.findFirst({
            where: and(
              eq(serviceInstances.customerId, ctx.user!.customerId),
              eq(serviceInstances.serviceType, input.serviceType)
            ),
          });

          if (!service) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Service not found',
            });
          }

          // Check if subscription charge is pending when trying to enable
          // Only validate funds when payment is still pending (not yet paid)
          if (service.subPendingInvoiceId !== null && input.enabled) {
            // Get customer to check account status
            const customer = await tx.query.customers.findFirst({
              where: eq(customers.customerId, ctx.user!.customerId),
            });

            if (!customer) {
              throw new TRPCError({
                code: 'NOT_FOUND',
                message: 'Customer not found',
              });
            }

            // Check escrow account balance
            const suiService = getSuiService();
            const account = await suiService.getAccount(customer.walletAddress);
            const tierPrice = getTierPriceUsdCents(service.tier);

            console.log('[TOGGLE] Validating funds for pending charge - Account:', account ? {
              balance: account.balanceUsdCents,
              tierPrice,
              hasAccount: !!account
            } : 'null');

            // If no account exists or insufficient balance, guide to deposit
            if (!account || account.balanceUsdCents < tierPrice) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: 'Insufficient funds. Deposit to proceed via Billing page.',
              });
            }

            // Account exists with funds but charge still pending - something else went wrong
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Cannot enable service: subscription payment pending. Please contact support if this persists.',
            });
          }

          // Only allow toggling if service is in disabled or enabled state
          if (service.state !== SERVICE_STATE.DISABLED && service.state !== SERVICE_STATE.ENABLED) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `Cannot toggle service in state: ${service.state}`,
            });
          }

          const now = dbClock.now();

          // Read nextVaultSeq - the seq to use for pending changes
          // GM bumps this to currentSeq+2 when processing, preventing collisions
          const [control] = await tx
            .select({ smaNextVaultSeq: systemControl.smaNextVaultSeq })
            .from(systemControl)
            .where(eq(systemControl.id, 1))
            .limit(1);
          const expectedVaultSeq = control?.smaNextVaultSeq ?? 1;

          // Atomically update global max configChangeSeq (for GM's O(1) pending check)
          await tx
            .update(systemControl)
            .set({
              smaMaxConfigChangeSeq: sql`GREATEST(${systemControl.smaMaxConfigChangeSeq}, ${expectedVaultSeq})`,
            })
            .where(eq(systemControl.id, 1));

          // For Seal service: check if cpEnabled should be set
          // cpEnabled becomes true when: isUserEnabled=true AND has seal key with package
          let shouldSetCpEnabled = false;
          if (input.enabled && input.serviceType === SERVICE_TYPE.SEAL && !service.cpEnabled) {
            // Check if there's any seal key with at least one package
            const keysWithPackages = await tx
              .select({ sealKeyId: sealKeys.sealKeyId })
              .from(sealKeys)
              .innerJoin(sealPackages, eq(sealPackages.sealKeyId, sealKeys.sealKeyId))
              .where(eq(sealKeys.instanceId, service.instanceId))
              .limit(1);

            shouldSetCpEnabled = keysWithPackages.length > 0;
          }

          const [updatedService] = await tx
            .update(serviceInstances)
            .set({
              isUserEnabled: input.enabled,
              state: input.enabled ? SERVICE_STATE.ENABLED : SERVICE_STATE.DISABLED,
              enabledAt: input.enabled ? now : service.enabledAt,
              disabledAt: !input.enabled ? now : service.disabledAt,
              smaConfigChangeVaultSeq: expectedVaultSeq,
              ...(shouldSetCpEnabled ? { cpEnabled: true } : {}),
            })
            .where(eq(serviceInstances.instanceId, service.instanceId))
            .returning();

          return updatedService;
        },
        { serviceType: input.serviceType, enabled: input.enabled }
      );

      // Trigger vault regeneration (fire-and-forget, outside transaction)
      // This ensures HAProxy gets updated with the new isUserEnabled state
      void triggerVaultSync();

      return result;
    }),

  /**
   * Update service configuration (burst, IP allowlist)
   *
   * Uses customer-level advisory lock to prevent race conditions.
   */
  updateConfig: protectedProcedure
    .input(z.object({
      serviceType: serviceTypeSchema,
      burstEnabled: z.boolean().optional(),
      ipAllowlist: z.array(z.string()).max(4).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // Wrap entire operation in customer advisory lock
      const result = await withCustomerLockForAPI(
        ctx.user.customerId,
        'updateConfig',
        async (tx) => {
          const service = await tx.query.serviceInstances.findFirst({
            where: and(
              eq(serviceInstances.customerId, ctx.user!.customerId),
              eq(serviceInstances.serviceType, input.serviceType)
            ),
          });

          if (!service) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Service not found',
            });
          }

          // Get current config or create new one
          const currentConfig = service.config as any || {
            tier: service.tier,
            burstEnabled: false,
            totalSealKeys: 1,
            packagesPerSealKey: 3,
            totalApiKeys: 2,
            purchasedSealKeys: 0,
            purchasedPackages: 0,
            purchasedApiKeys: 0,
          };

          // Update only the fields that were provided
          const updatedConfig = {
            ...currentConfig,
            ...(input.burstEnabled !== undefined && { burstEnabled: input.burstEnabled }),
            ...(input.ipAllowlist !== undefined && { ipAllowlist: input.ipAllowlist }),
          };

          // Validate burst is only for Pro/Enterprise
          if (updatedConfig.burstEnabled && service.tier === SERVICE_TIER.STARTER) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Burst is only available for Pro and Enterprise tiers',
            });
          }

          // Validate IP allowlist is only for Pro/Enterprise
          if (updatedConfig.ipAllowlist?.length > 0 && service.tier === SERVICE_TIER.STARTER) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'IP allowlist is only available for Pro and Enterprise tiers',
            });
          }

          // Mark config change for vault sync
          const expectedVaultSeq = await markConfigChanged(tx, input.serviceType, 'mainnet');

          const [updated] = await tx
            .update(serviceInstances)
            .set({
              config: updatedConfig,
              smaConfigChangeVaultSeq: expectedVaultSeq,
            })
            .where(eq(serviceInstances.instanceId, service.instanceId))
            .returning();

          return updated;
        },
        { serviceType: input.serviceType }
      );

      // Trigger vault regeneration (fire-and-forget)
      void triggerVaultSync();

      return result;
    }),

  // ==========================================================================
  // Phase 1C: Tier Changes and Cancellation
  // ==========================================================================

  /**
   * Get tier change options for a service
   * Returns available tiers with pricing and effective dates
   */
  getTierOptions: protectedProcedure
    .input(z.object({
      serviceType: serviceTypeSchema,
    }))
    .query(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      const options = await getTierChangeOptions(
        db,
        ctx.user.customerId,
        input.serviceType as 'seal' | 'grpc' | 'graphql',
        dbClock
      );

      if (!options) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Service not found',
        });
      }

      return options;
    }),

  /**
   * Upgrade tier (immediate effect with pro-rated charge)
   * Per BILLING_DESIGN.md R13.1
   */
  upgradeTier: protectedProcedure
    .input(z.object({
      serviceType: serviceTypeSchema,
      newTier: serviceTierSchema,
    }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // Apply test delay if configured
      await testDelayManager.applyDelay('tierChange');

      const suiService = getSuiService();

      // Acquire customer lock at route level for consistency
      const result = await withCustomerLockForAPI(
        ctx.user.customerId,
        'upgradeTier',
        async (tx) => {
          return await handleTierUpgradeLocked(
            tx,
            ctx.user!.customerId,
            input.serviceType as 'seal' | 'grpc' | 'graphql',
            input.newTier as 'starter' | 'pro' | 'enterprise',
            suiService,
            dbClock
          );
        },
        { serviceType: input.serviceType, newTier: input.newTier }
      );

      if (!result.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: result.error || 'Upgrade failed',
        });
      }

      return {
        success: true,
        newTier: result.newTier,
        chargeAmountUsdCents: result.chargeAmountUsdCents,
        invoiceId: result.invoiceId,
      };
    }),

  /**
   * Schedule tier downgrade (takes effect at start of next billing period)
   * Per BILLING_DESIGN.md R13.2
   */
  scheduleTierDowngrade: protectedProcedure
    .input(z.object({
      serviceType: serviceTypeSchema,
      newTier: serviceTierSchema,
    }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // Apply test delay if configured
      await testDelayManager.applyDelay('tierChange');

      const result = await withCustomerLockForAPI(
        ctx.user.customerId,
        'scheduleTierDowngrade',
        async (tx) => {
          return await scheduleTierDowngradeLocked(
            tx,
            ctx.user!.customerId,
            input.serviceType as 'seal' | 'grpc' | 'graphql',
            input.newTier as 'starter' | 'pro' | 'enterprise',
            dbClock
          );
        },
        { serviceType: input.serviceType, newTier: input.newTier }
      );

      if (!result.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: result.error || 'Downgrade scheduling failed',
        });
      }

      return {
        success: true,
        scheduledTier: result.scheduledTier,
        effectiveDate: result.effectiveDate,
      };
    }),

  /**
   * Cancel a scheduled tier change
   */
  cancelScheduledTierChange: protectedProcedure
    .input(z.object({
      serviceType: serviceTypeSchema,
    }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      const result = await withCustomerLockForAPI(
        ctx.user.customerId,
        'cancelScheduledTierChange',
        async (tx) => {
          return await cancelScheduledTierChangeLocked(
            tx,
            ctx.user!.customerId,
            input.serviceType as 'seal' | 'grpc' | 'graphql',
            dbClock
          );
        },
        { serviceType: input.serviceType }
      );

      if (!result.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: result.error || 'Failed to cancel tier change',
        });
      }

      return { success: true };
    }),

  /**
   * Schedule subscription cancellation (takes effect at end of billing period)
   * Per BILLING_DESIGN.md R13.3
   */
  scheduleCancellation: protectedProcedure
    .input(z.object({
      serviceType: serviceTypeSchema,
    }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // Apply test delay if configured
      await testDelayManager.applyDelay('cancellation');

      const result = await withCustomerLockForAPI(
        ctx.user.customerId,
        'scheduleCancellation',
        async (tx) => {
          return await scheduleCancellationLocked(
            tx,
            ctx.user!.customerId,
            input.serviceType as 'seal' | 'grpc' | 'graphql',
            dbClock
          );
        },
        { serviceType: input.serviceType }
      );

      if (!result.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: result.error || 'Cancellation scheduling failed',
        });
      }

      return {
        success: true,
        effectiveDate: result.effectiveDate,
      };
    }),

  /**
   * Undo a scheduled cancellation
   * Per BILLING_DESIGN.md R13.4
   */
  undoCancellation: protectedProcedure
    .input(z.object({
      serviceType: serviceTypeSchema,
    }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      const result = await withCustomerLockForAPI(
        ctx.user.customerId,
        'undoCancellation',
        async (tx) => {
          return await undoCancellationLocked(
            tx,
            ctx.user!.customerId,
            input.serviceType as 'seal' | 'grpc' | 'graphql',
            dbClock
          );
        },
        { serviceType: input.serviceType }
      );

      if (!result.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: result.error || 'Failed to undo cancellation',
        });
      }

      return { success: true };
    }),

  /**
   * Check if service can be provisioned (anti-abuse check)
   * Per BILLING_DESIGN.md R13.6
   */
  canProvision: protectedProcedure
    .input(z.object({
      serviceType: serviceTypeSchema,
    }))
    .query(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      const result = await canProvisionService(
        db,
        ctx.user.customerId,
        input.serviceType as 'seal' | 'grpc' | 'graphql',
        dbClock
      );

      return result;
    }),

  /**
   * Get status for all services (unified query for dashboard and service pages)
   *
   * Returns operational status and sync status for all customer services.
   * Status logic is computed entirely in backend - frontend displays as-is.
   *
   * Operational Status priority (first match wins):
   * 1. state === 'suspended_*' || 'cancellation_pending' → 'down'
   * 2. isUserEnabled === false → 'disabled'
   * 3. !hasActiveApiKey || (seal && !hasSealKeys) → 'config_needed'
   * 4. Otherwise → 'up'
   */
  getServicesStatus: protectedProcedure
    .query(async ({ ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      const customerId = ctx.user.customerId;

      // 1. Get all services for customer
      const services = await db.query.serviceInstances.findMany({
        where: eq(serviceInstances.customerId, customerId),
      });

      if (services.length === 0) {
        return { services: [], lmStatus: { lmCount: 0, minAppliedSeq: null } };
      }

      // 2. Get active API key counts per service type
      const apiKeyCounts = await db
        .select({
          serviceType: apiKeys.serviceType,
          count: count(),
        })
        .from(apiKeys)
        .where(and(
          eq(apiKeys.customerId, customerId),
          eq(apiKeys.isUserEnabled, true),
          isNull(apiKeys.revokedAt),
          isNull(apiKeys.deletedAt)
        ))
        .groupBy(apiKeys.serviceType);

      const apiKeyCountMap = new Map(
        apiKeyCounts.map(r => [r.serviceType, Number(r.count)])
      );

      // 3. Get active seal key count (for seal service)
      const sealKeyCountResult = await db
        .select({ count: count() })
        .from(sealKeys)
        .where(and(
          eq(sealKeys.customerId, customerId),
          eq(sealKeys.isUserEnabled, true)
        ));
      const sealKeyCount = Number(sealKeyCountResult[0]?.count ?? 0);

      // 4. Get LM status for sync calculation
      // Get min applied seq per vault type from reachable LMs
      const lmStatuses = await db
        .select({
          lmId: lmStatus.lmId,
          vaultType: lmStatus.vaultType,
          appliedSeq: lmStatus.appliedSeq,
          lastSeenAt: lmStatus.lastSeenAt,
          lastError: lmStatus.lastError,
        })
        .from(lmStatus);

      // LM must have been seen within last 30 seconds to be considered reachable
      const freshnessThreshold = new Date(Date.now() - 30000);

      // Group by vault type and calculate min applied seq
      const vaultSeqMap = new Map<string, number>();
      for (const lm of lmStatuses) {
        // Only consider recently reachable LMs with applied vaults
        const isRecent = lm.lastSeenAt && lm.lastSeenAt > freshnessThreshold;
        if (isRecent && !lm.lastError && lm.appliedSeq && lm.appliedSeq > 0 && lm.vaultType) {
          const currentMin = vaultSeqMap.get(lm.vaultType);
          if (currentMin === undefined || lm.appliedSeq < currentMin) {
            vaultSeqMap.set(lm.vaultType, lm.appliedSeq);
          }
        }
      }

      // SMA vault determines customer API endpoint availability (HAProxy config)
      // SMK/STK vaults are internal (keyserver config) and don't affect customer-facing status
      const minAppliedSeq = vaultSeqMap.get('sma') ?? null;
      // Count unique reachable LMs (multiple rows per LM since composite PK lmId+vaultType)
      const reachableLmIds = new Set<string>();
      for (const lm of lmStatuses) {
        const isRecent = lm.lastSeenAt && lm.lastSeenAt > freshnessThreshold;
        if (isRecent && !lm.lastError) {
          reachableLmIds.add(lm.lmId);
        }
      }
      const lmCount = reachableLmIds.size;

      // 5. Calculate status for each service
      const serviceStatuses = services.map(service => {
        const serviceType = service.serviceType;
        const state = service.state;
        const isUserEnabled = service.isUserEnabled ?? false;
        const configChangeSeq = service.smaConfigChangeVaultSeq ?? 0;

        // Active API keys for this service
        const hasActiveApiKey = (apiKeyCountMap.get(serviceType) ?? 0) > 0;

        // For seal, also need seal keys
        const hasSealKeys = serviceType === 'seal' ? sealKeyCount > 0 : true;

        // Determine operational status (priority order)
        let operationalStatus: 'disabled' | 'config_needed' | 'up' | 'down';
        let configNeededReason: string | undefined;

        if (state === 'suspended_maintenance' || state === 'suspended_no_payment' || state === 'cancellation_pending') {
          operationalStatus = 'down';
        } else if (!isUserEnabled) {
          operationalStatus = 'disabled';
        } else if (!hasActiveApiKey) {
          operationalStatus = 'config_needed';
          configNeededReason = 'No active API key';
        } else if (!hasSealKeys) {
          operationalStatus = 'config_needed';
          configNeededReason = 'No seal keys configured';
        } else {
          operationalStatus = 'up';
        }

        // Determine sync status (sequence-based)
        // Service is synced when configChangeSeq <= minAppliedSeq across all relevant vaults
        let syncStatus: 'synced' | 'pending' = 'synced';
        let syncReason: string | undefined;

        if (configChangeSeq > 0) {
          if (lmCount === 0) {
            syncStatus = 'pending';
            syncReason = 'no_lms_available';
          } else if (minAppliedSeq === null) {
            syncStatus = 'pending';
            syncReason = 'no_vaults_applied';
          } else if (configChangeSeq > minAppliedSeq) {
            syncStatus = 'pending';
            syncReason = 'vault_seq_behind';
          }
        }

        return {
          serviceType,
          operationalStatus,
          syncStatus,
          configChangeVaultSeq: configChangeSeq,
          ...(configNeededReason ? { configNeededReason } : {}),
          ...(syncReason ? { syncReason } : {}),
        };
      });

      return {
        services: serviceStatuses,
        lmStatus: {
          lmCount,
          minAppliedSeq,
        },
      };
    }),
});
