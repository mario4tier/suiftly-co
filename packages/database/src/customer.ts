/**
 * Customer creation utilities
 *
 * Provides robust customer creation with collision-resistant ID generation.
 * This module is the SINGLE source of truth for customer creation - all code
 * (API, GM, tests) should use these functions instead of direct inserts.
 */

import { randomInt } from 'crypto';
import { db as defaultDb } from './db';
import { customers } from './schema';
import { eq, type InferSelectModel } from 'drizzle-orm';
import type { DBClock } from '@suiftly/shared/db-clock';

// Type for the database instance (allows passing transaction or db)
type DbInstance = typeof defaultDb;

// Full customer type from the database schema
export type Customer = InferSelectModel<typeof customers>;

// Customer creation input (wallet address is required, escrow is optional)
export interface CreateCustomerInput {
  walletAddress: string;
  escrowContractId?: string | null;
}

/**
 * Generate a cryptographically secure random customer ID in the range [1, 2^31-1]
 * Uses crypto.randomInt for cryptographically secure random values.
 */
function generateCustomerId(): number {
  return randomInt(1, 2147483648); // [1, 2^31-1]
}

/**
 * Check if a customer ID already exists in the database
 */
async function customerIdExists(customerId: number, dbInstance: DbInstance = defaultDb): Promise<boolean> {
  const existing = await dbInstance.query.customers.findFirst({
    where: eq(customers.customerId, customerId),
    columns: { customerId: true },
  });
  return !!existing;
}

/**
 * Create a new customer with a unique, collision-resistant ID.
 *
 * This function:
 * 1. Generates a random customer ID
 * 2. Checks if the ID already exists (pre-check to avoid unnecessary insert attempts)
 * 3. Attempts to insert the customer
 * 4. If insert fails due to duplicate key, retries with a new ID (up to MAX_RETRIES)
 *
 * @param input - Customer data (walletAddress required, escrowContractId optional)
 * @param clock - DBClock for time reference (required for testability)
 * @param dbInstance - Database instance (allows passing transaction for atomic operations)
 * @returns The created customer record
 * @throws Error if unable to create customer after MAX_RETRIES attempts
 */
export async function createCustomer(
  input: CreateCustomerInput,
  clock: DBClock,
  dbInstance: DbInstance = defaultDb
): Promise<Customer> {
  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const customerId = generateCustomerId();

    // Pre-check: avoid insert attempt if ID already exists
    // This is a performance optimization, not a guarantee (race condition still possible)
    if (await customerIdExists(customerId, dbInstance)) {
      console.warn(`[createCustomer] ID collision detected (pre-check), attempt ${attempt}/${MAX_RETRIES}`);
      continue;
    }

    try {
      // Set currentPeriodStart to first day of current month (UTC)
      const now = clock.now();
      const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
        .toISOString()
        .split('T')[0];

      const [customer] = await dbInstance
        .insert(customers)
        .values({
          customerId,
          walletAddress: input.walletAddress,
          escrowContractId: input.escrowContractId ?? null,
          currentPeriodStart: periodStart,
        })
        .returning();

      return customer;
    } catch (error: any) {
      // Check if this is a duplicate key error (PostgreSQL error code 23505)
      const isDuplicateKey =
        error.code === '23505' || // PostgreSQL unique violation
        error.message?.includes('duplicate key') ||
        error.message?.includes('unique constraint');

      if (isDuplicateKey && attempt < MAX_RETRIES) {
        console.warn(`[createCustomer] ID collision on insert, attempt ${attempt}/${MAX_RETRIES}`);
        continue;
      }

      // Not a collision or max retries reached - rethrow
      throw error;
    }
  }

  // This should be extremely rare - 3 consecutive collisions out of ~1.9B IDs
  throw new Error(
    `Failed to create customer after ${MAX_RETRIES} attempts due to ID collisions. ` +
    `This is extremely unlikely - please check for bugs or database issues.`
  );
}

/**
 * Find an existing customer by wallet address, or create a new one if not found.
 *
 * This is the most common pattern - use this instead of manual find-or-create logic.
 *
 * @param input - Customer data (walletAddress required, escrowContractId optional)
 * @param clock - DBClock for time reference (required for testability)
 * @param dbInstance - Database instance (allows passing transaction)
 * @returns Object containing the customer and whether it was newly created
 */
export async function findOrCreateCustomer(
  input: CreateCustomerInput,
  clock: DBClock,
  dbInstance: DbInstance = defaultDb
): Promise<{ customer: Customer; created: boolean }> {
  // First, try to find existing customer
  const existing = await dbInstance.query.customers.findFirst({
    where: eq(customers.walletAddress, input.walletAddress),
  });

  if (existing) {
    return { customer: existing, created: false };
  }

  // Not found - create new customer
  const customer = await createCustomer(input, clock, dbInstance);
  return { customer, created: true };
}

/**
 * Find an existing customer by wallet address, or create with escrow update logic.
 *
 * This handles the common pattern where:
 * - If customer doesn't exist: create with escrow address
 * - If customer exists without escrow: update with escrow address
 * - If customer exists with different escrow: throw conflict error
 * - If customer exists with same escrow: return as-is
 *
 * @param input - Customer data (walletAddress required, escrowContractId required)
 * @param clock - DBClock for time reference (required for testability)
 * @param dbInstance - Database instance
 * @returns The customer (created, updated, or existing)
 * @throws Error with code 'ESCROW_CONFLICT' if customer has different escrow address
 */
export async function findOrCreateCustomerWithEscrow(
  input: CreateCustomerInput & { escrowContractId: string },
  clock: DBClock,
  dbInstance: DbInstance = defaultDb
): Promise<{ customer: Customer; action: 'created' | 'updated' | 'unchanged' }> {
  // First, try to find existing customer
  const existing = await dbInstance.query.customers.findFirst({
    where: eq(customers.walletAddress, input.walletAddress),
  });

  if (!existing) {
    // Create new customer with escrow
    const customer = await createCustomer(input, clock, dbInstance);
    return { customer, action: 'created' };
  }

  if (!existing.escrowContractId) {
    // Update existing customer with escrow address
    const [updated] = await dbInstance
      .update(customers)
      .set({
        escrowContractId: input.escrowContractId,
        updatedAt: clock.now(),
      })
      .where(eq(customers.customerId, existing.customerId))
      .returning();
    return { customer: updated, action: 'updated' };
  }

  if (existing.escrowContractId !== input.escrowContractId) {
    // Conflict - customer already has a different escrow address
    const error = new Error(
      `Customer already has escrow address ${existing.escrowContractId}`
    );
    (error as any).code = 'ESCROW_CONFLICT';
    (error as any).existingEscrow = existing.escrowContractId;
    throw error;
  }

  // Same escrow address - return as-is
  return { customer: existing, action: 'unchanged' };
}
