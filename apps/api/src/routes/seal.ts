/**
 * Seal Keys & Packages tRPC router
 * Handles seal key and package management for Seal service
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../lib/trpc';
import { db, withCustomerLockForAPI } from '@suiftly/database';
import { sealKeys, sealPackages, sealRegistrationOps, serviceInstances, apiKeys, configGlobal, customers, systemControl, adminNotifications } from '@suiftly/database/schema';
import { eq, and, sql, isNull } from 'drizzle-orm';
import { SERVICE_TYPE, SEAL_LIMITS } from '@suiftly/shared/constants';
import { storeApiKey, getApiKeys, revokeApiKey, deleteApiKey, reEnableApiKey, type SealType } from '../lib/api-keys';
import { parseIpAddressList, ipAllowlistUpdateSchema } from '@suiftly/shared/schemas';
import { decryptSecret } from '../lib/encryption';
import { generateSealKey } from '../lib/seal-key-generation';
import { dbClock } from '@suiftly/shared/db-clock';
import { triggerVaultSync, markConfigChanged } from '../lib/gm-sync';
import { retryPendingInvoice } from '../lib/payment-gates';
import { getSealProcessGroup, isProduction } from '@mhaxbe/system-config';

export const sealRouter = router({
  /**
   * List all seal keys for current user's Seal service
   */
  listKeys: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.user) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Not authenticated',
      });
    }

    // Get service instance first
    const service = await db.query.serviceInstances.findFirst({
      where: and(
        eq(serviceInstances.customerId, ctx.user.customerId),
        eq(serviceInstances.serviceType, SERVICE_TYPE.SEAL)
      ),
    });

    if (!service) {
      return [];
    }

    // Get all seal keys with their packages (excluding soft-deleted)
    const keys = await db.query.sealKeys.findMany({
      where: and(
        eq(sealKeys.instanceId, service.instanceId),
        isNull(sealKeys.deletedAt) // Exclude soft-deleted keys
      ),
      with: {
        packages: true,
      },
    });

    // Format keys for UI display
    return keys.map(key => {
      // Format public key for display (truncated hex)
      const publicKeyHex = key.publicKey.toString('hex');
      const keyPreview = `0x${publicKeyHex.slice(0, 6)}...${publicKeyHex.slice(-4)}`;

      // Format object ID if present
      const objectId = key.objectId
        ? `0x${key.objectId.toString('hex')}`
        : undefined;

      const objectIdPreview = objectId
        ? `${objectId.slice(0, 8)}...${objectId.slice(-6)}`
        : undefined;

      return {
        id: key.sealKeyId.toString(),
        sealKeyId: key.sealKeyId,
        name: key.name,
        keyPreview,
        publicKeyHex, // Full hex for export
        objectId,
        objectIdPreview,
        isUserEnabled: key.isUserEnabled,
        createdAt: key.createdAt,
        // Registration status fields for UI
        registrationStatus: key.registrationStatus,
        registrationError: key.registrationError,
        registrationAttempts: key.registrationAttempts,
        nextRetryAt: key.nextRetryAt,
        packages: key.packages.map(pkg => ({
          id: pkg.packageId.toString(),
          packageId: pkg.packageId,
          name: pkg.name,
          packageAddress: `0x${pkg.packageAddress.toString('hex')}`,
          packageAddressPreview: `0x${pkg.packageAddress.toString('hex').slice(0, 6)}...${pkg.packageAddress.toString('hex').slice(-4)}`,
          isUserEnabled: pkg.isUserEnabled,
          createdAt: pkg.createdAt,
        })),
      };
    });
  }),

  /**
   * Get registration status for all seal keys
   *
   * Returns registration status, error info, and retry timing for UI polling.
   * Used to show "Registering...", "Updating...", or "Registered" status badges.
   */
  getRegistrationStatus: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.user) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Not authenticated',
      });
    }

    // Get all seal keys for this customer with registration status fields
    const keys = await db.query.sealKeys.findMany({
      where: and(
        eq(sealKeys.customerId, ctx.user.customerId),
        isNull(sealKeys.deletedAt) // Exclude soft-deleted keys
      ),
      columns: {
        sealKeyId: true,
        registrationStatus: true,
        registrationError: true,
        registrationAttempts: true,
        nextRetryAt: true,
        objectId: true,
        packagesVersion: true,
        registeredPackagesVersion: true,
      },
    });

    return keys.map(key => ({
      sealKeyId: key.sealKeyId,
      status: key.registrationStatus,
      error: key.registrationError,
      attempts: key.registrationAttempts,
      nextRetryAt: key.nextRetryAt,
      objectId: key.objectId ? `0x${key.objectId.toString('hex')}` : null,
      // UI can use these to show if an update is pending
      packagesVersion: key.packagesVersion,
      registeredPackagesVersion: key.registeredPackagesVersion,
    }));
  }),

  /**
   * List packages for a specific seal key
   */
  listPackages: protectedProcedure
    .input(z.object({
      sealKeyId: z.number().int(),
    }))
    .query(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // Verify the seal key belongs to the user
      const key = await db.query.sealKeys.findFirst({
        where: and(
          eq(sealKeys.sealKeyId, input.sealKeyId),
          eq(sealKeys.customerId, ctx.user.customerId)
        ),
      });

      if (!key) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Seal key not found',
        });
      }

      const packages = await db.query.sealPackages.findMany({
        where: eq(sealPackages.sealKeyId, input.sealKeyId),
      });

      return packages;
    }),

  /**
   * Add a new package to a seal key
   */
  addPackage: protectedProcedure
    .input(z.object({
      sealKeyId: z.number().int(),
      packageAddress: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'Must be a valid 32-byte hex address (0x + 64 hex chars)'),
      name: z.string().max(64).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // Use customer lock to prevent race condition on package limit check
      const result = await withCustomerLockForAPI(
        ctx.user.customerId,
        'createPackage',
        async (tx) => {
          // Verify the seal key belongs to the user
          const key = await tx.query.sealKeys.findFirst({
            where: and(
              eq(sealKeys.sealKeyId, input.sealKeyId),
              eq(sealKeys.customerId, ctx.user!.customerId)
            ),
          });

          if (!key) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Seal key not found',
            });
          }

          // Check package count limit (max 10 enabled per key)
          const enabledPackages = await tx.query.sealPackages.findMany({
            where: and(
              eq(sealPackages.sealKeyId, input.sealKeyId),
              eq(sealPackages.isUserEnabled, true)
            ),
          });

          if (enabledPackages.length >= 10) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Maximum package limit reached (10 per seal key)',
            });
          }

          // Convert hex address to Buffer
          const addressBuffer = Buffer.from(input.packageAddress.slice(2), 'hex');

          // Auto-generate name if not provided (package-1, package-2, etc.)
          let packageName = input.name;
          if (!packageName) {
            // Get all packages (including disabled) to avoid name collisions
            const allPackages = await tx.query.sealPackages.findMany({
              where: eq(sealPackages.sealKeyId, input.sealKeyId),
              columns: { name: true },
            });

            // Find all existing package names ending with -N suffix (e.g., "package-2", "mypackage-5")
            const existingNames = allPackages
              .map((p: typeof allPackages[number]) => p.name)
              .filter((n): n is string => !!n);

            // Extract numbers from names ending with -N and find the highest
            const numbers: number[] = [];
            for (const name of existingNames) {
              const match = name.match(/-(\d+)$/);
              if (match) {
                numbers.push(parseInt(match[1], 10));
              }
            }
            const nextNumber = numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
            packageName = `package-${nextNumber}`;
          }

          // Create the package
          const [newPackage] = await tx
            .insert(sealPackages)
            .values({
              sealKeyId: input.sealKeyId,
              packageAddress: addressBuffer,
              name: packageName,
            })
            .returning();

          // ================================================================
          // AUTO-QUEUE UPDATE IF KEY IS REGISTERED
          // ================================================================
          // Increment packagesVersion and check if we need to queue an update
          const [updatedKey] = await tx
            .update(sealKeys)
            .set({
              packagesVersion: sql`${sealKeys.packagesVersion} + 1`,
            })
            .where(eq(sealKeys.sealKeyId, input.sealKeyId))
            .returning({
              packagesVersion: sealKeys.packagesVersion,
              registrationStatus: sealKeys.registrationStatus,
            });

          // If key is already registered, queue update for on-chain re-registration
          if (updatedKey.registrationStatus === 'registered') {
            // Mark as updating
            await tx
              .update(sealKeys)
              .set({ registrationStatus: 'updating' })
              .where(eq(sealKeys.sealKeyId, input.sealKeyId));

            // Queue re-registration operation
            await tx.insert(sealRegistrationOps).values({
              sealKeyId: input.sealKeyId,
              customerId: ctx.user!.customerId,
              network: 'mainnet',
              opType: 'update',
              status: 'queued',
              packagesVersionAtOp: updatedKey.packagesVersion,
            });
          }

          // Check if this makes the service cpEnabled (provisioned to control plane)
          // cpEnabled becomes true when: isUserEnabled=true AND has seal key with package
          if (key.instanceId) {
            const service = await tx.query.serviceInstances.findFirst({
              where: eq(serviceInstances.instanceId, key.instanceId),
            });

            if (service && service.isUserEnabled) {
              // Mark config change for vault sync (new package needs Key-Server sync)
              const expectedVaultSeq = await markConfigChanged(tx, SERVICE_TYPE.SEAL, 'mainnet');

              if (!service.cpEnabled) {
                // First package - set cpEnabled=true along with vault seq
                await tx
                  .update(serviceInstances)
                  .set({
                    cpEnabled: true,
                    smaConfigChangeVaultSeq: expectedVaultSeq,
                  })
                  .where(eq(serviceInstances.instanceId, key.instanceId));
              } else {
                // Service already cpEnabled, just update vault seq
                await tx
                  .update(serviceInstances)
                  .set({ smaConfigChangeVaultSeq: expectedVaultSeq })
                  .where(eq(serviceInstances.instanceId, key.instanceId));
              }
            }
          }

          return {
            id: newPackage.packageId.toString(),
            packageId: newPackage.packageId,
            name: newPackage.name,
            packageAddress: `0x${newPackage.packageAddress.toString('hex')}`,
            packageAddressPreview: `0x${newPackage.packageAddress.toString('hex').slice(0, 6)}...${newPackage.packageAddress.toString('hex').slice(-4)}`,
            isUserEnabled: newPackage.isUserEnabled,
            createdAt: newPackage.createdAt,
          };
        },
        { sealKeyId: input.sealKeyId }
      );

      // Trigger vault regeneration (fire-and-forget, outside transaction)
      // This ensures the new package is included in HAProxy config
      void triggerVaultSync();

      return result;
    }),

  /**
   * Update package address/name
   *
   * VAULT SYNC: If packageAddress changes, needs Key-Server sync.
   * Name changes don't affect vault (display only).
   */
  updatePackage: protectedProcedure
    .input(z.object({
      packageId: z.number().int(),
      packageAddress: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'Must be a valid 32-byte hex address (0x + 64 hex chars)').optional(),
      name: z.string().max(64).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // Address changes need vault sync, name changes don't
      const needsSync = !!input.packageAddress;

      if (needsSync) {
        // Use customer lock for address changes (affects Key-Server config)
        const result = await withCustomerLockForAPI(
          ctx.user.customerId,
          'updatePackage',
          async (tx) => {
            // Verify the package belongs to the user via seal key
            const pkg = await tx.query.sealPackages.findFirst({
              where: eq(sealPackages.packageId, input.packageId),
              with: {
                sealKey: true,
              },
            });

            if (!pkg || pkg.sealKey.customerId !== ctx.user!.customerId) {
              throw new TRPCError({
                code: 'NOT_FOUND',
                message: 'Package not found',
              });
            }

            // Prepare update values
            const updateValues: any = {};
            updateValues.packageAddress = Buffer.from(input.packageAddress!.slice(2), 'hex');
            if (input.name !== undefined) {
              updateValues.name = input.name || null;
            }

            const [updated] = await tx
              .update(sealPackages)
              .set(updateValues)
              .where(eq(sealPackages.packageId, input.packageId))
              .returning();

            // ================================================================
            // AUTO-QUEUE UPDATE IF KEY IS REGISTERED
            // ================================================================
            // Increment packagesVersion and check if we need to queue an update
            const [updatedKey] = await tx
              .update(sealKeys)
              .set({
                packagesVersion: sql`${sealKeys.packagesVersion} + 1`,
              })
              .where(eq(sealKeys.sealKeyId, pkg.sealKey.sealKeyId))
              .returning({
                packagesVersion: sealKeys.packagesVersion,
                registrationStatus: sealKeys.registrationStatus,
              });

            // If key is already registered, queue update for on-chain re-registration
            if (updatedKey.registrationStatus === 'registered') {
              // Mark as updating
              await tx
                .update(sealKeys)
                .set({ registrationStatus: 'updating' })
                .where(eq(sealKeys.sealKeyId, pkg.sealKey.sealKeyId));

              // Queue re-registration operation
              await tx.insert(sealRegistrationOps).values({
                sealKeyId: pkg.sealKey.sealKeyId,
                customerId: ctx.user!.customerId,
                network: 'mainnet',
                opType: 'update',
                status: 'queued',
                packagesVersionAtOp: updatedKey.packagesVersion,
              });
            }

            // Mark config change for vault sync (Key-Server needs new address)
            if (pkg.sealKey.instanceId) {
              const expectedVaultSeq = await markConfigChanged(tx, SERVICE_TYPE.SEAL, 'mainnet');

              await tx
                .update(serviceInstances)
                .set({ smaConfigChangeVaultSeq: expectedVaultSeq })
                .where(eq(serviceInstances.instanceId, pkg.sealKey.instanceId));
            }

            return {
              id: updated.packageId.toString(),
              packageId: updated.packageId,
              name: updated.name,
              packageAddress: `0x${updated.packageAddress.toString('hex')}`,
              packageAddressPreview: `0x${updated.packageAddress.toString('hex').slice(0, 6)}...${updated.packageAddress.toString('hex').slice(-4)}`,
              isUserEnabled: updated.isUserEnabled,
              createdAt: updated.createdAt,
            };
          },
          { packageId: input.packageId }
        );

        // Trigger vault regeneration (fire-and-forget)
        void triggerVaultSync();

        return result;
      } else {
        // Name-only change: no lock or sync needed
        const pkg = await db.query.sealPackages.findFirst({
          where: eq(sealPackages.packageId, input.packageId),
          with: {
            sealKey: true,
          },
        });

        if (!pkg || pkg.sealKey.customerId !== ctx.user.customerId) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Package not found',
          });
        }

        const [updated] = await db
          .update(sealPackages)
          .set({ name: input.name || null })
          .where(eq(sealPackages.packageId, input.packageId))
          .returning();

        return {
          id: updated.packageId.toString(),
          packageId: updated.packageId,
          name: updated.name,
          packageAddress: `0x${updated.packageAddress.toString('hex')}`,
          packageAddressPreview: `0x${updated.packageAddress.toString('hex').slice(0, 6)}...${updated.packageAddress.toString('hex').slice(-4)}`,
          isUserEnabled: updated.isUserEnabled,
          createdAt: updated.createdAt,
        };
      }
    }),

  /**
   * Delete a package (hard delete)
   */
  deletePackage: protectedProcedure
    .input(z.object({
      packageId: z.number().int(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // Use customer lock to ensure consistent vault sync
      const result = await withCustomerLockForAPI(
        ctx.user.customerId,
        'deletePackage',
        async (tx) => {
          // Verify the package belongs to the user via seal key
          const pkg = await tx.query.sealPackages.findFirst({
            where: eq(sealPackages.packageId, input.packageId),
            with: {
              sealKey: true,
            },
          });

          if (!pkg || pkg.sealKey.customerId !== ctx.user!.customerId) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Package not found',
            });
          }

          // Hard delete the package record
          // Note: Package can only be deleted if already disabled (enforced in UI)
          await tx
            .delete(sealPackages)
            .where(eq(sealPackages.packageId, input.packageId));

          // ================================================================
          // AUTO-QUEUE UPDATE IF KEY IS REGISTERED
          // ================================================================
          // Increment packagesVersion and check if we need to queue an update
          const [updatedKey] = await tx
            .update(sealKeys)
            .set({
              packagesVersion: sql`${sealKeys.packagesVersion} + 1`,
            })
            .where(eq(sealKeys.sealKeyId, pkg.sealKey.sealKeyId))
            .returning({
              packagesVersion: sealKeys.packagesVersion,
              registrationStatus: sealKeys.registrationStatus,
            });

          // If key is already registered, queue update for on-chain re-registration
          if (updatedKey.registrationStatus === 'registered') {
            // Mark as updating
            await tx
              .update(sealKeys)
              .set({ registrationStatus: 'updating' })
              .where(eq(sealKeys.sealKeyId, pkg.sealKey.sealKeyId));

            // Queue re-registration operation
            await tx.insert(sealRegistrationOps).values({
              sealKeyId: pkg.sealKey.sealKeyId,
              customerId: ctx.user!.customerId,
              network: 'mainnet',
              opType: 'update',
              status: 'queued',
              packagesVersionAtOp: updatedKey.packagesVersion,
            });
          }

          // Get service instance to update vault sync
          if (pkg.sealKey.instanceId) {
            // Mark config change for vault sync (Key-server needs to remove this package)
            const expectedVaultSeq = await markConfigChanged(tx, SERVICE_TYPE.SEAL, 'mainnet');

            await tx
              .update(serviceInstances)
              .set({ smaConfigChangeVaultSeq: expectedVaultSeq })
              .where(eq(serviceInstances.instanceId, pkg.sealKey.instanceId));
          }

          return { success: true };
        },
        { packageId: input.packageId }
      );

      // Trigger vault regeneration (fire-and-forget)
      void triggerVaultSync();

      return result;
    }),

  /**
   * Update seal key name
   */
  updateKey: protectedProcedure
    .input(z.object({
      sealKeyId: z.number().int(),
      name: z.string().max(64).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // Verify the seal key belongs to the user
      const key = await db.query.sealKeys.findFirst({
        where: and(
          eq(sealKeys.sealKeyId, input.sealKeyId),
          eq(sealKeys.customerId, ctx.user.customerId)
        ),
      });

      if (!key) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Seal key not found',
        });
      }

      // Prepare update values
      const updateValues: { name?: string | null } = {};
      if (input.name !== undefined) {
        updateValues.name = input.name || null;
      }

      // Update the name
      const [updated] = await db
        .update(sealKeys)
        .set(updateValues)
        .where(eq(sealKeys.sealKeyId, input.sealKeyId))
        .returning();

      return {
        id: updated.sealKeyId.toString(),
        sealKeyId: updated.sealKeyId,
        name: updated.name,
      };
    }),

  /**
   * Toggle seal key active/inactive state
   */
  toggleKey: protectedProcedure
    .input(z.object({
      sealKeyId: z.number().int(),
      enabled: z.boolean(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // Use customer lock to ensure consistent vault sync
      const result = await withCustomerLockForAPI(
        ctx.user.customerId,
        'toggleKey',
        async (tx) => {
          // Verify the seal key belongs to the user
          const key = await tx.query.sealKeys.findFirst({
            where: and(
              eq(sealKeys.sealKeyId, input.sealKeyId),
              eq(sealKeys.customerId, ctx.user!.customerId)
            ),
          });

          if (!key) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Seal key not found',
            });
          }

          await tx
            .update(sealKeys)
            .set({
              isUserEnabled: input.enabled,
            })
            .where(eq(sealKeys.sealKeyId, input.sealKeyId));

          // Update vault sync for the service
          if (key.instanceId) {
            // Mark config change for vault sync (Key-server needs to know key state)
            const expectedVaultSeq = await markConfigChanged(tx, SERVICE_TYPE.SEAL, 'mainnet');

            await tx
              .update(serviceInstances)
              .set({ smaConfigChangeVaultSeq: expectedVaultSeq })
              .where(eq(serviceInstances.instanceId, key.instanceId));
          }

          return { success: true };
        },
        { sealKeyId: input.sealKeyId, enabled: input.enabled }
      );

      // Trigger vault regeneration (fire-and-forget)
      void triggerVaultSync();

      return result;
    }),

  /**
   * Toggle package enabled/disabled state
   */
  togglePackage: protectedProcedure
    .input(z.object({
      packageId: z.number().int(),
      enabled: z.boolean(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // Use customer lock to ensure consistent vault sync
      const result = await withCustomerLockForAPI(
        ctx.user.customerId,
        'togglePackage',
        async (tx) => {
          // Verify the package belongs to the user via seal key
          const pkg = await tx.query.sealPackages.findFirst({
            where: eq(sealPackages.packageId, input.packageId),
            with: {
              sealKey: true,
            },
          });

          if (!pkg || pkg.sealKey.customerId !== ctx.user!.customerId) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Package not found',
            });
          }

          await tx
            .update(sealPackages)
            .set({
              isUserEnabled: input.enabled,
            })
            .where(eq(sealPackages.packageId, input.packageId));

          // ================================================================
          // AUTO-QUEUE UPDATE IF KEY IS REGISTERED
          // ================================================================
          // Increment packagesVersion and check if we need to queue an update
          const [updatedKey] = await tx
            .update(sealKeys)
            .set({
              packagesVersion: sql`${sealKeys.packagesVersion} + 1`,
            })
            .where(eq(sealKeys.sealKeyId, pkg.sealKey.sealKeyId))
            .returning({
              packagesVersion: sealKeys.packagesVersion,
              registrationStatus: sealKeys.registrationStatus,
            });

          // If key is already registered, queue update for on-chain re-registration
          if (updatedKey.registrationStatus === 'registered') {
            // Mark as updating
            await tx
              .update(sealKeys)
              .set({ registrationStatus: 'updating' })
              .where(eq(sealKeys.sealKeyId, pkg.sealKey.sealKeyId));

            // Queue re-registration operation
            await tx.insert(sealRegistrationOps).values({
              sealKeyId: pkg.sealKey.sealKeyId,
              customerId: ctx.user!.customerId,
              network: 'mainnet',
              opType: 'update',
              status: 'queued',
              packagesVersionAtOp: updatedKey.packagesVersion,
            });
          }

          // Update vault sync for the service
          if (pkg.sealKey.instanceId) {
            // Mark config change for vault sync (Key-server needs to know package state)
            const expectedVaultSeq = await markConfigChanged(tx, SERVICE_TYPE.SEAL, 'mainnet');

            await tx
              .update(serviceInstances)
              .set({ smaConfigChangeVaultSeq: expectedVaultSeq })
              .where(eq(serviceInstances.instanceId, pkg.sealKey.instanceId));
          }

          return { success: true };
        },
        { packageId: input.packageId, enabled: input.enabled }
      );

      // Trigger vault regeneration (fire-and-forget)
      void triggerVaultSync();

      return result;
    }),

  /**
   * Create a new seal key (derived from master seed)
   *
   * SECURITY: This is a carefully controlled operation that:
   * - Validates user authentication and service subscription
   * - Enforces seal key limits based on subscription tier
   * - Only creates keys for authenticated users with active subscriptions
   *
   * PRODUCTION: This will invoke seal-cli utility to:
   * 1. Derive BLS12-381 key from MASTER_SEED using derivation index
   * 2. Generate the public key (mpk) for IBE operations
   * 3. Store encrypted private key securely
   *
   * This is an EXPENSIVE operation (time + money) - all validation
   * must be done BEFORE calling seal-cli.
   *
   * Name is auto-generated as "seal-key-N" where N is the next sequential number.
   * Users can rename keys after creation if desired.
   *
   * VAULT SYNC: New seal keys need to propagate to both HAProxy (routing)
   * and Key-Server (decryption config).
   */
  createKey: protectedProcedure
    .input(z.object({
      // No input needed - name is auto-generated
    }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // Use customer lock to prevent race condition on seal key limit check
      // NOTE: Lock is held during key generation (EXPENSIVE) to ensure atomicity
      // This is acceptable since key creation is infrequent and the alternative
      // (two concurrent requests both generating keys) wastes more resources
      const result = await withCustomerLockForAPI(
        ctx.user.customerId,
        'createKey',
        async (tx) => {
          // ====================================================================
          // VALIDATION PHASE - Perform ALL checks before expensive operations
          // ====================================================================

          // Verify user has an active Seal service subscription
          const service = await tx.query.serviceInstances.findFirst({
            where: and(
              eq(serviceInstances.customerId, ctx.user!.customerId),
              eq(serviceInstances.serviceType, SERVICE_TYPE.SEAL)
            ),
          });

          if (!service) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'You must have an active Seal service subscription to create seal keys',
            });
          }

          // Check if subscription charge is pending (payment gate logic)
          if (service.subPendingInvoiceId !== null) {
            await retryPendingInvoice(tx, ctx.user!.customerId, {
              instanceId: service.instanceId,
              subPendingInvoiceId: service.subPendingInvoiceId,
            });
          }

          // Get configuration limits
          const config = service.config as any || {};
          const maxSealKeys = config.totalSealKeys || 1;

          // ====================================================================
          // HARD LIMIT CHECK - Prevent derivation index exhaustion
          // ====================================================================
          // Count ALL keys ever created for this customer (including soft-deleted)
          // This is an absolute safety limit to prevent abuse even after deletion
          // is enabled for pro/enterprise tiers.
          const allKeysEver = await tx.query.sealKeys.findMany({
            where: eq(sealKeys.customerId, ctx.user!.customerId),
            columns: { sealKeyId: true },
          });

          if (allKeysEver.length >= SEAL_LIMITS.HARD_LIMIT_KEYS_PER_CUSTOMER) {
            // Check if we already have an unacknowledged notification for this customer
            const existingNotification = await tx.query.adminNotifications.findFirst({
              where: and(
                eq(adminNotifications.customerId, ctx.user!.customerId),
                eq(adminNotifications.code, 'SEAL_KEY_HARD_LIMIT_REACHED'),
                eq(adminNotifications.acknowledged, false)
              ),
            });

            // Create admin notification if not already present
            if (!existingNotification) {
              await tx.insert(adminNotifications).values({
                severity: 'warning',
                category: 'security',
                code: 'SEAL_KEY_HARD_LIMIT_REACHED',
                message: `Customer ${ctx.user!.customerId} has reached the hard limit of ${SEAL_LIMITS.HARD_LIMIT_KEYS_PER_CUSTOMER} seal keys. This may indicate abuse or require limit increase.`,
                details: JSON.stringify({
                  customerId: ctx.user!.customerId,
                  totalKeysCreated: allKeysEver.length,
                  hardLimit: SEAL_LIMITS.HARD_LIMIT_KEYS_PER_CUSTOMER,
                  timestamp: new Date().toISOString(),
                }),
                customerId: ctx.user!.customerId,
              });
            }

            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `Maximum lifetime seal key limit reached (${SEAL_LIMITS.HARD_LIMIT_KEYS_PER_CUSTOMER}). Contact support if you need more keys.`,
            });
          }

          // ====================================================================
          // TIER LIMIT CHECK - Count enabled + disabled (excludes soft-deleted)
          // ====================================================================
          // This is the normal business limit based on subscription tier.
          // Soft-deleted keys don't count because deletion is blocked in production.
          // When deletion is enabled for pro/enterprise, the hard limit above catches abuse.
          const nonDeletedKeys = await tx.query.sealKeys.findMany({
            where: and(
              eq(sealKeys.instanceId, service.instanceId),
              isNull(sealKeys.deletedAt) // Exclude soft-deleted keys
            ),
            columns: { sealKeyId: true },
          });

          // Enforce seal key limit based on subscription tier
          if (nonDeletedKeys.length >= maxSealKeys) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `Maximum seal key limit reached (${maxSealKeys}). Delete an existing key or upgrade your subscription to create more keys.`,
            });
          }

          // ====================================================================
          // ATOMIC DERIVATION INDEX ALLOCATION (Per Process Group)
          // ====================================================================
          // CRITICAL: Derivation indices must be globally unique within each PG.
          // Each PG has its own master seed, so indices are independent namespaces.
          // We use atomic UPDATE...RETURNING to prevent race conditions.

          const processGroup = getSealProcessGroup();

          // Atomically increment the correct PG counter and return allocated index
          // The counter stores the NEXT index to allocate, so we return (new_value - 1)
          let nextIndex: number;
          if (processGroup === 1) {
            const [result] = await tx
              .update(systemControl)
              .set({
                nextSealDerivationIndexPg1: sql`${systemControl.nextSealDerivationIndexPg1} + 1`,
                updatedAt: dbClock.now(),
              })
              .where(eq(systemControl.id, 1))
              .returning({
                // Return the value BEFORE increment (allocated index)
                allocatedIndex: sql<number>`${systemControl.nextSealDerivationIndexPg1} - 1`,
              });
            nextIndex = result.allocatedIndex;
          } else {
            const [result] = await tx
              .update(systemControl)
              .set({
                nextSealDerivationIndexPg2: sql`${systemControl.nextSealDerivationIndexPg2} + 1`,
                updatedAt: dbClock.now(),
              })
              .where(eq(systemControl.id, 1))
              .returning({
                // Return the value BEFORE increment (allocated index)
                allocatedIndex: sql<number>`${systemControl.nextSealDerivationIndexPg2} - 1`,
              });
            nextIndex = result.allocatedIndex;
          }

          // Auto-generate name as "seal-key-N"
          // Find highest N from existing "seal-key-N" names for this service
          const allKeys = await tx.query.sealKeys.findMany({
            where: eq(sealKeys.instanceId, service.instanceId),
            columns: { name: true },
          });

          const sealKeyPattern = /^seal-key-(\d+)$/;
          const existingNumbers = allKeys
            .map((k) => k.name?.match(sealKeyPattern)?.[1])
            .filter((n): n is string => n !== undefined)
            .map((n: string) => parseInt(n, 10));

          const nextKeyNumber = existingNumbers.length === 0 ? 1 : Math.max(...existingNumbers) + 1;
          const autoGeneratedName = `seal-key-${nextKeyNumber}`;

          // ====================================================================
          // KEY GENERATION PHASE - EXPENSIVE OPERATION
          // ====================================================================

          // Generate seal key using seal-cli utility (or mock in development)
          // This is the expensive operation - all validation is complete at this point
          // processGroup was already obtained during index allocation above
          const { publicKey, encryptedPrivateKey } = await generateSealKey({
            derivationIndex: nextIndex,
            customerId: ctx.user!.customerId, // For mock deterministic generation
            processGroup,
          });

          // ====================================================================
          // DATABASE STORAGE PHASE
          // ====================================================================

          // Store the seal key in database
          const [newKey] = await tx
            .insert(sealKeys)
            .values({
              customerId: ctx.user!.customerId,
              instanceId: service.instanceId,
              name: autoGeneratedName,
              derivationIndex: nextIndex,
              publicKey,
              encryptedPrivateKey: encryptedPrivateKey || null,
              processGroup,
              isUserEnabled: true,
            })
            .returning();

          // ====================================================================
          // AUTO-QUEUE REGISTRATION OPERATION
          // ====================================================================
          // Queue Sui blockchain registration for this key.
          // GM will pick this up and create the KeyServer object on-chain.
          // Network is currently hardcoded to 'mainnet' - can be made configurable.
          await tx.insert(sealRegistrationOps).values({
            sealKeyId: newKey.sealKeyId,
            customerId: ctx.user!.customerId,
            network: 'mainnet',
            opType: 'register',
            status: 'queued',
            packagesVersionAtOp: 0,
          });

          // ====================================================================
          // VAULT SYNC PHASE - Mark config changed for propagation
          // ====================================================================

          // Mark config change for vault sync (HAProxy routing + Key-Server decryption)
          const expectedVaultSeq = await markConfigChanged(tx, SERVICE_TYPE.SEAL, 'mainnet');

          await tx
            .update(serviceInstances)
            .set({ smaConfigChangeVaultSeq: expectedVaultSeq })
            .where(eq(serviceInstances.instanceId, service.instanceId));

          // ====================================================================
          // RESPONSE FORMATTING
          // ====================================================================

          // Format for UI display
          const publicKeyHex = newKey.publicKey.toString('hex');
          const keyPreview = `0x${publicKeyHex.slice(0, 6)}...${publicKeyHex.slice(-4)}`;

          return {
            id: newKey.sealKeyId.toString(),
            sealKeyId: newKey.sealKeyId,
            name: newKey.name,
            keyPreview,
            publicKeyHex, // Full public key for export/verification
            isUserEnabled: newKey.isUserEnabled,
            createdAt: newKey.createdAt,
            packages: [],
          };
        },
        { serviceType: 'seal' }
      );

      // Trigger vault regeneration (fire-and-forget)
      void triggerVaultSync();

      return result;
    }),

  /**
   * Get service configuration and resource usage for seal service
   * Returns usage counts, limits, pricing, and configuration
   */
  getUsageStats: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.user) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Not authenticated',
      });
    }

    // Get service instance
    const service = await db.query.serviceInstances.findFirst({
      where: and(
        eq(serviceInstances.customerId, ctx.user.customerId),
        eq(serviceInstances.serviceType, SERVICE_TYPE.SEAL)
      ),
    });

    if (!service) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Seal service not found',
      });
    }

    const config = service.config as any || {};

    // Get configuration from configGlobal
    const globalConfigRows = await db
      .select()
      .from(configGlobal);

    const configMap = new Map(globalConfigRows.map(c => [c.key, c.value]));

    const getConfigInt = (key: string, defaultValue: number): number => {
      const value = configMap.get(key);
      return value ? parseInt(value, 10) : defaultValue;
    };

    const getConfigNumber = (key: string, defaultValue: number): number => {
      const value = configMap.get(key);
      return value ? parseFloat(value) : defaultValue;
    };

    // Count active seal keys
    const activeSealKeys = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(sealKeys)
      .where(and(
        eq(sealKeys.instanceId, service.instanceId),
        eq(sealKeys.isUserEnabled, true)
      ));

    // Count API keys (includes both active and revoked, excludes deleted)
    // Business rule: Revoked keys count as "used" slots
    const usedApiKeys = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(apiKeys)
      .where(and(
        eq(apiKeys.customerId, ctx.user.customerId),
        eq(apiKeys.serviceType, SERVICE_TYPE.SEAL),
        isNull(apiKeys.deletedAt)
      ));

    // Count allowlist entries (from config)
    const allowlistEntries = (config.ipAllowlist || []).length;

    // Get limits and pricing from configGlobal
    const sealKeysIncluded = getConfigInt('fskey_incl', 1);
    const packagesIncluded = getConfigInt('fskey_pkg_incl', 3);
    const apiKeysIncluded = getConfigInt('fapikey_incl', 2);
    const ipv4Included = getConfigInt('fipv4_incl', 2);

    const sealKeyPrice = getConfigNumber('fadd_skey_usd', 5);
    const packagePrice = getConfigNumber('fadd_pkg_usd', 1);
    const apiKeyPrice = getConfigNumber('fadd_apikey_usd', 1);
    const ipv4Price = getConfigNumber('fadd_ipv4_usd', 0);

    return {
      sealKeys: {
        used: activeSealKeys[0]?.count || 0,
        total: config.totalSealKeys || sealKeysIncluded,
        included: sealKeysIncluded,
        purchased: config.purchasedSealKeys || 0,
        pricePerAdditional: sealKeyPrice,
      },
      apiKeys: {
        used: usedApiKeys[0]?.count || 0,
        total: config.totalApiKeys || apiKeysIncluded,
        included: apiKeysIncluded,
        purchased: config.purchasedApiKeys || 0,
        pricePerAdditional: apiKeyPrice,
      },
      allowlist: {
        used: allowlistEntries,
        total: service.tier === 'starter' ? 0 : (config.totalIpv4Allowlist || ipv4Included),
        included: service.tier === 'starter' ? 0 : ipv4Included,
        pricePerAdditional: ipv4Price,
      },
      packagesPerKey: {
        max: config.packagesPerSealKey || packagesIncluded,
        included: packagesIncluded,
        pricePerAdditional: packagePrice,
      },
    };
  }),

  /**
   * Create a new API key for the seal service
   */
  createApiKey: protectedProcedure
    .input(z.object({
      sealType: z.object({
        network: z.enum(['mainnet', 'testnet']),
        access: z.enum(['permission', 'open']),
        source: z.enum(['imported', 'derived']).optional(),
      }).optional(),
      procGroup: z.number().min(0).max(7).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // Use customer lock to prevent race condition on API key limit check
      const result = await withCustomerLockForAPI(
        ctx.user.customerId,
        'createApiKey',
        async (tx) => {
          // Get service instance
          const service = await tx.query.serviceInstances.findFirst({
            where: and(
              eq(serviceInstances.customerId, ctx.user!.customerId),
              eq(serviceInstances.serviceType, SERVICE_TYPE.SEAL)
            ),
          });

          if (!service) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Seal service not found',
            });
          }

          const config = service.config as any || {};
          const maxApiKeys = config.totalApiKeys || 2;

          // Check current count (includes both active and revoked keys, excludes deleted)
          // Business rule: Revoked keys count as "used" slots
          // Note: Using tx for consistent read within the lock
          const currentKeys = await tx.query.apiKeys.findMany({
            where: and(
              eq(apiKeys.customerId, ctx.user!.customerId),
              eq(apiKeys.serviceType, SERVICE_TYPE.SEAL),
              isNull(apiKeys.deletedAt)
            ),
          });

          if (currentKeys.length >= maxApiKeys) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `Maximum API key limit reached (${maxApiKeys}). Delete a revoked key to free up a slot.`,
            });
          }

          // Create new API key (pass tx to ensure insert is in same transaction)
          const { plainKey, record } = await storeApiKey({
            customerId: ctx.user!.customerId,
            serviceType: SERVICE_TYPE.SEAL,
            sealType: input.sealType as SealType,
            procGroup: input.procGroup,
            metadata: {
              createdVia: 'user_request',
            },
            tx, // Use the same transaction
          });

          // Mark config change for vault sync (API keys need to propagate to HAProxy)
          const expectedVaultSeq = await markConfigChanged(tx, SERVICE_TYPE.SEAL, 'mainnet');

          await tx
            .update(serviceInstances)
            .set({ smaConfigChangeVaultSeq: expectedVaultSeq })
            .where(eq(serviceInstances.instanceId, service.instanceId));

          return {
            apiKey: plainKey, // Show only once!
            created: record,
          };
        },
        { serviceType: 'seal' }
      );

      // Trigger vault regeneration (fire-and-forget)
      void triggerVaultSync();

      return result;
    }),

  /**
   * List API keys for the seal service
   */
  listApiKeys: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.user) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Not authenticated',
      });
    }

    const keys = await getApiKeys(ctx.user.customerId, SERVICE_TYPE.SEAL, true);

    // Decrypt keys and return both preview and full key
    // Full key is kept in memory but not rendered to DOM (safe from scraping)
    return keys.map(key => {
      const plainKey = decryptSecret(key.apiKeyId); // Decrypt the stored key
      return {
        apiKeyFp: key.apiKeyFp, // Use fingerprint (PRIMARY KEY) for identification
        keyPreview: `${plainKey.slice(0, 8)}...${plainKey.slice(-4)}`, // Preview from decrypted key
        fullKey: plainKey, // Full key for copying (not rendered to DOM)
        metadata: key.metadata,
        isUserEnabled: key.isUserEnabled,
        createdAt: key.createdAt,
        revokedAt: key.revokedAt,
      };
    });
  }),

  /**
   * Revoke an API key
   */
  revokeApiKey: protectedProcedure
    .input(z.object({
      apiKeyFp: z.number().int(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // Use customer lock to ensure consistent vault sync
      const result = await withCustomerLockForAPI(
        ctx.user.customerId,
        'revokeApiKey',
        async (tx) => {
          // Revoke by fingerprint (primary key) - no decryption needed
          const updated = await tx
            .update(apiKeys)
            .set({
              isUserEnabled: false,
              revokedAt: dbClock.now(),
            })
            .where(
              and(
                eq(apiKeys.apiKeyFp, input.apiKeyFp),
                eq(apiKeys.customerId, ctx.user!.customerId)
              )
            )
            .returning();

          if (updated.length === 0) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'API key not found or already revoked',
            });
          }

          // Get service instance to update vault sync
          const service = await tx.query.serviceInstances.findFirst({
            where: and(
              eq(serviceInstances.customerId, ctx.user!.customerId),
              eq(serviceInstances.serviceType, SERVICE_TYPE.SEAL)
            ),
          });

          if (service) {
            // Mark config change for vault sync (HAProxy needs to reject this key)
            const expectedVaultSeq = await markConfigChanged(tx, SERVICE_TYPE.SEAL, 'mainnet');

            await tx
              .update(serviceInstances)
              .set({ smaConfigChangeVaultSeq: expectedVaultSeq })
              .where(eq(serviceInstances.instanceId, service.instanceId));
          }

          return { success: true };
        },
        { apiKeyFp: input.apiKeyFp }
      );

      // Trigger vault regeneration (fire-and-forget)
      void triggerVaultSync();

      return result;
    }),

  /**
   * Re-enable a revoked API key
   */
  reEnableApiKey: protectedProcedure
    .input(z.object({
      apiKeyFp: z.number().int(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // Use customer lock to ensure consistent vault sync
      const result = await withCustomerLockForAPI(
        ctx.user.customerId,
        'reEnableApiKey',
        async (tx) => {
          // Re-enable by fingerprint (primary key) - no decryption needed
          const updated = await tx
            .update(apiKeys)
            .set({
              isUserEnabled: true,
              revokedAt: null,
            })
            .where(
              and(
                eq(apiKeys.apiKeyFp, input.apiKeyFp),
                eq(apiKeys.customerId, ctx.user!.customerId),
                isNull(apiKeys.deletedAt) // Cannot re-enable deleted keys
              )
            )
            .returning();

          if (updated.length === 0) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'API key not found or cannot be re-enabled',
            });
          }

          // Get service instance to update vault sync
          const service = await tx.query.serviceInstances.findFirst({
            where: and(
              eq(serviceInstances.customerId, ctx.user!.customerId),
              eq(serviceInstances.serviceType, SERVICE_TYPE.SEAL)
            ),
          });

          if (service) {
            // Mark config change for vault sync (HAProxy needs to accept this key again)
            const expectedVaultSeq = await markConfigChanged(tx, SERVICE_TYPE.SEAL, 'mainnet');

            await tx
              .update(serviceInstances)
              .set({ smaConfigChangeVaultSeq: expectedVaultSeq })
              .where(eq(serviceInstances.instanceId, service.instanceId));
          }

          return { success: true };
        },
        { apiKeyFp: input.apiKeyFp }
      );

      // Trigger vault regeneration (fire-and-forget)
      void triggerVaultSync();

      return result;
    }),

  /**
   * Delete an API key (soft delete - irreversible from UI)
   */
  deleteApiKey: protectedProcedure
    .input(z.object({
      apiKeyFp: z.number().int(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // Use customer lock to ensure consistent vault sync
      const result = await withCustomerLockForAPI(
        ctx.user.customerId,
        'deleteApiKey',
        async (tx) => {
          // Soft delete by fingerprint (primary key) - no decryption needed
          const updated = await tx
            .update(apiKeys)
            .set({
              deletedAt: dbClock.now(),
            })
            .where(
              and(
                eq(apiKeys.apiKeyFp, input.apiKeyFp),
                eq(apiKeys.customerId, ctx.user!.customerId)
              )
            )
            .returning();

          if (updated.length === 0) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'API key not found',
            });
          }

          // Get service instance to update vault sync
          const service = await tx.query.serviceInstances.findFirst({
            where: and(
              eq(serviceInstances.customerId, ctx.user!.customerId),
              eq(serviceInstances.serviceType, SERVICE_TYPE.SEAL)
            ),
          });

          if (service) {
            // Mark config change for vault sync (HAProxy needs to remove this key)
            const expectedVaultSeq = await markConfigChanged(tx, SERVICE_TYPE.SEAL, 'mainnet');

            await tx
              .update(serviceInstances)
              .set({ smaConfigChangeVaultSeq: expectedVaultSeq })
              .where(eq(serviceInstances.instanceId, service.instanceId));
          }

          return { success: true };
        },
        { apiKeyFp: input.apiKeyFp }
      );

      // Trigger vault regeneration (fire-and-forget)
      void triggerVaultSync();

      return result;
    }),

  /**
   * Update burst setting for seal service
   */
  updateBurstSetting: protectedProcedure
    .input(z.object({
      enabled: z.boolean(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // Use customer lock to prevent lost updates on config JSON
      const result = await withCustomerLockForAPI(
        ctx.user.customerId,
        'toggleBurst',
        async (tx) => {
          // Get service instance
          const service = await tx.query.serviceInstances.findFirst({
            where: and(
              eq(serviceInstances.customerId, ctx.user!.customerId),
              eq(serviceInstances.serviceType, SERVICE_TYPE.SEAL)
            ),
          });

          if (!service) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Seal service not found',
            });
          }

          // Starter tier doesn't support burst
          if (service.tier === 'starter') {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Burst is only available for Pro and Enterprise tiers',
            });
          }

          // Update config
          const config = service.config as any || {};
          config.burstEnabled = input.enabled;

          // Mark config change for vault sync
          const expectedVaultSeq = await markConfigChanged(tx, SERVICE_TYPE.SEAL, 'mainnet');

          await tx
            .update(serviceInstances)
            .set({
              config,
              smaConfigChangeVaultSeq: expectedVaultSeq,
            })
            .where(eq(serviceInstances.instanceId, service.instanceId));

          return { success: true, burstEnabled: input.enabled };
        },
        { enabled: input.enabled }
      );

      // Trigger vault regeneration (fire-and-forget)
      void triggerVaultSync();

      return result;
    }),

  /**
   * Update IP allowlist for seal service
   *
   * Independent operations:
   * - Toggle ON/OFF: Send { enabled: true/false } without entries
   * - Save IP list: Send { enabled: current_state, entries: "ip1, ip2" }
   */
  updateIpAllowlist: protectedProcedure
    .input(ipAllowlistUpdateSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // Use customer lock to prevent lost updates on config JSON
      const result = await withCustomerLockForAPI(
        ctx.user.customerId,
        'updateIpAllowlist',
        async (tx) => {
          // Get service instance
          const service = await tx.query.serviceInstances.findFirst({
            where: and(
              eq(serviceInstances.customerId, ctx.user!.customerId),
              eq(serviceInstances.serviceType, SERVICE_TYPE.SEAL)
            ),
          });

          if (!service) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Seal service not found',
            });
          }

          // Starter tier doesn't support IP allowlist
          if (service.tier === 'starter') {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'IP Allowlist is only available for Pro and Enterprise tiers',
            });
          }

          // Create a new config object so Drizzle detects changes
          const config = { ...(service.config as any || {}) };

          // If entries are provided, validate and update the IP list
          if (input.entries !== undefined) {
            const { ips, errors } = parseIpAddressList(input.entries);

            if (errors.length > 0) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: `Invalid IP addresses:\n${errors.map(e => `• ${e.ip}: ${e.error}`).join('\n')}`,
              });
            }

            // Get actual tier limit from configGlobal
            // This ensures customers with purchased additional capacity aren't blocked
            const globalConfigRows = await tx.select().from(configGlobal);
            const configMap = new Map<string, string>(globalConfigRows.map((c: typeof globalConfigRows[number]) => [c.key, c.value ?? '']));
            const ipv4Included = parseInt(configMap.get('fipv4_incl') || '2', 10);

            // Use customer-specific limit or fall back to default
            const maxIpv4 = config.totalIpv4Allowlist || ipv4Included;

            if (ips.length > maxIpv4) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: `Maximum ${maxIpv4} IPv4 addresses allowed for your configuration. You provided ${ips.length}.`,
              });
            }

            // Update IP list
            config.ipAllowlist = ips;
          }

          // Always update the enabled flag (independent of IP list changes)
          config.ipAllowlistEnabled = input.enabled;

          // Mark config change for vault sync (same pattern as service toggle)
          // This ensures UI shows "Updating..." until LM applies the change
          const expectedVaultSeq = await markConfigChanged(tx, SERVICE_TYPE.SEAL, 'mainnet');

          await tx
            .update(serviceInstances)
            .set({
              config,
              smaConfigChangeVaultSeq: expectedVaultSeq,
            })
            .where(eq(serviceInstances.instanceId, service.instanceId));

          return {
            success: true,
            enabled: input.enabled,
            entries: config.ipAllowlist || [], // Return current IPs (may be unchanged)
            errors: [],
          };
        },
        { enabled: input.enabled }
      );

      // Trigger vault regeneration (fire-and-forget, outside transaction)
      // GM will pick up the change and generate a new vault
      void triggerVaultSync();

      return result;
    }),

  /**
   * Get More Settings configuration
   */
  getMoreSettings: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.user) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Not authenticated',
      });
    }

    // Get service instance
    const service = await db.query.serviceInstances.findFirst({
      where: and(
        eq(serviceInstances.customerId, ctx.user.customerId),
        eq(serviceInstances.serviceType, SERVICE_TYPE.SEAL)
      ),
    });

    if (!service) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Seal service not found',
      });
    }

    const config = service.config as any || {};

    return {
      burstEnabled: config.burstEnabled ?? (service.tier !== 'starter'),
      ipAllowlistEnabled: config.ipAllowlistEnabled ?? false,
      ipAllowlist: config.ipAllowlist || [],
    };
  }),

  /**
   * Delete a seal key (soft delete)
   *
   * IMPORTANT: This is BLOCKED in production environments.
   * - Derivation indices are a precious, non-renewable resource
   * - Once allocated, an index is permanently bound to that customer
   * - Indices must NEVER be recycled - even if key is "deleted"
   *
   * In development, soft delete sets deletedAt timestamp but retains the record.
   * This prevents index reuse while allowing cleanup during testing.
   */
  deleteKey: protectedProcedure
    .input(z.object({
      sealKeyId: z.number(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // CRITICAL: Block deletion in production
      // Derivation indices are non-renewable - deletion would waste them
      if (isProduction()) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Seal key deletion is disabled in production. Keys can be disabled but not deleted. Contact support if you need to export a key.',
        });
      }

      return await withCustomerLockForAPI(ctx.user.customerId, 'deleteKey', async (tx) => {
        // Verify ownership - key must belong to this customer
        const key = await tx.query.sealKeys.findFirst({
          where: and(
            eq(sealKeys.sealKeyId, input.sealKeyId),
            eq(sealKeys.customerId, ctx.user!.customerId),
            isNull(sealKeys.deletedAt) // Can't delete already-deleted keys
          ),
        });

        if (!key) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Seal key not found or already deleted',
          });
        }

        // Soft delete - derivation index remains consumed forever
        // This ensures the index is never reused even after "deletion"
        await tx
          .update(sealKeys)
          .set({ deletedAt: dbClock.now() })
          .where(eq(sealKeys.sealKeyId, input.sealKeyId));

        // Mark config changed for vault sync (key removed from HAProxy routing)
        const expectedVaultSeq = await markConfigChanged(tx, SERVICE_TYPE.SEAL, 'mainnet');

        // Update service's configChangeVaultSeq if key was associated with a service
        if (key.instanceId) {
          await tx
            .update(serviceInstances)
            .set({ smaConfigChangeVaultSeq: expectedVaultSeq })
            .where(eq(serviceInstances.instanceId, key.instanceId));
        }

        return { success: true, sealKeyId: input.sealKeyId };
      });
    }),
});
