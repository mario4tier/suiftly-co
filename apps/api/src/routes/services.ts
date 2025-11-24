/**
 * Services tRPC router
 * Handles service subscription, configuration, and management
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../lib/trpc';
import { db } from '@suiftly/database';
import { customers, serviceInstances, ledgerEntries } from '@suiftly/database/schema';
import { eq, and, sql } from 'drizzle-orm';
import { SERVICE_TYPE, SERVICE_TIER, SERVICE_STATE, BALANCE_LIMITS } from '@suiftly/shared/constants';
import type { ValidationResult, ValidationError, ValidationWarning } from '@suiftly/shared/types';
import { testDelayManager } from '../lib/test-delays';
import { getTierPriceUsdCents } from '../lib/config-cache';
import { getSuiService } from '../services/sui/index.js';
import { storeApiKey } from '../lib/api-keys';
import { handleSubscriptionBilling } from '@suiftly/database/billing';
import { dbClock } from '@suiftly/shared/db-clock';

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
  const currentPeriodCharged = customer.currentMonthChargedUsdCents ?? 0;
  const spendingLimit = customer.maxMonthlyUsdCents ?? 25000; // $250 default

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
   * Service-First pattern: Create service → Charge → Update pending flag
   * This ensures audit trail exists before any payment attempt
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

      // 1. Validate subscription
      const validation = await validateSubscription(
        ctx.user!.customerId,
        input.serviceType,
        input.tier
      );

      if (!validation.valid) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: validation.errors![0].message,
          cause: validation.errors,
        });
      }

      // 2. Get tier price (from in-memory cache - O(1) lookup, no database query)
      const priceUsdCents = getTierPriceUsdCents(input.tier);

      // 3. Create service FIRST in transaction (with subscription_charge_pending=true)
      const { service, apiKey } = await db.transaction(async (tx) => {
        // Lock customer row and get data
        const [customer] = await tx
          .select()
          .from(customers)
          .where(eq(customers.customerId, ctx.user!.customerId))
          .for('update')
          .limit(1);

        if (!customer) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Customer not found',
          });
        }

        // Check if service already exists (idempotency check)
        const existing = await tx.query.serviceInstances.findFirst({
          where: and(
            eq(serviceInstances.customerId, ctx.user!.customerId),
            eq(serviceInstances.serviceType, input.serviceType)
          ),
        });

        if (existing) {
          // Already subscribed - return existing instance (idempotent)
          // Note: API key was already created, won't be returned again
          return { service: existing, apiKey: null };
        }

        // Initialize config with defaults based on tier
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

        // Create service in DISABLED state with subscription_charge_pending=true
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
            subscriptionChargePending: true, // Payment not confirmed yet
          })
          .returning();

        // Generate initial API key immediately (part of service creation)
        const { plainKey, record: apiKeyRecord } = await storeApiKey({
          customerId: ctx.user!.customerId,
          serviceType: input.serviceType,
          metadata: {
            generatedAt: 'subscription',
            instanceId: newService.instanceId,
          },
          tx, // Pass transaction object to avoid deadlock
        });

        return { service: newService, apiKey: plainKey };
      });

      // 4. Transaction committed - service exists in database now
      // This ensures we always have an audit trail before charging

      // 5. Get customer for charge (non-transaction read)
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, ctx.user!.customerId),
      });

      if (!customer) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Customer not found',
        });
      }

      // 6. Use billing engine to handle subscription payment
      //    This creates:
      //    - Immediate invoice for first month (full charge)
      //    - DRAFT invoice for next billing cycle
      //    - Reconciliation credit for partial month
      const suiService = getSuiService();

      try {
        const billingResult = await handleSubscriptionBilling(
          db,
          ctx.user!.customerId,
          input.serviceType,
          input.tier,
          priceUsdCents,
          suiService,
          dbClock
        );

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

          return {
            ...service,
            subscriptionChargePending: true,
            apiKey: apiKey,
            paymentPending: true,
            paymentError: billingResult.error?.includes('No escrow account')
              ? 'NO_ESCROW_ACCOUNT'
              : 'PAYMENT_FAILED',
            paymentErrorMessage,
          };
        }

        // 7. Payment succeeded - update service state and enable it
        await db
          .update(serviceInstances)
          .set({
            state: SERVICE_STATE.ENABLED, // Set state to enabled (was disabled during creation)
            subscriptionChargePending: false,
            isUserEnabled: true, // Auto-enable service after successful payment
          })
          .where(eq(serviceInstances.instanceId, service.instanceId));

        // Note: DRAFT invoice already calculated correctly by handleSubscriptionBilling()
        // It includes all subscribed services regardless of enable/disable toggle state

        // 8. Record charge in ledger
        await db.insert(ledgerEntries).values({
          customerId: ctx.user!.customerId,
          type: 'charge',
          amountUsdCents: priceUsdCents,
          description: `${input.serviceType} ${input.tier} tier subscription`,
          createdAt: new Date(),
        });

        // 9. Return service with API key
        return {
          ...service,
          subscriptionChargePending: false,
          isUserEnabled: true,
          apiKey: apiKey,
          paymentPending: false,
        };

      } catch (billingError) {
        // Unexpected error during billing
        console.error('[SUBSCRIBE] Unexpected billing error:', billingError);

        return {
          ...service,
          subscriptionChargePending: true,
          apiKey: apiKey,
          paymentPending: true,
          paymentError: 'UNEXPECTED_ERROR',
          paymentErrorMessage: billingError instanceof Error ? billingError.message : 'Unexpected error',
        };
      }
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

      const service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, ctx.user.customerId),
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
      if (service.subscriptionChargePending && input.enabled) {
        // Get customer to check account status
        const customer = await db.query.customers.findFirst({
          where: eq(customers.customerId, ctx.user.customerId),
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

      const [updatedService] = await db
        .update(serviceInstances)
        .set({
          isUserEnabled: input.enabled,
          state: input.enabled ? SERVICE_STATE.ENABLED : SERVICE_STATE.DISABLED,
          enabledAt: input.enabled ? new Date() : service.enabledAt,
          disabledAt: !input.enabled ? new Date() : service.disabledAt,
        })
        .where(eq(serviceInstances.instanceId, service.instanceId))
        .returning();

      return updatedService;
    }),

  /**
   * Update service configuration (burst, IP allowlist)
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

      const service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, ctx.user.customerId),
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

      const [updated] = await db
        .update(serviceInstances)
        .set({
          config: updatedConfig,
        })
        .where(eq(serviceInstances.instanceId, service.instanceId))
        .returning();

      return updated;
    }),
});
