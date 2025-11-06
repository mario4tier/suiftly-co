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

// Zod schemas for input validation
const serviceTypeSchema = z.enum([SERVICE_TYPE.SEAL, SERVICE_TYPE.GRPC, SERVICE_TYPE.GRAPHQL]);
const serviceTierSchema = z.enum([SERVICE_TIER.STARTER, SERVICE_TIER.PRO, SERVICE_TIER.ENTERPRISE]);

const subscribeInputSchema = z.object({
  serviceType: serviceTypeSchema,
  tier: serviceTierSchema,
  config: z.any().optional(),
});

/**
 * Get tier pricing configuration
 * TODO: Move to database config table when implemented
 */
function getTierPriceUsdCents(tier: string): number {
  switch (tier) {
    case SERVICE_TIER.STARTER:
      return 2000; // $20.00
    case SERVICE_TIER.PRO:
      return 4000; // $40.00
    case SERVICE_TIER.ENTERPRISE:
      return 8000; // $80.00
    default:
      throw new Error(`Invalid tier: ${tier}`);
  }
}

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
      eq(serviceInstances.serviceType, serviceType)
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

  // 3. Get tier price
  const priceUsdCents = getTierPriceUsdCents(tier);

  // 4. Check balance
  const currentBalance = customer.currentBalanceUsdCents ?? 0;
  const required = priceUsdCents;

  if (currentBalance < required) {
    return {
      valid: false,
      errors: [{
        code: 'INSUFFICIENT_BALANCE',
        message: `Insufficient balance. Need $${required / 100}, have $${currentBalance / 100}`,
        details: {
          required: required / 100,
          current: currentBalance / 100,
          shortfall: (required - currentBalance) / 100,
        },
      }],
    };
  }

  // 5. Check 28-day spending limit
  const currentPeriodCharged = customer.currentMonthChargedUsdCents ?? 0;
  const spendingLimit = customer.maxMonthlyUsdCents ?? 25000; // $250 default

  if (currentPeriodCharged + required > spendingLimit) {
    return {
      valid: false,
      errors: [{
        code: 'SPENDING_LIMIT_EXCEEDED',
        message: `Would exceed spending limit of $${spendingLimit / 100}`,
        details: {
          limit: spendingLimit / 100,
          currentSpent: currentPeriodCharged / 100,
          additionalCharge: required / 100,
          total: (currentPeriodCharged + required) / 100,
        },
      }],
    };
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
   * Validate subscription before execution
   * Fast, read-only check for immediate user feedback
   */
  validateSubscription: protectedProcedure
    .input(subscribeInputSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // Apply test delay if configured
      await testDelayManager.applyDelay('validateSubscription');

      return await validateSubscription(
        ctx.user.customerId,
        input.serviceType,
        input.tier
      );
    }),

  /**
   * Subscribe to a service
   * Atomic transaction: validate + create service + charge balance
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

      // Execute in transaction
      return await db.transaction(async (tx) => {
        // 1. Lock customer row and get data
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

        // 2. Re-validate with locked data (race condition protection)
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

        // 3. Check if service already exists (idempotency check)
        const existing = await tx.query.serviceInstances.findFirst({
          where: and(
            eq(serviceInstances.customerId, ctx.user!.customerId),
            eq(serviceInstances.serviceType, input.serviceType)
          ),
        });

        if (existing) {
          // Already subscribed - return existing instance (idempotent)
          return existing;
        }

        // 4. Get tier price
        const priceUsdCents = getTierPriceUsdCents(input.tier);

        // 5. Create service in PROVISIONING state
        // Note: This state is transient. We immediately transition to DISABLED after payment.
        // The PROVISIONING state is reserved for future async payment flows (on-chain, etc.)

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

        const [service] = await tx
          .insert(serviceInstances)
          .values({
            customerId: ctx.user!.customerId,
            serviceType: input.serviceType,
            tier: input.tier,
            state: SERVICE_STATE.PROVISIONING,
            config: input.config || defaultConfig,
            isEnabled: false, // Start disabled
          })
          .returning();

        // 6. Deduct balance
        await tx
          .update(customers)
          .set({
            currentBalanceUsdCents: sql`${customers.currentBalanceUsdCents} - ${priceUsdCents}`,
            currentMonthChargedUsdCents: sql`${customers.currentMonthChargedUsdCents} + ${priceUsdCents}`,
            updatedAt: new Date(),
          })
          .where(eq(customers.customerId, ctx.user!.customerId));

        // 7. Record charge in ledger
        await tx.insert(ledgerEntries).values({
          customerId: ctx.user!.customerId,
          type: 'charge',
          amountUsdCents: BigInt(priceUsdCents),
          description: `${input.serviceType} ${input.tier} tier subscription`,
          createdAt: new Date(),
        });

        // 8. Immediately transition to DISABLED state (payment complete)
        const [updatedService] = await tx
          .update(serviceInstances)
          .set({
            state: SERVICE_STATE.DISABLED,
          })
          .where(eq(serviceInstances.instanceId, service.instanceId))
          .returning();

        return updatedService;
      });
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
          isEnabled: input.enabled,
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
