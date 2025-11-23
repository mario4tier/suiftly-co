/**
 * Escrow Account Flow Test
 *
 * Tests the complete escrow account lifecycle:
 * 1. Client creates account on-chain
 * 2. Client reports escrow address to backend
 * 3. Backend uses escrow address for subsequent operations
 * 4. Account creation during deposit/withdraw updates DB
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '@suiftly/database';
import { customers, mockSuiTransactions } from '@suiftly/database/schema';
import { eq } from 'drizzle-orm';
import { getSuiService } from '../src/services/sui';
import { MockSuiService } from '../src/services/sui/mock';

describe('Escrow Account Flow', () => {
  const testWallet = '0x1234567890123456789012345678901234567890123456789012345678901234';
  const testEscrowAddress = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

  beforeEach(async () => {
    // Clean up any existing test data - delete in correct order to avoid FK constraints
    await db.delete(mockSuiTransactions);
    // Delete all test customers to ensure clean slate
    await db.delete(customers).where(eq(customers.walletAddress, testWallet));
  });

  afterEach(async () => {
    // Clean up after each test to ensure no data leaks
    await db.delete(mockSuiTransactions);
    await db.delete(customers).where(eq(customers.walletAddress, testWallet));
  });

  it('should handle client-reported escrow address correctly', async () => {
    const suiService = getSuiService() as MockSuiService;

    // Step 1: Verify no customer record exists initially
    let customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, testWallet),
    });
    expect(customer).toBeUndefined();

    // Step 2: Simulate client creating account on-chain
    // (In reality, this happens on the blockchain, not through our service)
    // For testing, we'll just assume it happened

    // Step 3: Client reports escrow address to backend
    // This would normally happen through the reportEscrowAddress endpoint
    // For unit testing, we'll directly update the DB
    const customerId = Math.floor(Math.random() * 1000000000);
    await db.insert(customers).values({
      customerId,
      walletAddress: testWallet,
      escrowContractId: testEscrowAddress,
    });

    // Step 4: Verify customer record now has escrow address
    customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, testWallet),
    });
    expect(customer).toBeDefined();
    expect(customer!.escrowContractId).toBe(testEscrowAddress);

    // Step 5: Backend should use stored escrow address for operations
    // Test deposit with existing escrow address
    const depositResult = await suiService.deposit({
      userAddress: testWallet,
      amountUsdCents: 1000,
      escrowAddress: customer!.escrowContractId!,
    });

    expect(depositResult.success).toBe(true);
    expect(depositResult.accountCreated).toBe(false); // Should not create new account

    // Verify balance was updated
    const account = await suiService.getAccount(testWallet);
    expect(account).toBeDefined();
    expect(account!.balanceUsdCents).toBe(1000);
  });

  it('should update DB when account is created during deposit', async () => {
    const suiService = getSuiService() as MockSuiService;

    // Step 1: Start with no customer record
    let customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, testWallet),
    });
    expect(customer).toBeUndefined();

    // Step 2: Deposit without escrow address (triggers account creation)
    const depositResult = await suiService.deposit({
      userAddress: testWallet,
      amountUsdCents: 2000,
      initialSpendingLimitUsdCents: 25000,
    });

    expect(depositResult.success).toBe(true);
    expect(depositResult.accountCreated).toBe(true);
    expect(depositResult.createdObjects).toBeDefined();
    expect(depositResult.createdObjects!.escrowAddress).toBeDefined();

    // Step 3: Verify customer record was created with escrow address
    // The mock service automatically creates the customer record
    customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, testWallet),
    });
    expect(customer).toBeDefined();
    expect(customer!.escrowContractId).toBe(depositResult.createdObjects!.escrowAddress);

    // Step 4: Subsequent operations should use the stored escrow address
    const withdrawResult = await suiService.withdraw({
      userAddress: testWallet,
      amountUsdCents: 500,
      escrowAddress: customer!.escrowContractId!,
    });

    expect(withdrawResult.success).toBe(true);
    expect(withdrawResult.accountCreated).toBe(false); // Should not create new account

    // Verify balance
    const account = await suiService.getAccount(testWallet);
    expect(account).toBeDefined();
    expect(account!.balanceUsdCents).toBe(1500); // 2000 - 500
  });

  it('should handle charge operations with escrow address from DB', async () => {
    const suiService = getSuiService() as MockSuiService;

    // Setup: Create customer with escrow address and necessary fields
    const customerId = Math.floor(Math.random() * 1000000000);
    await db.insert(customers).values({
      customerId,
      walletAddress: testWallet,
      escrowContractId: testEscrowAddress,
      currentBalanceUsdCents: 0,
      currentMonthChargedUsdCents: 0,
      lastMonthChargedUsdCents: 0,
      currentMonthStart: new Date(),
      maxMonthlyUsdCents: 0, // 0 = unlimited
    });

    // Deposit funds first
    await suiService.deposit({
      userAddress: testWallet,
      amountUsdCents: 5000,
      escrowAddress: testEscrowAddress,
    });

    // Charge should work with escrow address
    const chargeResult = await suiService.charge({
      userAddress: testWallet,
      amountUsdCents: 900,
      description: 'Test subscription charge',
      escrowAddress: testEscrowAddress,
    });

    expect(chargeResult.success).toBe(true);

    // Verify balance and charges
    const account = await suiService.getAccount(testWallet);
    expect(account).toBeDefined();
    expect(account!.balanceUsdCents).toBe(4100); // 5000 - 900
    expect(account!.currentPeriodChargedUsdCents).toBe(900);
  });

  it('should fail charge without escrow address when account does not exist', async () => {
    const suiService = getSuiService() as MockSuiService;

    // Try to charge without escrow address (and no existing account)
    const chargeResult = await suiService.charge({
      userAddress: testWallet,
      amountUsdCents: 100,
      description: 'Test charge',
      escrowAddress: '', // Empty escrow address
    });

    expect(chargeResult.success).toBe(false);
    expect(chargeResult.error).toContain('Account does not exist');
  });

  it('should prioritize DB escrow address over blockchain discovery', async () => {
    const suiService = getSuiService() as MockSuiService;

    // Step 1: Create account with specific escrow address and necessary fields
    const customerId = Math.floor(Math.random() * 1000000000);
    await db.insert(customers).values({
      customerId,
      walletAddress: testWallet,
      escrowContractId: testEscrowAddress,
      currentBalanceUsdCents: 0,
      currentMonthChargedUsdCents: 0,
      lastMonthChargedUsdCents: 0,
      currentMonthStart: new Date(),
      maxMonthlyUsdCents: 0, // 0 = unlimited
    });

    // Step 2: Deposit using DB escrow address
    const depositResult = await suiService.deposit({
      userAddress: testWallet,
      amountUsdCents: 3000,
      escrowAddress: testEscrowAddress, // Use DB address
    });

    if (!depositResult.success) {
      console.error('Deposit failed:', depositResult.error);
    }

    expect(depositResult.success).toBe(true);
    expect(depositResult.accountCreated).toBe(false); // Should use existing

    // Step 3: Verify the same escrow address is still in DB
    const customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, testWallet),
    });
    expect(customer!.escrowContractId).toBe(testEscrowAddress);
  });
});