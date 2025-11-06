# Escrow Account Design Specification

## Overview

Suiftly uses a **shared escrow smart contract** model where users deposit tokens that Suiftly can charge for services without requiring repeated wallet signatures. This document specifies the escrow account architecture, protections, user flows, and technical implementation.

**Key Principle:** User deposits once → Suiftly auto-charges for services → User can withdraw remaining balance anytime.

**Initial Asset:** For MVP launch, **only USDC** is accepted as the escrow deposit asset. SUI and other tokens may be added in future phases.

---

## Architecture

### Escrow Model

```
┌─────────────────────────────────────────────────────┐
│  User Wallet (Sui)                                  │
│  - User controls private keys                       │
│  - Signs deposits/withdrawals only                  │
└──────────────────┬──────────────────────────────────┘
                   │
                   │ Deposit USDC (blockchain TX)
                   ↓
┌─────────────────────────────────────────────────────┐
│  Suiftly Escrow Smart Contract (On-Chain)          │
│  - Holds USDC tokens for all users (MVP: USDC only)│
│  - Enforces monthly spending limits (per user)     │
│  - Allows Suiftly to deduct charges                │
│  - Allows user to withdraw remaining balance       │
└──────────────────┬──────────────────────────────────┘
                   │
                   │ Charge events
                   ↓
┌─────────────────────────────────────────────────────┐
│  Suiftly Backend Database (Off-Chain)              │
│  - Tracks USD balance per user                     │
│  - Records all charges/credits                     │
│  - Suspends service when balance insufficient      │
│  - Validates before applying charges               │
└─────────────────────────────────────────────────────┘
```

### Key Components

1. **Sui Blockchain (On-Chain)**
   - Escrow smart contract holds USDC tokens (MVP: USDC only)
   - Enforces monthly spending limit per user
   - Logs all deposits/withdrawals with TX hashes

2. **Suiftly Backend (Off-Chain)**
   - PostgreSQL database tracks USD balances
   - For MVP: Direct USD value from USDC (1:1 peg)
   - Future: Rate oracle for SUI and other non-stablecoin assets
   - Applies charges automatically (no blockchain TX needed)
   - Validates balance and limits before charging

3. **User Wallet (Sui)**
   - User signs: Deposits (USDC), withdrawals, spending limit changes
   - User does NOT sign: Service charges, credits, config changes

---

## Currency Model

### USD Denominated, USDC Settled (MVP)

**All prices displayed in USD, all blockchain transactions in USDC.**

- **Pricing:** Services priced in USD (e.g., $40/month for Pro tier)
- **Display:** Balances shown in USD throughout UI
- **Settlement:** Deposits/withdrawals use USDC tokens on Sui blockchain (MVP: USDC only)
- **Conversion:** For MVP, USDC ≈ USD (1:1 peg assumed). No rate oracle needed.

### USDC → USD Conversion (MVP)

**Simplified Model for MVP:**
- USDC is a USD-pegged stablecoin (1 USDC ≈ $1)
- No rate oracle required for MVP
- Direct 1:1 conversion: 100 USDC = $100 USD balance
- Deposit/withdrawal amounts match exactly (no volatility risk)

**Display Example (MVP):**
```
Balance: $100.00 (100 USDC in escrow)
```

### Future: Multi-Asset Support with Rate Oracle

**When SUI and other assets are added (post-MVP):**
- Rate oracle for volatile assets (SUI, etc.)
- Multiple sources: CoinGecko API, CoinMarketCap API, Binance ticker
- Rate aggregation: Median of ≥2 sources
- Staleness check: Reject rates older than 5 minutes
- Cache: 60-second cache to reduce API load
- Slippage protection: Warn if sources differ by >5%

**Future Display Example:**
```
Balance: $100.00 (100 USDC + 40.82 SUI)
Current SUI rate: 1 SUI = $2.45 (updated 47s ago, from 3 sources)
```

---

## On-Chain Protections

### User-Configurable Monthly Spending Limit

**Smart contract enforces a monthly spending cap to protect users from bugs, exploits, or excessive billing.**

**Values (see [CONSTANTS.md](./CONSTANTS.md) for authoritative source):**
- Default: **$500 per month**
- Minimum: **$20**
- Maximum: **Unlimited** (no cap)
- User-adjustable via Settings (requires wallet signature)
- Enforced by smart contract (Suiftly backend cannot override)

**Calendar Month Model:**
- Tracks spending from 1st to last day of each calendar month (UTC)
- Resets automatically on the 1st of each month
- Smart contract emits `MonthlyReset` event on rollover
- Off-chain database field `current_month_start` tracks current billing period
- Example: Spending in January resets on February 1st (regardless of when service started)

**Behavior When Limit Reached:**
- Additional charges blocked by smart contract
- User notified: "Monthly spending limit reached ($X). Service changes available on [next month date], or increase limit in Settings."
- Current services continue running (only NEW charges blocked)

**Changing the Limit:**
- User navigates to Settings → Spending Limit
- Enters new limit (validated: ≥$20, or "unlimited")
- Clicks "Update Limit" → Wallet signature requested
- Blockchain transaction updates escrow contract config
- Activity log: "Monthly spending limit changed: $500 → $1,000"

---

### Suiftly-Enforced Protections

**1. Insufficient Balance Handling**
- No minimum balance requirement enforced on withdrawals
- User can withdraw their full balance at any time
- If charge fails due to insufficient balance: Service automatically moves to "suspended" state
- Periodic checks (on deposit or billing cycle) automatically resume service if balance becomes sufficient

**2. 2-Month Buffer Warning (Recommended, Not Enforced)**
- Frontend warns if balance < 2× monthly estimate
- Example: "Balance: $85. Estimated monthly: $60. We recommend depositing $35 more."
- User can proceed (not blocked), just a helpful nudge

**3. Proactive Frontend Validation**
- Frontend checks balance and monthly limit BEFORE allowing save
- "Enable Service" or "Save Changes" button disabled if insufficient funds
- Clear error banner shows exact problem and solution
- No failed save attempts (if button enabled, save will succeed)

**4. Backend Validation (Defense in Depth)**
- Backend validates again before applying any charge
- If check fails: Charge NOT applied, service moves to "suspended" state
- Prevents race conditions or stale frontend data
- Automatic resume when balance becomes sufficient (checked on deposits and periodic billing)

---

## User Flows

### Flow 1: First Deposit (Set Spending Limit)

```
1. User connects wallet (JWT issued)
   ↓
2. User clicks "Top Up" in header
   ↓
3. Modal: "Set Your Monthly Spending Limit" (first-time only)

   Maximum charges per month (30 days): [$ 2000 ]

   ⓘ This protects your escrow account from excessive charges.
     Most users spend $50-$500/month. You can change this anytime.

   Suggested:
   • $500/month  - Single service (Starter/Pro)
   • $500/month - Default (see CONSTANTS.md)
   • $5,000/month - Heavy usage / multiple services

   ☑ Use $500/month (see CONSTANTS.md)

   [Set Limit & Continue]
   ↓
4. User clicks "Set Limit & Continue"
   ↓
5. Wallet signature requested (on-chain config)
   ↓
6. Blockchain TX: Create escrow account with monthly limit = $500
   ↓
7. Modal updates: "Deposit Funds to Escrow"

   Amount (USD): [$ 100 ]

   Required USDC: 100 USDC
   (USDC is a USD stablecoin: 1 USDC ≈ $1)

   [Deposit]
   ↓
8. User clicks "Deposit"
   ↓
9. Wallet signature requested (blockchain TX)
   ↓
10. TX submitted → Shows "Pending confirmation... (TX: 0xabc123...)"
    ↓
11. Backend monitors: 0 → 1 → 2 → 3 confirmations (~3-5 sec)
    ↓
12. After 3 confirmations → TX finalized
    ↓
13. Backend credits $100 USD to user's balance in database
    ↓
14. Balance updates in UI: $0 → $100
    ↓
15. Toast: "Deposit successful. +$100.00 added to escrow balance."
    ↓
16. Activity log: "Deposit: +$100.00 (100 USDC) - TX: 0xabc123..."
```

**Note:** Once deposited, Suiftly can auto-charge for services without requiring additional wallet signatures.

---

### Flow 2: Enable Service (Auto-Charge from Escrow)

```
User balance: $100
User on: /services/seal (not configured)

1. User configures service:
   - Tier: Pro ($40/month)
   - Burst: Enabled (+$10/month)
   - Total API keys: 2 (+$1/month)
   ↓
2. Live pricing shows: "Total Monthly Fee: $51/month"
                       "Charge now: $30 (pro-rated for current month)"
   ↓
3. Frontend validates continuously:
   - Balance check: $100 > $30 ✓
   - Monthly limit check: $0 + $30 = $30 < $500 ✓
   - Result: "Enable Service" button ENABLED
   ↓
4. User clicks "Enable Service"
   ↓
5. API call: POST /api/services.updateConfig
   ↓
6. Backend validates:
   - Balance: $100 > $30 ✓
   - Monthly limit: $30 < $500 ✓
   - Signature check: JWT valid ✓
   ↓
7. Backend decrements balance in database: $100 → $70 (NO blockchain TX)
   ↓
8. Backend creates service config in database
   ↓
9. Frontend receives success response
   ↓
10. UI updates:
    - Balance: $100 → $70
    - Service page: Onboarding form → Tab view (Config/Keys/Stats/Logs)
    - Sidebar: Seal service shows 🟢 green dot
    ↓
11. Toast: "Seal service enabled. $30 charged from escrow balance."
    ↓
12. Activity log: "Service enabled - Pro tier - Charged $30 (pro-rated)"
```

**Key Point:** No wallet signature required for the charge. Escrow model allows backend to deduct automatically.

---

### Flow 3: Config Change (Insufficient Balance - Proactively Blocked)

```
User balance: $15
Monthly spent: $50
Monthly limit: $500
Active service: Seal (Pro tier, $40/month)

1. User clicks [Edit] on service config
   ↓
2. Modal opens with current config
   ↓
3. User changes tier: Starter → Pro (+$20 pro-rated charge)
   ↓
4. Live pricing updates: "New monthly: $40" | "Charge now: +$15 (pro-rated)"
   ↓
5. Frontend validates as user changes:
   - Balance check: $10 < $15 ❌
   - Monthly limit check: $50 + $15 = $65 < $500 ✓
   ↓
6. "Save Changes" button becomes DISABLED
   ↓
7. Error banner appears in modal:
   "⚠ Cannot save changes - Insufficient balance

   This configuration requires: $25.00 (pro-rated)
   Your balance: $15.00
   Additional needed: $10.00

   [Top Up $10] [Top Up $50]"
   ↓
8. User clicks "Top Up $10"
   ↓
9. Deposit flow (see Flow 1, steps 7-16)
   ↓
10. After deposit: Balance $15 → $25
    ↓
11. Edit modal still open, "Save Changes" button now ENABLED
    ↓
12. User clicks "Save Changes"
    ↓
13. Config updated, $25 charged
    ↓
14. Toast: "Configuration updated. $25 charged from escrow balance."
```

**Key Point:** Change blocked upfront if insufficient balance. No failed save attempts. Current service continues without interruption.

---

### Flow 4: Config Change (Would Exceed Monthly Limit - Blocked)

```
User balance: $500
Monthly spent: $1,950
Monthly limit: $500

1. User on Keys tab, clicks "Add Seal Key" 15 times
   ↓
2. Live pricing: "+$75/month (15 keys × $5)"
   ↓
3. Frontend validates:
   - Balance check: $500 > $75 ✓
   - Monthly limit check: $1,950 + $75 = $510 > $500 ❌
   ↓
4. "Save Changes" button DISABLED
   ↓
5. Error banner:
   "⚠ Cannot save - Would exceed monthly spending limit

   Your monthly limit: $500
   Spent this month: $1,950
   This change: +$75
   Total: $2,025 (exceeds by $25)

   Options:
   - Reduce to max 10 keys ($50, within limit)
   - Increase monthly limit in Settings
   - Wait 12 days for spending window reset

   [Increase Monthly Limit] [Adjust to 10 Keys]"
   ↓
6. User clicks "Adjust to 10 Keys"
   ↓
7. Number of keys reduced to 10
   ↓
8. Live pricing: "+$50/month"
   ↓
9. Frontend validates:
   - Monthly limit check: $1,950 + $50 = $500 ✓ (at limit but not over)
   ↓
10. "Save Changes" button ENABLED
    ↓
11. User clicks "Save Changes"
    ↓
12. Success: 10 keys added, $50 charged
    ↓
13. Toast: "10 seal keys added. $50 charged."
```

**Key Point:** Frontend calculates max affordable (10 keys) and offers one-click adjustment.

---

### Flow 5: Withdrawal

```
User balance: $127.50
Active services: Seal ($60/month)

1. User clicks wallet widget → Dropdown → "Withdraw"
   ↓
2. Modal: "Withdraw Funds from Escrow"

   Total balance: $127.50
   Amount (USD): [$ 50 ]

   Will receive: 50 USDC
   (USDC is a USD stablecoin: 1 USDC ≈ $1)

   ⓘ Note: You have active services ($60/month).
     Low balance may cause service suspension at next charge.

   [Withdraw]
   ↓
3. User clicks "Withdraw"
   ↓
4. Wallet signature requested (blockchain TX)
   ↓
5. TX submitted → "Pending confirmation... (TX: 0xdef456...)"
   ↓
6. Backend monitors confirmations (3 required)
   ↓
7. After 3 confirmations → Escrow contract releases 50 USDC to user wallet
   ↓
8. Backend decrements USD balance: $127.50 → $77.50
   ↓
9. Modal closes
   ↓
10. Toast: "Withdrawal successful. -$50.00 (50 USDC sent to your wallet)"
    ↓
11. Activity log: "Withdrawal: -$50.00 (50 USDC) - TX: 0xdef456..."
```

**Note:** User can withdraw full balance. If balance becomes insufficient for charges, service automatically moves to "suspended" state.

---

### Flow 6: Running Out of Funds (Active Service)

```
Service active: Seal ($60/month)
Balance drops over time: $75 → $35 → $10 → $0

Timeline:
Day 1 (balance $35):
  → Warning toast: "Low balance: $35 remaining. Top up to avoid service suspension."

Day 5 (balance $10):
  → Warning banner on all pages: "⚠ Low Balance ($10). Service will be suspended when balance is insufficient for next charge. [Top Up Now]"

Day 8 (charge attempt fails - balance insufficient):
  → Service automatically moves to "suspended" state:
    - Service state: active → suspended
    - Banner: "⚠ Service Suspended - Insufficient Funds. Deposit to resume service automatically."
    - API requests return 402 Payment Required
    - No new charges applied during suspension

User deposits $100:
  → Periodic check triggered on deposit
  → Balance check: $100 > monthly cost ✓
  → Service automatically resumes:
    - Service state: suspended → active
    - Toast: "Service resumed. Sufficient balance detected."
    - Charge applied for current period
```

**Automatic Resume:** Service automatically resumes when sufficient balance is detected (checked on deposit and periodic billing cycles). No manual intervention required.

---

## Ledger Reconciliation & Blockchain Confirmation

### Deposit Reconciliation Flow

**Backend monitors blockchain for confirmation:**

1. **Submitted:** TX in mempool (0 confirmations)
   - UI: "Pending confirmation... (TX: 0xabc...)"

2. **Pending:** 1-2 confirmations
   - UI: "Confirming deposit... (2/3 confirmations)"
   - Link to explorer: "View on SuiScan"

3. **Finalized:** 3+ confirmations (~3-5 seconds on Sui)
   - Backend marks deposit as "finalized"
   - USD balance credited in database
   - UI: Balance updated
   - Activity log entry created with TX hash

**Pending Deposit UX:**
- Show spinner with confirmation count
- Link to blockchain explorer
- If TX fails or reverts: Show error, balance NOT credited
- Timeout: If no confirmation after 60 seconds → "Transaction delayed. Check explorer."

### Reorg Handling

**Sui blockchain has fast finality (~3 sec) and low reorg risk.**

- If reorg detected (finalized TX disappears):
  - Backend flags inconsistency
  - Pauses account (prevents further charges)
  - Admin review required (edge case, manual resolution)
  - User notified: "Deposit under review. Contact support."

### Withdrawal Reconciliation

- Similar flow: Pending → Finalized (3 confirmations)
- Balance decremented only after backend confirms TX submission success
- If TX fails after submission: Balance refunded, user notified

### Invoice & On-Chain Linking

**Every finalized deposit/withdrawal stored with:**
- Invoice line item ID
- On-chain TX hash
- Timestamp of finality
- Amount in USDC and USD equivalent at transaction time (MVP: 1:1)

**Billing history shows TX hash links for verification:**
```
Jan 9, 2025 14:23
Deposit: +$100.00 (100 USDC)
TX: 0xabc123... [View on SuiScan]
Rate: 1 USDC ≈ $1.00
```

---

## Smart Contract Interface

### Escrow Contract Functions (Sui Move)

**User-Callable:**
```move
// Deposit USDC to escrow (MVP: USDC only)
public entry fun deposit(account: &mut EscrowAccount, payment: Coin<USDC>)

// Withdraw USDC from escrow (enforces minimum balance if services active)
public entry fun withdraw(account: &mut EscrowAccount, amount: u64, ctx: &mut TxContext)

// Set monthly spending limit
public entry fun set_monthly_limit(account: &mut EscrowAccount, limit_usd_cents: u64, ctx: &mut TxContext)
```

**Suiftly-Backend-Callable (via capability):**
```move
// Charge user for service (enforces monthly limit)
public fun charge(
    account: &mut EscrowAccount,
    amount_usd_cents: u64,
    capability: &SuiftlyAdminCap,
    ctx: &mut TxContext
): bool  // Returns true if charge succeeded, false if would exceed monthly limit

// Credit user (refund)
public fun credit(
    account: &mut EscrowAccount,
    amount_usd_cents: u64,
    capability: &SuiftlyAdminCap
)
```

**Contract State (per user):**
```move
struct EscrowAccount has key {
    id: UID,
    owner: address,  // User's wallet address
    balance_usdc: Balance<USDC>,  // Actual USDC tokens (MVP: USDC only)
    monthly_limit_usd_cents: u64,  // See CONSTANTS.md (e.g., 50000 = $500 default)
    current_month_charged_usd_cents: u64,  // Charged this calendar month
    current_month_start_epoch: u64,  // Epoch timestamp of current month start (1st day, 00:00 UTC)
}
```

**Note:** For MVP, `balance_usdc` represents both the token balance and USD value (1:1 peg). Future versions supporting SUI/other assets will require additional fields and conversion logic.

**Monthly Limit Enforcement Logic:**
```move
// Check if charge would exceed monthly limit
public fun can_charge(account: &EscrowAccount, amount_usd_cents: u64, clock: &Clock): bool {
    // Check if we've rolled over to a new month
    let now_ms = clock::timestamp_ms(clock);
    let current_month_start = get_month_start_epoch(now_ms);  // Helper: returns epoch of 1st of current month

    // If new month started, reset counter
    let charged_this_month = if (current_month_start > account.current_month_start_epoch) {
        0  // New month, counter resets
    } else {
        account.current_month_charged_usd_cents
    };

    // Check if new charge would exceed limit (0 means unlimited)
    if (account.monthly_limit_usd_cents == 0) {
        return true;  // Unlimited
    };

    charged_this_month + amount_usd_cents <= account.monthly_limit_usd_cents
}
```

---

## Backend Database Schema

**For the complete database schema including all tables, see [CUSTOMER_SERVICE_SCHEMA.md](./CUSTOMER_SERVICE_SCHEMA.md#database-schema-summary).**

This section describes the escrow-specific tables and their usage:

### Key Tables for Escrow Operations

**customers** (canonical schema in CUSTOMER_SERVICE_SCHEMA.md)
- Stores wallet_address, balance_usd_cents, monthly_limit_usd_cents
- customer_id is a random 32-bit integer (1 to 4,294,967,295)
- See [CUSTOMER_SERVICE_SCHEMA.md](./CUSTOMER_SERVICE_SCHEMA.md#complete-schema) for complete table definition

**ledger_entries** - All financial transactions
```sql
CREATE TABLE ledger_entries (
  id UUID PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
  type VARCHAR(20) NOT NULL,  -- 'deposit', 'withdrawal', 'charge', 'credit'
  amount_usd_cents BIGINT NOT NULL,  -- USD amount (signed: + for deposit/credit, - for charge/withdrawal)
  amount_usdc_cents BIGINT,  -- USDC amount in smallest unit (MVP: USDC only), null for charges/credits
  asset_type VARCHAR(20),  -- 'USDC' (MVP), future: 'SUI', 'USDT', etc.
  asset_usd_rate_cents BIGINT,  -- Rate at transaction time (cents per 1 token), MVP: 100 = $1.00 for USDC
  tx_hash VARCHAR(66),  -- On-chain TX hash for deposits/withdrawals, null for charges/credits
  description TEXT,  -- e.g., "Service enabled - Pro tier (pro-rated)"
  invoice_id VARCHAR(50),  -- e.g., "INV-2025-01-001"
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ledger_customer_created ON ledger_entries(customer_id, created_at DESC);
CREATE INDEX idx_ledger_tx_hash ON ledger_entries(tx_hash) WHERE tx_hash IS NOT NULL;
```

**Note:** For MVP with USDC only, `asset_type='USDC'` and `asset_usd_rate_cents=100` (1:1 peg). Future multi-asset support will use variable rates for SUI and other tokens.

**Note:** With calendar month model, we don't need a separate `spending_window` table. The `customers.current_month_charged_usd_cents` field tracks spending, which resets on the 1st of each month via the Global Manager's monthly reset task.

---

## Frontend Implementation

### State Management (Zustand Store)

```typescript
interface EscrowStore {
  // Balance
  balanceUsd: number  // USD balance (e.g., 127.50)

  // Spending limit
  monthlyLimitUsd: number  // e.g., 2000
  monthlySpentUsd: number  // Last 30 days (e.g., 680)

  // Validation helpers
  canAfford: (costUsd: number) => boolean
  wouldExceedLimit: (costUsd: number) => boolean
  calculateMaxAffordable: (unitCostUsd: number) => number

  // Actions
  deposit: (amountUsd: number) => Promise<void>
  withdraw: (amountUsd: number) => Promise<void>
  setMonthlyLimit: (newLimitUsd: number) => Promise<void>
}

// Usage in components
const escrow = useEscrowStore()

// Real-time validation
const canSave = escrow.canAfford(25) && !escrow.wouldExceedLimit(25)

<Button disabled={!canSave}>Save Changes</Button>
```

### Validation Functions

```typescript
// Check if user has sufficient balance
function canAfford(balanceUsd: number, costUsd: number): boolean {
  return balanceUsd >= costUsd
}

// Check if charge would exceed monthly limit
function wouldExceedLimit(
  monthlySpentUsd: number,
  monthlyLimitUsd: number,
  costUsd: number
): boolean {
  return (monthlySpentUsd + costUsd) > monthlyLimitUsd
}

// Calculate maximum units affordable within limits
function calculateMaxAffordable(
  balanceUsd: number,
  monthlySpentUsd: number,
  monthlyLimitUsd: number,
  unitCostUsd: number
): number {
  const maxByBalance = Math.floor(balanceUsd / unitCostUsd)
  const remainingMonthly = monthlyLimitUsd - monthlySpentUsd
  const maxByLimit = Math.floor(remainingMonthly / unitCostUsd)

  return Math.min(maxByBalance, maxByLimit)
}
```

---

## Security Considerations

### Smart Contract Security

1. **Access Control**
   - Only user can: Deposit, withdraw, set monthly limit
   - Only Suiftly backend (via capability) can: Charge, credit
   - Capability stored securely on backend (not exposed to users)

2. **Reentrancy Protection**
   - Use Sui Move's resource model (linear types)
   - No external calls during balance mutations

3. **Monthly Limit Enforcement**
   - Enforced at smart contract level (backend cannot override)
   - Rolling 30-day window prevents gaming the system
   - All charges logged on-chain for transparency

4. **Minimum Balance Enforcement**
   - Checked during withdrawal (if services active, cannot withdraw below $50)
   - Prevents withdraw-and-abandon attack

### Backend Security

1. **Idempotency for Financial Operations**
   - All mutating billing endpoints (deposit, charge, credit, withdrawal) require `idempotency_key` header
   - Backend stores idempotency keys with their responses in database
   - Duplicate requests with same key return original response (prevents double-charges)
   - Keys expire after 24 hours
   - Frontend generates: `crypto.randomUUID()` for each operation

   ```typescript
   // ledger_idempotency table
   CREATE TABLE ledger_idempotency (
     idempotency_key UUID PRIMARY KEY,
     customer_id INTEGER NOT NULL,
     response_json JSONB NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );

   // Cleanup old keys daily
   DELETE FROM ledger_idempotency WHERE created_at < NOW() - INTERVAL '24 hours';
   ```

2. **Balance Validation**
   - Always check balance BEFORE applying charge
   - Use database transactions (BEGIN/COMMIT) for balance updates
   - Prevent negative balances (constraint: balance_usd_cents >= 0)

3. **Rate Limiting**
   - Limit deposit/withdrawal requests (5 per hour per user)
   - Limit config changes (2 per hour per user)
   - Prevent rapid create/revoke cycles (fraud detection)

4. **Audit Logging**
   - All ledger entries immutable (INSERT only, no UPDATE/DELETE)
   - Log includes: User ID, action, amount, timestamp, TX hash, idempotency key

5. **Capability Protection**
   - Suiftly admin capability stored in backend secrets (env var)
   - Never exposed to frontend or API responses
   - Rotate periodically (90 days)

---

## Error Handling

### User-Facing Errors

**Insufficient Balance:**
```
Modal: "Insufficient Balance"

To enable Seal service, you need:
- Required: $35.00 (pro-rated monthly fee)
- Your balance: $20.00
- Additional needed: $15.00

[Top Up $15] [Top Up $50] [Cancel]
```

**Would Exceed Monthly Limit:**
```
Banner: "⚠ Cannot save - Would exceed monthly spending limit"

Your monthly limit: $500
Spent this month: $1,950
This change: +$75
Total: $2,025 (exceeds by $25)

Options:
- Reduce to max 10 keys ($50, within limit)
- Increase monthly limit in Settings

[Increase Monthly Limit] [Adjust to 10 Keys]
```

**Deposit Transaction Failed:**
```
Modal: "Transaction Failed"

Your deposit transaction failed. Please check your wallet and try again.

Blockchain error: Insufficient gas

[Retry] [Cancel]
```

**Withdrawal Warning (Insufficient Balance):**
```
Modal: "Low Balance Warning"

Your balance after withdrawal will be insufficient for your active services.
This may cause service suspension at the next charge.

Current balance: $127.50
After withdrawal: $27.50
Monthly service cost: $60.00

Do you want to proceed?

[Proceed with Withdrawal] [Cancel]
```

### Backend Errors

**Balance Check Failed (Triggers Suspension):**
```typescript
class InsufficientBalanceError extends Error {
  constructor(public required: number, public available: number) {
    super(`Insufficient balance: required $${required}, available $${available}. Service suspended.`)
  }
}

// On charge failure, automatically transition to suspended state
// Service will auto-resume when balance becomes sufficient (checked on deposit/billing cycle)
```

**Monthly Limit Exceeded:**
```typescript
class MonthlyLimitExceededError extends Error {
  constructor(
    public limit: number,
    public spent: number,
    public attemptedCharge: number
  ) {
    super(`Monthly limit exceeded: ${spent} + ${attemptedCharge} > ${limit}`)
  }
}
```

---

## Monitoring & Alerting

### Metrics to Track

1. **Escrow Health**
   - Total SUI in escrow contract (should match sum of user balances)
   - Discrepancies → Alert (potential reconciliation issue)

2. **Deposit/Withdrawal Success Rate**
   - Track failed transactions
   - Alert if failure rate > 5%

3. **Low Balance Users**
   - Count users with balance < 1 month estimate
   - Proactive outreach to prevent service pauses

4. **Monthly Limit Hit Rate**
   - Track how often users hit monthly limit
   - May indicate limits are too low or usage spikes

### Alerts

**Critical:**
- Escrow balance mismatch (contract vs. database)
- Smart contract capability compromised
- Blockchain confirmations delayed >5 minutes

**Warning:**
- Deposit/withdrawal failure rate >5%
- Rate oracle unreachable or stale
- User balance negative (should never happen)

---

## Testing Scenarios

### Unit Tests

1. **Balance Validation**
   - Charge with sufficient balance → Success
   - Charge with insufficient balance → Error
   - Charge exactly at balance → Success (balance = 0)

2. **Monthly Limit Validation**
   - Charge within limit → Success
   - Charge would exceed limit → Error
   - Charge exactly at limit → Success

3. **Rate Oracle**
   - All sources available → Median rate
   - Only 2 sources available → Median rate
   - Only 1 source available → Error (require ≥2)
   - Stale rates → Error

### Integration Tests

1. **Deposit Flow**
   - Deposit SUI → Confirm TX → Balance credited in USD
   - Verify TX hash stored
   - Verify rate oracle used

2. **Charge Flow**
   - Enable service → Balance decremented
   - Verify ledger entry created
   - Verify spending window updated

3. **Withdrawal Flow**
   - Withdraw SUI → Confirm TX → Balance debited
   - Verify minimum balance enforced
   - Verify TX hash stored

### End-to-End Tests

1. **Full User Journey**
   - Connect wallet → Set spending limit → Deposit → Enable service → Withdraw

2. **Insufficient Balance Path**
   - Try to enable service with low balance → Blocked → Top up → Success

3. **Monthly Limit Path**
   - Spend near limit → Try config change → Blocked → Increase limit → Success

---

## Future Enhancements

### Post-MVP Features

1. **Multi-Asset Support (SUI, USDT, etc.)**
   - Currently: USDC only (MVP)
   - Phase 2: Add SUI token support with rate oracle
   - Phase 3: Add other stablecoins (USDT, etc.)
   - Requires: Rate oracle implementation, multi-balance tracking

2. **Usage-Based Spending Cap (Off-Chain)**
   - Separate limit for metered usage (requests/bandwidth)
   - Example: Max $500/month for usage fees (separate from base service fees)
   - Prevents runaway metered charges

3. **Auto-Top-Up**
   - User sets threshold: "If balance < $50, auto-deposit $100"
   - Requires pre-authorized wallet transaction

4. **Recurring Deposits**
   - User schedules monthly deposits (e.g., $100 on 1st of month)
   - Prevents service pauses for regular users

5. **Tiered Spending Limits**
   - Daily/weekly caps in addition to monthly
   - More granular control for power users

---

## Summary

**Escrow Model Benefits:**
- ✅ User deposits once, Suiftly auto-charges (no repeated wallet popups)
- ✅ On-chain monthly spending limit (smart contract enforced)
- ✅ User can withdraw remaining balance anytime (except $50 minimum if service active)
- ✅ Proactive frontend validation (no failed save attempts)
- ✅ Clear UX (always shows exact amount needed, one-click top-up buttons)
- ✅ Transparent (all deposits/withdrawals linked to on-chain TX hashes)

**MVP Asset Strategy:**
- **USDC Only:** Simplifies MVP implementation (no rate oracle needed)
- **1:1 Peg:** Direct USD value mapping (100 USDC = $100 USD balance)
- **No Volatility Risk:** Stablecoin eliminates exchange rate concerns
- **Future-Proof:** Database schema supports multi-asset expansion (SUI, USDT, etc.)

**Protection for Both Parties:**
- **User Protected:** Monthly spending cap (on-chain), USDC stablecoin (no volatility), proactive validation, can withdraw full balance anytime
- **Suiftly Protected:** Automatic service suspension on insufficient balance, pre-charge validation, automatic resume on deposit

**Ready for Implementation:** Smart contract interface defined (USDC-based), database schema specified (multi-asset ready), frontend validation logic provided, user flows documented with detailed scenarios.
