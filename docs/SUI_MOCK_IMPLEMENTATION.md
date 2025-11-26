# Sui Network Mock Implementation

## Overview

This document describes the mock Sui network implementation for development and testing. The mock simulates blockchain escrow operations using PostgreSQL, allowing rapid development without requiring actual Sui network interaction.

**Key Design Principle:** The mock implementation conforms to the same `ISuiService` interface that the real Sui blockchain integration will use. This ensures seamless transition from mock to production with minimal code changes.

## Implementation Status

✅ **Complete** - Mock wallet system fully implemented and tested

## Architecture

### Three-Layer Design

```
┌─────────────────────────────────────────────────────────────┐
│  Business Logic Layer                                        │
│  - Service subscriptions                                     │
│  - Billing calculations                                      │
│  - Balance validation                                        │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ↓ ISuiService interface
┌─────────────────────────────────────────────────────────────┐
│  Sui Service Layer (Interface)                              │
│  - getAccount()                                              │
│  - deposit() / withdraw()                                    │
│  - charge() / credit()                                       │
│  - updateSpendingLimit()                                     │
└────────────┬────────────────────────────────────────────────┘
             │
             ├── Mock (Development)         Real (Production)
             ↓                              ↓
┌────────────────────────┐   ┌──────────────────────────────┐
│  MockSuiService        │   │  RealSuiService             │
│  - PostgreSQL storage  │   │  - Sui blockchain calls     │
│  - Instant transactions│   │  - PTB (Programmable        │
│  - No gas fees         │   │    Transaction Blocks)      │
│  - Deterministic       │   │  - Real signatures          │
└────────────────────────┘   └──────────────────────────────┘
```

### Interface-Based Design Benefits

1. **Seamless Transition:** Swap mock with real implementation by changing one line
2. **Type Safety:** TypeScript enforces contract between layers
3. **Testability:** Mock enables comprehensive E2E tests without blockchain
4. **Development Speed:** No waiting for blockchain confirmations
5. **Cost Savings:** No gas fees during development

## File Structure

```
apps/api/src/services/sui/
├── interface.ts          # ISuiService interface (contract)
├── mock.ts               # MockSuiService implementation
├── index.ts              # Factory (returns appropriate service)
└── real.ts               # (Future) RealSuiService implementation

apps/api/src/routes/
└── billing.ts            # tRPC router using ISuiService

apps/api/src/server.ts    # Test API endpoints for mock control
```

## Key Components

### 1. ISuiService Interface

**Purpose:** Defines the contract for all Sui blockchain operations

**Key Methods:**
- `getAccount(userAddress)` - Query escrow account state
- `deposit(params)` - Add funds to escrow
- `withdraw(params)` - Remove funds from escrow
- `charge(params)` - Suiftly-initiated charge (enforces spending limit)
- `credit(params)` - Refund to user
- `updateSpendingLimit(params)` - User updates 28-day limit
- `syncAccount(userAddress)` - Sync blockchain state to database
- `buildTransaction(operation, params)` - Build PTB for user signature
- `isMock()` - Returns true if mock, false if real

**Critical Design Decisions:**

1. **All operations are ON-CHAIN at this layer**
   - Mock simulates blockchain behavior
   - Real implementation makes actual blockchain calls
   - Off-chain batching optimizations happen in higher layers

2. **Automatic account creation on user operations**
   - `deposit()`, `withdraw()`, `updateSpendingLimit()` create account if needed
   - Reduces user friction (one signature instead of two)
   - Real implementation uses PTB: `create_account_and_deposit()`
   - Mock simulates this by creating database records

3. **Blockchain is source of truth**
   - Never assume we control account lifecycle
   - Users can deposit/withdraw via other wallets
   - Always query blockchain state (or mock state)

### 2. MockSuiService Implementation

**Storage:** Uses existing `customers` table fields:
- `currentBalanceUsdCents` - Balance in USDC cents
- `spendingLimitUsdCents` - 28-day spending limit
- `currentPeriodChargedUsdCents` - Charged this period
- `currentPeriodStart` - Period start date
- `escrowContractId` - Simulated shared account address

**Behavior:**
- Instant transactions (no blockchain delay)
- Deterministic transaction digests (0xMOCKTX...)
- No gas fees
- Automatic 28-day period resets
- Spending limit enforcement (matches smart contract logic)

**28-Day Period Logic:**
```typescript
const PERIOD_DURATION_MS = 28 * 24 * 60 * 60 * 1000; // 2,419,200,000 ms

// Check if period elapsed
const now = Date.now();
const elapsed = now - periodStartMs;

if (elapsed >= PERIOD_DURATION_MS) {
  // Reset period
  currentPeriodCharged = 0;
  periodStart = now;
}
```

### 3. Test API Endpoints

**Purpose:** Allow Playwright tests to control mock wallet state

**Endpoints:**

```bash
# Get balance
GET /test/wallet/balance?walletAddress=0xaaa...

# Deposit (simulates user depositing via wallet)
POST /test/wallet/deposit
{
  "walletAddress": "0xaaa...",
  "amountUsd": 100,
  "initialSpendingLimitUsd": 250  # Optional, for first deposit
}

# Withdraw (simulates user withdrawing via wallet)
POST /test/wallet/withdraw
{
  "walletAddress": "0xaaa...",
  "amountUsd": 50
}

# Update spending limit
POST /test/wallet/spending-limit
{
  "walletAddress": "0xaaa...",
  "limitUsd": 500  # 0 = unlimited
}
```

**Security:** These endpoints are only available in development/test environments

### 4. Billing tRPC Router

**Purpose:** Provide balance and transaction history to frontend

**Endpoints:**

```typescript
// Get current balance
trpc.billing.getBalance.useQuery()
// Returns: {
//   found: true,
//   balanceUsd: 123.45,
//   spendingLimitUsd: 250,
//   currentPeriodChargedUsd: 78.90,
//   currentPeriodRemainingUsd: 171.10,
//   periodEndsAt: "2025-02-03T12:34:56.789Z"
// }

// Get transaction history
trpc.billing.getTransactions.useQuery({ limit: 20, offset: 0 })

// Force sync from blockchain
trpc.billing.syncBalance.useMutation()
```

## Testing Strategy

### Playwright E2E Tests

**Test File:** `apps/webapp/tests/e2e/escrow-mock.spec.ts`

**Scenarios Covered:**

1. **Wallet Operations**
   - ✅ Deposit funds and see balance update
   - ✅ Withdraw funds and see balance decrease
   - ✅ Cannot withdraw more than balance
   - ✅ Can update spending limit

2. **Service Subscriptions**
   - ✅ Subscribe with sufficient balance
   - ⚠️  Cannot subscribe with insufficient balance (needs UI integration)
   - ⚠️  Cannot exceed 28-day spending limit (needs UI integration)

3. **Spending Limit Enforcement**
   - ✅ Limit enforced in mock service
   - ⚠️  UI validation pending frontend integration

**Test Pattern:**

```typescript
// 1. Reset test data
await page.request.post('/test/data/reset', {
  data: { balanceUsdCents: 0, spendingLimitUsdCents: 25000 }
});

// 2. Simulate user depositing via wallet
await page.request.post('/test/wallet/deposit', {
  data: { walletAddress: MOCK_WALLET_ADDRESS, amountUsd: 100 }
});

// 3. Verify balance
const balanceData = await page.request.get('/test/wallet/balance');
expect(balanceData.balanceUsd).toBe(100);

// 4. Test UI interactions
await page.click('button:has-text("Subscribe")');

// 5. Verify backend state
const balanceAfter = await page.request.get('/test/wallet/balance');
expect(balanceAfter.currentPeriodChargedUsd).toBe(20); // $20 charge
```

## Future: Real Sui Implementation

### What Changes When Moving to Production

**File:** `apps/api/src/services/sui/real.ts`

```typescript
export class RealSuiService implements ISuiService {
  private suiClient: SuiClient;
  private packageId: string; // Escrow smart contract package ID

  async getAccount(userAddress: string): Promise<EscrowAccount | null> {
    // Query actual Sui blockchain
    const objects = await this.suiClient.getOwnedObjects({
      owner: userAddress,
      filter: { Package: this.packageId }
    });

    // Find shared Account object for this user
    // ...
  }

  async deposit(params: DepositParams): Promise<TransactionResult> {
    // Build PTB (Programmable Transaction Block)
    const tx = new Transaction();

    // Check if account exists
    const account = await this.getAccount(params.userAddress);

    if (!account) {
      // Create account and deposit in single transaction
      tx.moveCall({
        target: `${this.packageId}::escrow::create_account_and_deposit`,
        arguments: [
          tx.object(usdcCoin),
          tx.pure.u64(params.initialSpendingLimitUsdCents),
          tx.pure.address(SUIFTLY_ADDRESS)
        ]
      });
    } else {
      // Just deposit
      tx.moveCall({
        target: `${this.packageId}::escrow::deposit`,
        arguments: [
          tx.object(account.accountAddress),
          tx.object(usdcCoin)
        ]
      });
    }

    // User signs and executes
    // (actual signing happens in frontend)
    return { digest: result.digest, success: true };
  }

  // ... other methods
}
```

**Factory Change:**

```typescript
// apps/api/src/services/sui/index.ts
export function getSuiService(): ISuiService {
  if (process.env.NODE_ENV === 'production' && !process.env.USE_MOCK_SUI) {
    return new RealSuiService();  // ← Only change needed!
  }
  return mockSuiService;
}
```

### Frontend Changes (Minimal)

**No changes** to business logic - just update wallet interaction:

```typescript
// Real wallet signing (production)
const tx = await suiService.buildTransaction('deposit', params);
const signedTx = await wallet.signTransaction(tx);
await submitTransaction(signedTx);

// Mock wallet (development)
// No signature needed - test API simulates
```

## Next Steps

### Immediate (This Session - ✅ COMPLETE)
- ✅ Interface design
- ✅ Mock implementation
- ✅ Test API endpoints
- ✅ Billing router
- ✅ Playwright tests

### Near-Term (Frontend Integration)
- [ ] Update billing page to show balance from `trpc.billing.getBalance`
- [ ] Add balance display in header wallet widget
- [ ] Show "Insufficient Balance" errors in subscription flow
- [ ] Add spending limit warnings in UI
- [ ] Implement deposit/withdraw UI (for mock wallet only)

### Long-Term (Real Sui Integration)
- [ ] Deploy escrow smart contract to Sui testnet
- [ ] Implement `RealSuiService`
- [ ] Test with real Sui wallets
- [ ] Deploy to mainnet
- [ ] Swap mock for real in production

## Design Decisions

### Why This Approach?

1. **Interface-first design** ensures future compatibility
2. **Mock in PostgreSQL** leverages existing infrastructure
3. **Test API control** enables comprehensive E2E testing
4. **Automatic account creation** reduces user friction
5. **ON-CHAIN at service layer** keeps optimization concerns separate

### Rejected Alternatives

1. **Mock in memory** - Loses state between requests
2. **Separate mock database** - Unnecessary complexity
3. **Skip mock entirely** - Blocks development until smart contract ready
4. **Off-chain ledger** - Defeats purpose of blockchain escrow

## Summary

The mock Sui implementation provides:

✅ **Full escrow functionality** without blockchain dependency
✅ **Seamless transition path** to real Sui integration
✅ **Comprehensive testing** via Playwright
✅ **Rapid development** with instant transactions
✅ **Type safety** enforced by `ISuiService` interface

**Implementation is complete and tested.** Frontend integration is the next step to expose balance and handle deposit/withdraw UI.
