# Escrow Account Design Specification

## Overview

Suiftly uses a **per-user shared object** escrow model where each user has their own Suiftly Escrow Account (shared object) that holds their USDC tokens. Both the user and Suiftly have capabilities to operate on this account, enabling Suiftly to auto-charge for services without requiring repeated wallet signatures while maintaining user control.

**Key Principle:** User deposits once → Suiftly auto-charges for services → User can withdraw remaining balance anytime.

**Initial Asset:** For MVP launch, **only USDC** is accepted as the escrow deposit asset. SUI and other tokens may be added in future phases.

**Note:** Escrow is one of multiple payment providers (alongside Stripe and PayPal). See [PAYMENT_DESIGN.md](./PAYMENT_DESIGN.md) for the multi-provider abstraction. This document covers the escrow-specific on-chain design and UX flows.

**Related:** [PAYMENT_DESIGN.md](./PAYMENT_DESIGN.md), [BILLING_DESIGN.md](./BILLING_DESIGN.md), [CUSTOMER_SERVICE_SCHEMA.md](./CUSTOMER_SERVICE_SCHEMA.md)

**Architecture Highlights:**
- **Per-user isolation:** Each user has their own shared Account object (no centralized user list)
- **Dual capabilities:** Both Suiftly and user can operate on the shared object
- **Optional tracking:** User-owned tracking object for convenience (recoverable if lost)
- **Non-revocable:** Capabilities cannot be revoked (escrow semantics require both parties to have permanent access)

---

## Architecture

### Escrow Model

```
┌─────────────────────────────────────────────────────┐
│  User Wallet (Sui)                                  │
│  - User controls private keys                       │
│  - Owns tracking object (optional, for convenience)│
│  - Signs deposits/withdrawals only                  │
│  - Has capability on shared Account object          │
└──────────────────┬──────────────────────────────────┘
                   │
                   │ Deposit USDC (blockchain TX)
                   ↓
┌─────────────────────────────────────────────────────┐
│  Suiftly Escrow Account (Shared Object, Per-User)  │
│  - Holds USDC tokens for THIS user (MVP: USDC only)│
│  - Tracks account activities                        │
│  - Enforces 28-day spending limit (rolling period)  │
│  - Grants capability to BOTH:                       │
│    • User address (deposits/withdrawals/set limit)  │
│    • Suiftly address (charges/credits only)         │
│  - Capabilities are NON-REVOCABLE (escrow semantics)│
└──────────────────┬──────────────────────────────────┘
                   │
                   │ Charge events
                   ↓
┌─────────────────────────────────────────────────────┐
│  Suiftly Backend Database (Off-Chain)              │
│  - Tracks USD balance per user (redundant)         │
│  - Stores shared_account_address for each user     │
│  - Records all charges/credits                     │
│  - Suspends service when balance insufficient      │
│  - Validates before applying charges               │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│  Tracking Object (Owned by User, Optional)         │
│  - Points to user's shared Account object          │
│  - Used by webapp for convenience                  │
│  - Does NOT grant capabilities itself              │
│  - If lost/deleted: User still has access via      │
│    capabilities in shared Account object           │
│  - Can be recovered via:                           │
│    • Suiftly backend DB (tracks account address)   │
│    • On-chain analysis                             │
└─────────────────────────────────────────────────────┘
```

### Key Components

1. **Sui Blockchain (On-Chain)**
   - **Shared Account object (per user):** Holds USDC tokens (MVP: USDC only)
   - **Dual capabilities:** User + Suiftly (non-revocable)
   - **Spending limit enforcement:** 28-day rolling period per-account (simple, no drift)
   - **Tracking object (owned):** Optional convenience object pointing to shared Account
   - **No centralized contract:** Each user has isolated Account object
   - Logs all deposits/withdrawals with TX hashes

2. **Suiftly Backend (Off-Chain)**
   - PostgreSQL database tracks USD balances (redundant to on-chain)
   - Stores `shared_account_address` for each user (discovery/recovery)
   - For MVP: Direct USD value from USDC (1:1 peg)
   - Future: Rate oracle for SUI and other non-stablecoin assets
   - Applies charges automatically (no blockchain TX needed for charges)
   - Validates balance and limits before charging

3. **User Wallet (Sui)**
   - Owns tracking object (optional, for webapp convenience)
   - Has capability to operate on shared Account object
   - **User controls:** Deposits (USDC), withdrawals, spending limit changes
   - **User does NOT control:** Service charges, credits (Suiftly-only capability)

### Discovery & Recovery

**Three-tier discovery model for finding user's shared Account object:**

1. **Primary:** Tracking object in user's wallet
   - Webapp reads tracking object → gets shared Account address
   - Fast, direct lookup

2. **Secondary:** Suiftly backend database
   - If tracking object lost/deleted
   - Webapp queries backend API → gets `shared_account_address`
   - User authenticated via wallet signature

3. **Tertiary:** On-chain analysis
   - Query blockchain for Account objects with user's capability
   - Worst case recovery mechanism
   - Not used in normal operation

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

### User-Configurable 28-Day Spending Limit

**Smart contract enforces a 28-day spending cap to protect users from bugs, exploits, or excessive billing.**

**Values (see [CONSTANTS.md](./CONSTANTS.md) for authoritative source):**
- Default: **$250 per 28-day period**
- Minimum: **$10**
- Maximum: **Unlimited** (no cap)
- User-adjustable via Settings (requires wallet signature)
- Enforced by smart contract (Suiftly backend cannot override)

**Rolling Period Model:**
- Tracks spending over rolling 28-day periods from account creation timestamp
- Resets automatically every 28 days (exact timestamp arithmetic: 2,419,200,000 milliseconds)
- Smart contract uses `current_period_start_ms` field to track period start
- Off-chain database field `current_month_start` tracks current period for convenience
- Example: Account created Jan 15 → Period 1: Jan 15 - Feb 11, Period 2: Feb 12 - Mar 11, etc.

**Behavior When Limit Reached:**
- Additional charges blocked by smart contract
- User notified: "28-day spending limit reached ($X). Service changes available on [next period start date], or increase limit in Settings."
- Current services continue running (only NEW charges blocked)

**Changing the Limit:**
- User navigates to Settings → Spending Limit
- Enters new limit (validated: ≥$10, or "unlimited")
- Clicks "Update Limit" → Wallet signature requested
- Blockchain transaction updates escrow contract config
- Activity log: "28-day spending limit changed: $250 → $1,000"

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
- Frontend checks balance and 28-day limit BEFORE allowing save
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

### Flow 1: First Deposit (Create Account Objects)

```
1. User connects wallet (JWT issued)
   ↓
2. User clicks "Top Up" in header
   ↓
3. Webapp checks: Does user have Account object?
   - Checks for tracking object in wallet
   - If not found → checks backend DB for shared_account_address
   - Result: No Account object exists (first deposit)
   ↓
4. Modal: "Create Escrow Account & Deposit" (first-time only)

   Set 28-Day Spending Limit: [$ 250 ]

   ⓘ This protects your escrow account from excessive charges.
     Your limit resets every 28 days. You can change this anytime.
     Minimum: $10

   Suggested:
   • $250/28 days - Default (see CONSTANTS.md)
   • $1,000/28 days - Heavy usage / multiple services

   Initial Deposit Amount (USD): [$ 100 ]

   Required USDC: 100 USDC
   (USDC is a USD stablecoin: 1 USDC ≈ $1)

   [Create Account & Deposit]
   ↓
5. User clicks "Create Account & Deposit"
   ↓
6. Wallet signature requested (blockchain TX: create_account_and_deposit)
   ↓
7. Blockchain TX creates TWO objects:
   - Shared Account object (holds 100 USDC, spending limit $250)
   - Tracking object (owned by user, points to Account)
   ↓
8. TX submitted → Shows "Creating escrow account... (TX: 0xabc123...)"
   ↓
9. Backend monitors: 0 → 1 → 2 → 3 confirmations (~3-5 sec)
   ↓
10. After 3 confirmations → TX finalized
    ↓
11. Backend detects AccountCreated event:
    - Stores shared_account_address in database (`customers.escrow_contract_id`)
    - Credits $100 USD to balance in database
    ↓
12. Balance updates in UI: $0 → $100
    ↓
13. Toast: "Escrow account created. +$100.00 deposited."
    ↓
14. Activity log: "Account created, initial deposit: +$100.00 (100 USDC) - TX: 0xabc123..."
```

**Note:** Once Account created, Suiftly can auto-charge for services without requiring additional wallet signatures.

**Objects created:**
- **Shared Account object:** Accessible by both user and Suiftly (dual capabilities)
- **Tracking object:** Owned by user, used by webapp to find Account address

---

### Flow 2: Enable Service (Auto-Charge from Escrow)

> **Implementation note:** This flow describes the UX from the user's perspective. The actual backend charge flow creates a PENDING invoice and processes it through `processInvoicePayment()` which applies credits first, then tries payment providers in the user's priority order. If escrow is the active provider, `EscrowPaymentProvider` calls `ISuiService.charge()` (an on-chain TX). See [PAYMENT_DESIGN.md](./PAYMENT_DESIGN.md) for the provider chain and [BILLING_DESIGN.md](./BILLING_DESIGN.md) for invoice lifecycle.

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
   - Payment method check: escrow configured ✓
   - Balance check: $100 > $30 ✓
   - 28-day limit check: $0 + $30 = $30 < $250 ✓
   - Result: "Enable Service" button ENABLED
   ↓
4. User clicks "Enable Service"
   ↓
5. API call: POST /api/services.updateConfig
   ↓
6. Backend creates PENDING invoice → processInvoicePayment() →
   provider chain charges escrow via on-chain TX
   ↓
7. Balance decremented on-chain and in database: $100 → $70
   ↓
8. Frontend receives success response
   ↓
9. UI updates:
    - Balance: $100 → $70
    - Service page: Onboarding form → Tab view (Config/Keys/Stats/Logs)
    - Sidebar: Seal service shows 🟢 green dot
    ↓
10. Toast: "Seal service enabled. $30 charged from escrow balance."
    ↓
11. Activity log: "Service enabled - Pro tier - Charged $30 (pro-rated)"
```

**Key Point:** No wallet signature required for the charge. Escrow model allows backend to deduct automatically via `ISuiService.charge()`.

---

### Flow 3: Config Change (Insufficient Balance - Proactively Blocked)

> **Implementation note:** This flow applies when escrow is the user's primary (or only) payment method. If the user has other payment methods configured (Stripe, PayPal), the balance check is less restrictive — the provider chain will try fallback methods at charge time. See [PAYMENT_DESIGN.md](./PAYMENT_DESIGN.md).

```
User balance: $15
28-day period spent: $50
28-day limit: $250
Active service: Seal (Pro tier, $40/month)
Payment method: escrow only (no fallback)

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
   - 28-day limit check: $50 + $15 = $65 < $250 ✓
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
13. Config updated, $25 charged via provider chain
    ↓
14. Toast: "Configuration updated. $25 charged from escrow balance."
```

**Key Point:** Change blocked upfront if insufficient balance and no fallback payment method. Current service continues without interruption.

---

### Flow 4: Config Change (Would Exceed 28-Day Limit - Blocked)

> **Note:** The 28-day spending limit is an escrow-specific safety mechanism (`customers.spending_limit_usd_cents`). It applies to escrow charges only, not to Stripe/PayPal. See [PAYMENT_DESIGN.md](./PAYMENT_DESIGN.md) for the full payment flow.

```
User balance: $500
28-day period spent: $195
28-day limit: $250

1. User on Keys tab, clicks "Add Seal Key" 15 times
   ↓
2. Live pricing: "+$75/month (15 keys × $5)"
   ↓
3. Frontend validates:
   - Balance check: $500 > $75 ✓
   - 28-day limit check: $195 + $75 = $270 > $250 ❌
   ↓
4. "Save Changes" button DISABLED
   ↓
5. Error banner:
   "⚠ Cannot save - Would exceed 28-day spending limit

   Your 28-day limit: $250
   Spent this period: $195
   This change: +$75
   Total: $270 (exceeds by $20)

   Options:
   - Reduce to max 11 keys ($55, within limit)
   - Increase 28-day limit in Settings
   - Wait X days for spending period reset

   [Increase 28-Day Limit] [Adjust to 11 Keys]"
   ↓
6. User clicks "Adjust to 11 Keys"
   ↓
7. Number of keys reduced to 11
   ↓
8. Live pricing: "+$55/month"
   ↓
9. Frontend validates:
   - 28-day limit check: $195 + $55 = $250 ✓ (at limit but not over)
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
2. Webapp finds user's Account object:
   - Reads tracking object → gets shared_account_address
   - (If tracking object lost → queries backend DB)
   ↓
3. Modal: "Withdraw Funds from Escrow"

   Total balance: $127.50
   Amount (USD): [$ 50 ]

   Will receive: 50 USDC
   (USDC is a USD stablecoin: 1 USDC ≈ $1)

   ⓘ Note: You have active services ($60/month).
     Low balance may cause service suspension at next charge.

   [Withdraw]
   ↓
4. User clicks "Withdraw"
   ↓
5. Wallet signature requested (blockchain TX: withdraw from shared Account)
   ↓
6. TX submitted → "Pending confirmation... (TX: 0xdef456...)"
   ↓
7. Backend monitors confirmations (3 required)
   ↓
8. After 3 confirmations → Shared Account object releases 50 USDC to user wallet
   ↓
9. Backend decrements USD balance: $127.50 → $77.50
   ↓
10. Modal closes
    ↓
11. Toast: "Withdrawal successful. -$50.00 (50 USDC sent to your wallet)"
    ↓
12. Activity log: "Withdrawal: -$50.00 (50 USDC) - TX: 0xdef456..."
```

**Note:** User can withdraw full balance. If balance becomes insufficient for charges, service automatically moves to "suspended" state.

**Discovery:** Webapp uses tracking object (or backend DB if tracking lost) to find user's shared Account address.

---

### Flow 6: Running Out of Funds (Active Service)

> **Implementation note:** With multi-provider payments, escrow running low doesn't necessarily cause suspension. If the user has other payment methods (Stripe, PayPal) configured as fallback, the provider chain will try those first. Suspension only occurs when ALL payment methods fail. See [PAYMENT_DESIGN.md](./PAYMENT_DESIGN.md).

**Scenario: Escrow is the only payment method**

```
Service active: Seal ($60/month)
Balance drops over time: $75 → $35 → $10 → $0
Payment method: escrow only (no fallback)

Timeline:
Day 1 (balance $35):
  → Warning toast: "Low balance: $35 remaining. Top up to avoid service suspension."

Day 5 (balance $10):
  → Warning banner on all pages: "⚠ Low Balance ($10). Service will be suspended when balance is insufficient for next charge. [Top Up Now]"

Day 8 (charge attempt fails - all providers exhausted):
  → Service enters grace period / suspension:
    - Banner: "⚠ Payment Failed. Add funds or configure another payment method."
    - API requests return 402 Payment Required
    - No new charges applied during suspension

User deposits $100:
  → Periodic check triggered on deposit
  → Provider chain retries → escrow charge succeeds
  → Service automatically resumes:
    - Toast: "Service resumed. Payment successful."
    - Charge applied for current period
```

**Automatic Resume:** Service automatically resumes when payment succeeds (checked on deposit and periodic billing cycles). No manual intervention required.

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

### Object Definitions (Sui Move)

**Shared Account Object (per user, shared):**
```move
/// Suiftly Escrow Account - holds USDC and tracks spending
/// Shared object with dual capabilities (user + Suiftly)
struct Account has key {
    id: UID,
    user_address: address,           // User's wallet address (has capability)
    suiftly_address: address,        // Suiftly backend address (has capability)
    balance_usdc: Balance<USDC>,     // Actual USDC tokens (MVP: USDC only)
    spending_limit_usd_cents: u64,   // See CONSTANTS.md (e.g., 25000 = $250 default, 1000 = $10 minimum)
    current_period_charged_usd_cents: u64,  // Charged this 28-day period
    current_period_start_ms: u64,    // Timestamp when current 28-day period started (account creation or last reset)
    upgraded_to: Option<address>,    // If upgraded, points to new Account object
}
```

**Tracking Object (owned by user):**
```move
/// User-owned object for tracking their shared Account
/// Does NOT grant capabilities - just convenience pointer
struct AccountTracker has key, store {
    id: UID,
    account_address: address,  // Points to user's shared Account object
    account_type: String,      // Type name of Account (for upgrades, if Sui supports)
}
```

**Events:**
```move
/// Emitted when new Account created (for discovery)
struct AccountCreated has copy, drop {
    account_id: ID,
    user_address: address,
    tracker_id: ID,  // Tracking object ID
}

/// Emitted when Account upgraded
struct AccountUpgraded has copy, drop {
    old_account_id: ID,
    new_account_id: ID,
    user_address: address,
}
```

### Contract Functions (Sui Move)

**Account Creation (first deposit):**
```move
/// Create new Account and tracking object on first deposit
/// Called by user during initial deposit
public entry fun create_account_and_deposit(
    payment: Coin<USDC>,
    spending_limit_usd_cents: u64,
    suiftly_address: address,  // Suiftly's backend address (gets capability)
    clock: &Clock,
    ctx: &mut TxContext
) {
    let user_address = tx_context::sender(ctx);

    // Create shared Account object
    let account = Account {
        id: object::new(ctx),
        user_address,
        suiftly_address,
        balance_usdc: coin::into_balance(payment),
        spending_limit_usd_cents,
        current_period_charged_usd_cents: 0,
        current_period_start_ms: clock::timestamp_ms(clock),  // Period starts at account creation
        upgraded_to: option::none(),
    };

    let account_id = object::id(&account);
    let account_address = object::id_to_address(&account_id);

    // Create tracking object (owned by user)
    let tracker = AccountTracker {
        id: object::new(ctx),
        account_address,
        account_type: type_name::get<Account>().into_string(),
    };

    let tracker_id = object::id(&tracker);

    // Emit event for discovery
    event::emit(AccountCreated {
        account_id,
        user_address,
        tracker_id,
    });

    // Share the Account object (accessible by both user and Suiftly via capabilities)
    share_object(account);

    // Transfer tracking object to user
    transfer::transfer(tracker, user_address);
}
```

**User-Callable Operations (require user signature):**
```move
/// Deposit USDC to shared Account (MVP: USDC only)
/// User must sign this transaction
public entry fun deposit(
    account: &mut Account,
    payment: Coin<USDC>,
    ctx: &TxContext
) {
    // Verify caller is the user
    assert!(tx_context::sender(ctx) == account.user_address, E_NOT_AUTHORIZED);

    let deposit_amount = coin::value(&payment);
    balance::join(&mut account.balance_usdc, coin::into_balance(payment));

    // Emit deposit event
    event::emit(DepositEvent { account_id: object::id(account), amount: deposit_amount });
}

/// Withdraw USDC from shared Account
/// User must sign this transaction
public entry fun withdraw(
    account: &mut Account,
    amount: u64,
    ctx: &mut TxContext
) {
    // Verify caller is the user
    assert!(tx_context::sender(ctx) == account.user_address, E_NOT_AUTHORIZED);

    // Check sufficient balance
    assert!(balance::value(&account.balance_usdc) >= amount, E_INSUFFICIENT_BALANCE);

    // Withdraw
    let withdrawn = coin::take(&mut account.balance_usdc, amount, ctx);
    transfer::public_transfer(withdrawn, account.user_address);

    // Emit withdrawal event
    event::emit(WithdrawalEvent { account_id: object::id(account), amount });
}

/// Set spending limit (28-day period)
/// User must sign this transaction
public entry fun set_spending_limit(
    account: &mut Account,
    new_limit_usd_cents: u64,
    ctx: &TxContext
) {
    // Verify caller is the user
    assert!(tx_context::sender(ctx) == account.user_address, E_NOT_AUTHORIZED);

    account.spending_limit_usd_cents = new_limit_usd_cents;

    // Emit limit change event
    event::emit(LimitChangedEvent {
        account_id: object::id(account),
        new_limit: new_limit_usd_cents,
    });
}
```

**Suiftly-Callable Operations (require Suiftly signature):**
```move
/// Charge user for service (enforces 28-day spending limit)
/// Called by Suiftly backend (must be signed by suiftly_address)
/// Returns true if charge succeeded, false if would exceed limit
public fun charge(
    account: &mut Account,
    amount_usd_cents: u64,
    clock: &Clock,
    ctx: &TxContext
): bool {
    // Verify caller is Suiftly
    assert!(tx_context::sender(ctx) == account.suiftly_address, E_NOT_AUTHORIZED);

    // Check if charge would exceed 28-day spending limit
    if (!can_charge(account, amount_usd_cents, clock)) {
        return false
    };

    // Note: This is an off-chain charge (balance tracked in DB)
    // Just update period spending counter
    update_period_spending(account, amount_usd_cents, clock);

    // Emit charge event
    event::emit(ChargeEvent {
        account_id: object::id(account),
        amount: amount_usd_cents,
    });

    true
}

/// Credit user (refund)
/// Called by Suiftly backend
public fun credit(
    account: &mut Account,
    amount_usd_cents: u64,
    ctx: &TxContext
) {
    // Verify caller is Suiftly
    assert!(tx_context::sender(ctx) == account.suiftly_address, E_NOT_AUTHORIZED);

    // Note: This is an off-chain credit (balance tracked in DB)
    // Could decrease period spending if within same period
    // (implementation details depend on refund policy)

    // Emit credit event
    event::emit(CreditEvent {
        account_id: object::id(account),
        amount: amount_usd_cents,
    });
}
```

**28-Day Period Limit Enforcement Logic:**
```move
const PERIOD_DURATION_MS: u64 = 2419200000;  // 28 days * 24 hours * 60 min * 60 sec * 1000 ms

/// Check if charge would exceed 28-day spending limit
fun can_charge(account: &Account, amount_usd_cents: u64, clock: &Clock): bool {
    let now_ms = clock::timestamp_ms(clock);
    let elapsed_ms = now_ms - account.current_period_start_ms;

    // Check if 28-day period has elapsed
    let charged_this_period = if (elapsed_ms >= PERIOD_DURATION_MS) {
        0  // New period, counter resets
    } else {
        account.current_period_charged_usd_cents
    };

    // Check if new charge would exceed limit (0 means unlimited)
    if (account.spending_limit_usd_cents == 0) {
        return true  // Unlimited
    };

    charged_this_period + amount_usd_cents <= account.spending_limit_usd_cents
}

/// Update period spending counter (resets every 28 days)
fun update_period_spending(account: &mut Account, amount: u64, clock: &Clock) {
    let now_ms = clock::timestamp_ms(clock);
    let elapsed_ms = now_ms - account.current_period_start_ms;

    // Reset if 28-day period has elapsed
    if (elapsed_ms >= PERIOD_DURATION_MS) {
        // Start new period (aligned to current time, not exact 28-day boundary)
        account.current_period_start_ms = now_ms;
        account.current_period_charged_usd_cents = amount;
    } else {
        account.current_period_charged_usd_cents = account.current_period_charged_usd_cents + amount;
    };
}
```

**Notes:**
- For MVP, `balance_usdc` represents both token balance and USD value (1:1 peg)
- Capabilities are implicit in the address checks (user_address, suiftly_address)
- No centralized admin capability - each Account has its own dual authorization
- Tracking object is optional - if lost, user can still access Account via capabilities
- Future versions supporting SUI/other assets will require additional fields and conversion logic

---

## Object Lifecycle Management

### Creation (First Deposit)

**When:** User makes their first deposit to Suiftly escrow

**What happens:**
1. User calls `create_account_and_deposit()` with:
   - USDC payment (initial deposit)
   - 28-day spending limit
   - Suiftly backend address (hardcoded in webapp config)

2. Smart contract creates TWO objects:
   - **Shared Account object** (holds USDC, grants capabilities to user + Suiftly)
   - **Tracking object** (owned by user, points to Account)

3. `AccountCreated` event emitted (for discovery/indexing)

4. Backend monitors event → stores account address in database (`customers.escrow_contract_id`)

**Result:** User has isolated Account object with dual capabilities (non-revocable)

### Normal Operations

**Deposit/Withdrawal:**
- User signs transaction → operates on shared Account object
- Backend monitors blockchain → updates database balance
- Tracking object used by webapp to find Account address

**Charge/Credit:**
- Backend signs transaction using `suiftly_address` private key
- Operates on shared Account object → enforces 28-day limit
- Off-chain balance tracked in database (no USDC transfer for charges)

**If tracking object lost:**
- Webapp queries backend API → gets `shared_account_address`
- User still has full access via capabilities in Account object
- Optional: User can recreate tracking object (webapp feature)

### Upgrade Path

**When:** Smart contract needs upgrade (new features, bug fixes, terms changes)

**Mechanism:**
1. New contract version deployed with `upgrade_account()` function

2. User triggers upgrade (automatic on next deposit/withdrawal):
   - Webapp detects old Account version
   - Prompts: "Accept updated terms to continue" (one-click)
   - User approves → calls `upgrade_account()`

3. `upgrade_account()` does:
   - Creates new Account object (new contract version)
   - Transfers USDC balance from old to new Account
   - Sets `old_account.upgraded_to = new_account_address` (audit trail)
   - Updates tracking object to point to new Account (if provided)
   - Emits `AccountUpgraded` event

4. Backend monitors event → updates account address in database (`customers.escrow_contract_id`)

**Result:** User migrated to new contract version, old Account preserved for audit trail

**User experience:**
- Transparent (one-click approval)
- Piggybacks on normal operation (deposit/withdrawal)
- Old Account object remains on-chain (permanent record)

### Cleanup Policy

**Never clean up Account objects.**

**Rationale:**
- Permanent audit trail (all historical Account objects remain queryable)
- Old objects point to new objects (`upgraded_to` field)
- Blockchain storage is cheap enough for permanent records
- Enables forensic analysis if disputes arise

**Dormant accounts:**
- No automatic cleanup
- If user withdraws full balance → Account remains (balance = 0)
- Can be re-used (user deposits again → same Account object)

---

## Backend Database Schema

**Source of truth:** `packages/database/src/schema/` (Drizzle ORM definitions). See [CUSTOMER_SERVICE_SCHEMA.md](./CUSTOMER_SERVICE_SCHEMA.md) for schema file reference.

### Key Fields for Escrow Operations

**Escrow-specific fields on `customers` table** (`schema/customers.ts`):
- `escrow_contract_id` — On-chain address of user's shared Account object (set once by `findOrCreateCustomerWithEscrow()`, immutable after)
- `current_balance_usd_cents` — Escrow balance synced from blockchain
- `spending_limit_usd_cents` — 28-day spending cap (user-configurable on-chain)
- `current_period_charged_usd_cents` — Amount charged this 28-day period
- `current_period_start` — Start of current spending period

**`escrow_transactions` table** (`schema/escrow.ts`):
- Records on-chain charge/credit transactions with `tx_digest` (32-byte bytea)
- Referenced by `invoice_payments.escrow_transaction_id` for payment tracking
- Created by `EscrowPaymentProvider.charge()` — see [PAYMENT_DESIGN.md](./PAYMENT_DESIGN.md)

**`billing_idempotency` table** (`schema/billing.ts`):
- Prevents double-billing for the same operation
- Keyed by `idempotency_key` + `customer_id`

---

## Frontend Implementation

### State Management (Zustand Store)

```typescript
interface EscrowStore {
  // Balance
  balanceUsd: number  // USD balance (e.g., 127.50)

  // Spending limit (28-day period)
  spendingLimitUsd: number  // e.g., 250
  periodSpentUsd: number  // Current 28-day period (e.g., 180)

  // Validation helpers
  canAfford: (costUsd: number) => boolean
  wouldExceedLimit: (costUsd: number) => boolean
  calculateMaxAffordable: (unitCostUsd: number) => number

  // Actions
  deposit: (amountUsd: number) => Promise<void>
  withdraw: (amountUsd: number) => Promise<void>
  setSpendingLimit: (newLimitUsd: number) => Promise<void>
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

// Check if charge would exceed spending limit (28-day period)
function wouldExceedLimit(
  periodSpentUsd: number,
  spendingLimitUsd: number,
  costUsd: number
): boolean {
  return (periodSpentUsd + costUsd) > spendingLimitUsd
}

// Calculate maximum units affordable within limits
function calculateMaxAffordable(
  balanceUsd: number,
  periodSpentUsd: number,
  spendingLimitUsd: number,
  unitCostUsd: number
): number {
  const maxByBalance = Math.floor(balanceUsd / unitCostUsd)
  const remainingInPeriod = spendingLimitUsd - periodSpentUsd
  const maxByLimit = Math.floor(remainingInPeriod / unitCostUsd)

  return Math.min(maxByBalance, maxByLimit)
}
```

---

## Security Considerations

### Smart Contract Security

1. **Access Control (Dual Capability Model)**
   - Only user (user_address) can: Deposit, withdraw, set 28-day spending limit
   - Only Suiftly backend (suiftly_address) can: Charge, credit
   - **No centralized admin capability** - each Account has its own authorization
   - Capabilities are **non-revocable** (escrow semantics require both parties)
   - Address verification enforced in smart contract functions

2. **Reentrancy Protection**
   - Use Sui Move's resource model (linear types)
   - No external calls during balance mutations
   - Shared object locking prevents concurrent mutations

3. **28-Day Spending Limit Enforcement**
   - Enforced at smart contract level (backend cannot override)
   - Rolling 28-day period from account creation (no drift, exact timestamp arithmetic)
   - Guarantees at most one monthly bill per period (Suiftly bills on 1st of each month)
   - All charges logged on-chain via events for transparency
   - User can change limit anytime (requires wallet signature)

4. **Per-User Isolation**
   - Each user has independent shared Account object
   - No centralized list of users (eliminates single point of attack)
   - Compromise of one Account does not affect others
   - Backend compromise cannot drain arbitrary accounts (requires suiftly_address private key per transaction)

5. **Capability Management**
   - Suiftly backend private key for `suiftly_address` stored in secrets (env var)
   - Key used to sign charge/credit transactions
   - Rotate periodically (90 days recommended)
   - Never exposed to frontend or API responses

### Backend Security

1. **Idempotency for Financial Operations**
   - All mutating billing endpoints (deposit, charge, credit, withdrawal) require `idempotency_key` header
   - Backend stores idempotency keys with their responses in database
   - Duplicate requests with same key return original response (prevents double-charges)
   - Keys expire after 24 hours
   - Frontend generates: `crypto.randomUUID()` for each operation

   Table: `billing_idempotency` (see `packages/database/src/schema/billing.ts`)

   Cleanup: Periodic billing job removes keys older than 24 hours.

2. **Balance Validation**
   - Always check balance BEFORE applying charge
   - Use database transactions (BEGIN/COMMIT) for balance updates
   - Prevent negative balances (constraint: balance_usd_cents >= 0)
   - Reconcile database balance with on-chain Account balance periodically

3. **Rate Limiting**
   - Limit deposit/withdrawal requests (5 per hour per user)
   - Limit config changes (2 per hour per user)
   - Prevent rapid account creation (fraud detection)

4. **Audit Logging**
   - All escrow transactions immutable (INSERT only, no UPDATE/DELETE)
   - Log includes: customer ID, action, amount, timestamp, TX hash, idempotency key
   - Account creation events logged (`AccountCreated`, `AccountUpgraded`)

5. **Discovery/Recovery Security**
   - `escrow_contract_id` in database protected by auth (JWT validation)
   - Tracking object is convenience only (loss doesn't compromise security)
   - Three-tier discovery ensures users can always recover access
   - On-chain events provide independent verification of account ownership

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

**Would Exceed 28-Day Limit:**
```
Banner: "⚠ Cannot save - Would exceed 28-day spending limit"

Your 28-day limit: $250
Spent this period: $195
This change: +$75
Total: $270 (exceeds by $20)

Options:
- Reduce to max 11 keys ($55, within limit)
- Increase 28-day limit in Settings

[Increase 28-Day Limit] [Adjust to 11 Keys]
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

**28-Day Spending Limit Exceeded:**
```typescript
class SpendingLimitExceededError extends Error {
  constructor(
    public limit: number,
    public spent: number,
    public attemptedCharge: number
  ) {
    super(`28-day spending limit exceeded: ${spent} + ${attemptedCharge} > ${limit}`)
  }
}
```

---

## Monitoring & Alerting

### Metrics to Track

1. **Escrow Health (Per-Account Reconciliation)**
   - For each user: Compare on-chain Account balance vs. database balance
   - Query shared Account object → read `balance_usdc` field
   - Compare to `customers.balance_usd_cents` in database
   - Discrepancies → Alert (potential reconciliation issue for specific account)
   - **No global sum needed** - each Account is isolated

2. **Aggregate Monitoring**
   - Total USDC across all user Accounts (sum of on-chain balances)
   - Should match sum of all database balances
   - Used for overall system health, not required for correctness

3. **Deposit/Withdrawal Success Rate**
   - Track failed transactions
   - Alert if failure rate > 5%

4. **Low Balance Users**
   - Count users with balance < 1 month estimate
   - Proactive outreach to prevent service pauses

5. **28-Day Spending Limit Hit Rate**
   - Track how often users hit their 28-day spending limit
   - May indicate limits are too low or usage spikes

6. **Account Discovery Health**
   - Monitor `shared_account_address` field population
   - Alert if `AccountCreated` events not being indexed properly
   - Ensures discovery/recovery mechanism works

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

2. **28-Day Spending Limit Validation**
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

3. **28-Day Spending Limit Path**
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

**Shared Object Architecture Benefits:**
- ✅ **Decentralized:** Per-user Account objects (no centralized user list)
- ✅ **Dual capabilities:** User and Suiftly both have access (non-revocable escrow semantics)
- ✅ **Isolated:** Each Account is independent (compromise of one doesn't affect others)
- ✅ **Recoverable:** Three-tier discovery model (tracking object, backend DB, on-chain analysis)
- ✅ **Upgradeable:** Migration path preserves audit trail (old objects remain on-chain)

**Escrow Model Benefits:**
- ✅ User deposits once, Suiftly auto-charges (no repeated wallet popups)
- ✅ On-chain 28-day spending limit (smart contract enforced per-account, simple implementation)
- ✅ Rolling period guarantees at most one monthly bill per limit cycle
- ✅ User can withdraw remaining balance anytime
- ✅ Proactive frontend validation (no failed save attempts)
- ✅ Clear UX (always shows exact amount needed, one-click top-up buttons)
- ✅ Transparent (all deposits/withdrawals linked to on-chain TX hashes)

**MVP Asset Strategy:**
- **USDC Only:** Simplifies MVP implementation (no rate oracle needed)
- **1:1 Peg:** Direct USD value mapping (100 USDC = $100 USD balance)
- **No Volatility Risk:** Stablecoin eliminates exchange rate concerns
- **Future-Proof:** Database schema supports multi-asset expansion (SUI, USDT, etc.)

**Protection for Both Parties:**
- **User Protected:** 28-day spending cap (on-chain, simple enforcement), USDC stablecoin (no volatility), proactive validation, can withdraw full balance anytime, capabilities non-revocable (escrow security)
- **Suiftly Protected:** Automatic service suspension on insufficient balance, pre-charge validation, automatic resume on deposit, capabilities non-revocable (escrow security)

**Ready for Implementation:**
- Smart contract interface defined (shared Account + tracking objects)
- Dual capability model specified (user_address + suiftly_address)
- Database schema specified (includes shared_account_address for discovery)
- Object lifecycle documented (creation, operations, upgrade, no cleanup)
- Frontend validation logic provided
- User flows documented with detailed scenarios
- Discovery/recovery mechanisms specified
