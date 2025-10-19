# UI Design Specification

## Overview

Customer-facing platform for Suiftly infrastructure services with a Cloudflare-inspired UX.

**Related Documents:**
- **[AUTHENTICATION_DESIGN.md](./AUTHENTICATION_DESIGN.md)** - Complete authentication architecture, wallet signature flow, and JWT session management
- **[ESCROW_DESIGN.md](./ESCROW_DESIGN.md)** - Complete escrow account architecture, smart contract interface, and financial flows

**Design Principles:**
- Clean, professional interface (Cloudflare/Vercel-like)
- Self-service configuration (no sales calls needed)
- Transparent pricing (see costs before enabling)
- Immediate feedback (real-time price calculations)
- Data-driven (stats and logs for observability)

**Target Audience:**
- Web3 developers
- Blockchain infrastructure operators
- Teams building on Sui blockchain

---

## Site Architecture

### Two Separate Properties

**Landing Site: `https://suiftly.io`**
- Static marketing site (SEO-optimized)
- Technologies: Plain HTML/CSS or Astro (keep it simple)
- Purpose: Explain services, pricing, drive signups
- CTA: "Launch App" button → redirects to `app.suiftly.io`

**Dashboard App: `https://app.suiftly.io`**
- React SPA (Vite + React 19)
- Authenticated only (wallet-based)
- Purpose: Service configuration, monitoring, billing

---

## Landing Site (suiftly.io)

**Simple marketing site - not the focus of this project.**

### Page Sections

1. **Hero Section**
   - Headline: "Sui Blockchain Infrastructure, Simplified"
   - Subheadline: "Self-service Seal, gRPC, and GraphQL endpoints. Pay only for what you use."
   - CTA Button: "Launch App" (large, prominent)
   - Optional: Live stats (e.g., "Serving 12M requests/day")

2. **Services Overview**
   - Three cards: Seal, gRPC, GraphQL
   - Each card: Icon, name, 1-sentence description
   - Link to docs (if available)

3. **Pricing Section**
   - Transparent pricing table
   - Usage-based model (requests, bandwidth, etc.)
   - Calculator or example costs
   - Note: "No minimums, no contracts"

4. **Footer**
   - Links: Docs, Status, GitHub, Support
   - Social links
   - Legal: Terms, Privacy

**Implementation Note:**
- Can be added later (focus on app first)
- Initial MVP: Simple single-page HTML with "Launch App" button
- Or: Skip entirely and just use `app.suiftly.io` for everything

---

## App Architecture (app.suiftly.io)

### Layout Structure

```
┌─────────────────────────────────────────────────────┐
│ Header: Logo | [Wallet Widget] | User Menu          │
├─────────────┬───────────────────────────────────────┤
│             │                                       │
│  Sidebar    │         Main Content Area             │
│             │                                       │
│  - Seal     │                                       │
│  - gRPC     │                                       │
│  - GraphQL  │                                       │
│  ─────────  │                                       │
│  - Billing  │                                       │
│  - Support  │                                       │
│             │                                       │
└─────────────┴───────────────────────────────────────┘
```

**Persistent Components:**
- Header (always visible)
- Sidebar (collapsible on mobile)
- Wallet Widget (in header, expandable)

---

## Authentication & Session Flow

**Wallet-based authentication with JWT sessions.**

See **[AUTHENTICATION_DESIGN.md](./AUTHENTICATION_DESIGN.md)** for complete architecture, implementation details, and security considerations.

### Summary

**Authentication Method:**
- Wallet connection via `@mysten/dapp-kit` (auto-reconnects on return visits)
- Challenge-response signature proves wallet ownership
- JWT stored in httpOnly cookie for session management (4-hour expiry)

**User Experience:**
- **First access:** Connect wallet → Sign once → Authenticated for 4 hours
- **Subsequent requests:** No signatures needed (JWT handles authorization)
- **Transactions:** Wallet signature required (blockchain operations only)
- **Session expiry:** Sign again after 4 hours or on expiration warning

**Key Principle:** Users can explore the entire dashboard WITHOUT connecting wallet (Cloudflare-style). Wallet connection only required when enabling services or accessing protected data (API keys, billing).

### First-Time User Flow (No Wallet Connection)

1. User visits `app.suiftly.io`
2. **Immediately sees dashboard** (no auth wall)
   - Full sidebar navigation visible
   - All service pages accessible
   - Pricing calculator works
   - Stats/Logs tabs show placeholder states
   - **"Demo Mode" banner appears at top of every page/tab** (dismissible, reappears on page reload)
3. Header shows: **[Connect Wallet]** button (top-right, prominent)
4. User can explore freely:
   - Navigate to Seal/gRPC/GraphQL pages
   - Adjust config options and see live pricing
   - Read tooltips and help text
   - View Support page, FAQ
   - All pages/tabs show "Demo Mode" banner
   - Everything works EXCEPT "Enable Service" toggle (requires wallet - see toggle behavior below)

### Wallet Connection Trigger

**Wallet connection required when:**
- User toggles "Enable Service" switch (first attempt to activate)
- User tries to view existing service config (if they have one)
- User clicks wallet balance/deposit/withdraw
- User clicks "Add New API Key"
- User clicks "Add New Seal Key"
- User clicks "Add Package to this Seal Key"
- User attempts to edit/delete keys or packages

**Connection Flow:**
1. User toggles "Enable Service" switch (without wallet connected)
2. Modal appears:
   ```
   ┌──────────────────────────────────────┐
   │  Connect Wallet Required             │
   │                                      │
   │  To enable services, please connect  │
   │  your Sui wallet.                    │
   │                                      │
   │  [Connect Wallet]  [Cancel]          │
   └──────────────────────────────────────┘
   ```
3. Click "Connect Wallet" → Sui wallet popup (or dev mock)
4. User approves connection + signs challenge message
5. Backend verifies signature → issues JWT
6. Modal closes → "Enable Service" toggle completes automatically (switches to ON)
7. Header updates: Shows wallet address + balance

### Returning User (With Wallet)

1. User visits `app.suiftly.io`
2. If valid JWT in localStorage → auto-connect wallet
3. Header shows wallet address + balance (connected state)
4. Service pages show actual configs (if any exist)
5. If expired JWT → Shows as disconnected, can reconnect anytime

### Header States

**Not Connected (Default for new visitors):**
```
┌────────────────────────────────────────┐
│ [Logo] Suiftly     [Connect Wallet]  󰅂 │
└────────────────────────────────────────┘
```

**Connected:**
```
┌─────────────────────────────────────────────┐
│ [Logo] Suiftly  [󰇃 $127.50 ▼]  [0x1a2...]   │
└─────────────────────────────────────────────┘
```

### Development Mock

```typescript
// For development only (no real wallet needed)
if (import.meta.env.DEV) {
  // Header shows both options:
  // [Connect Wallet] or [Use Mock Wallet]

  // Mock wallet:
  // - Auto-connects as test user (0xtest123...)
  // - Skips signature verification
  // - Shows $1000 balance
  // - "Enable Service" works instantly
}
```

---

## Demo Mode Banner

**Purpose:** Indicates to users that they're exploring without a connected wallet.

**Appearance:**
```
┌──────────────────────────────────────────────────────┐
│ ⓘ Demo Mode - Connect wallet to enable services  [✕] │
└──────────────────────────────────────────────────────┘
```

**Design:**
- **Background:** Light info color (rgba(47, 123, 191, 0.1) - Cloudflare Marine tint)
- **Border:** 1px solid info color (#2F7BBF - Cloudflare Marine)
- **Text:** "Demo Mode - Connect wallet to enable services"
- **Icon:** Info icon (ⓘ) on left
- **Dismiss button:** [✕] on right
- **Position:** Top of content area (below header, above main content)
- **Width:** Full width of content area
- **Padding:** 12px vertical, 16px horizontal

**Behavior:**
- Appears on ALL pages and tabs when wallet is NOT connected
- Dismissible via [✕] button
- Dismissed state stored in sessionStorage (persists only during current browser session)
- On page reload: banner reappears if wallet still not connected (sessionStorage cleared on tab close)
- On wallet connect: banner disappears permanently (until disconnect)
- Does not appear when wallet is connected
- Clicking anywhere on banner (except [✕]) can optionally trigger "Connect Wallet" modal

**Pages/Tabs where banner appears:**
- Seal service configuration form and all tabs (Configuration, Keys, Stats, Logs)
- Coming soon pages (gRPC, GraphQL) - optional, may not be needed for placeholder pages
- Billing page
- Support page (optional - could skip here)

**CSS Example:**
```css
.demo-mode-banner {
  background: rgba(47, 123, 191, 0.1);
  border: 1px solid #2F7BBF;
  border-radius: 3px;
  padding: 12px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24px;
  font-size: 0.86667rem; /* Cloudflare sm */
  color: #2F7BBF;
}

.demo-mode-banner__content {
  display: flex;
  align-items: center;
  gap: 8px;
}

.demo-mode-banner__dismiss {
  cursor: pointer;
  padding: 4px;
  opacity: 0.7;
}

.demo-mode-banner__dismiss:hover {
  opacity: 1;
}
```

---

## Sidebar Navigation

### Structure

```
┌─────────────────┐
│ Services        │
├─────────────────┤
│ 󰤄 Seal          │  ← Icon + label
│ 󰖟 gRPC          │
│ 󰘦 GraphQL       │
│                 │
│ ─────────────   │  ← Divider
│                 │
│ 󰵀 Billing       │
│ 󰋗 Support       │
└─────────────────┘
```

**Behavior:**
- Active page highlighted (background color change)
- Click → navigate to service page
- Each service shows status indicator (dot):
  - 🟢 Green = Active (enabled and running)
  - 🔵 Blue = Configured but disabled
  - ⚪ Gray = Not configured yet
- Collapsible on mobile (hamburger menu)

**Initial State (New User):**
- All services show gray dot (not configured)
- Billing shows "—" (no usage yet)
- Support always visible (no status indicator)

### Page 4: Settings (Spending Limits)

**URL:** `/settings/spending-limits`

**Purpose:** Manage on-chain escrow spending protections.

**Wallet Required:** Yes

```
┌──────────────────────────────────────────────────────┐
│ Settings → Spending Limit                            │
├──────────────────────────────────────────────────────┤
│                                                       │
│  Monthly Spending Limit (On-Chain Protection)        │
│                                                       │
│  ⓘ This limit protects your escrow account from     │
│     excessive charges. Changes require wallet         │
│     signature to update the smart contract.           │
│                                                       │
│  Current Limit: $2,000 per month (30-day window)     │
│                                                       │
│  [━━━━━━━━━━━━━━━━━━━] $680 / $2,000               │
│  This month: $680 (34%) - Resets in 12 days          │
│                                                       │
│  Recent charges:                                      │
│  • Jan 9: Service enabled - $60                       │
│  • Jan 15: Tier upgrade - $20                         │
│  • Jan 18: Added 10 API keys - $10                    │
│  • Jan 28: Monthly usage fees - $590                  │
│                                                       │
│  [ Change Limit ]                                     │
│                                                       │
│  ─────────────────────────────────────                │
│                                                       │
│  Withdrawal Protection                                │
│                                                       │
│  ⓘ Minimum balance required while services active:  │
│     $50.00 (prevents accidental service interruption) │
│                                                       │
│  Active services: 1 (Seal)                            │
│  Current balance: $127.50                             │
│  Available to withdraw: $77.50                        │
│                                                       │
│  [ Withdraw Funds ]                                   │
│                                                       │
└──────────────────────────────────────────────────────┘
```

**Change Spending Limit Modal:**
```
┌──────────────────────────────────────────────────────┐
│ Change Monthly Spending Limit                        │
├──────────────────────────────────────────────────────┤
│                                                       │
│  Current limit: $2,000 per month                      │
│  Spent this month: $680                               │
│                                                       │
│  New limit: [$ 5000  ]  (min: $100, max: $50,000)    │
│                                                       │
│  Suggested:                                           │
│  • $500/month  - Single service (Starter/Pro)        │
│  • $2,000/month - Default (most users)               │
│  • $5,000/month - Heavy usage / multiple services    │
│                                                       │
│  ⓘ This change requires a wallet signature to       │
│     update the on-chain escrow contract.              │
│                                                       │
│  [ Update Limit ]  [ Cancel ]                         │
│                                                       │
└──────────────────────────────────────────────────────┘
```

**Interactions:**
- Clicking [Change Limit] opens modal
- User enters new value (validated: min $100, max $50,000)
- Clicking "Update Limit" triggers wallet signature request
- On-chain transaction updates escrow contract config
- Toast: "Monthly spending limit updated: $5,000"
- Activity log: "Monthly spending limit changed: $2,000 → $5,000"

**Tooltip:**
- **Monthly Limit:** "Maximum Suiftly can charge in any 30-day rolling window. Protects your escrow from excessive billing."

---

## Page Layouts

### Page 1: Service Pages (Seal / gRPC / GraphQL)

**URL Pattern:** `/services/seal`, `/services/grpc`, `/services/graphql`

Each service page has **two states:**
1. **Not Configured State** (onboarding)
2. **Configured State** (active service with tabs)

**Note:** For MVP, only the Seal service is fully implemented with configuration. gRPC and GraphQL show "coming soon" placeholders (see [docs/COMING_SOON_PAGE.md](../docs/COMING_SOON_PAGE.md)).

---

#### State 1: Not Configured (Onboarding)

**Full-page configuration form with live pricing.**

**When wallet NOT connected:**
- Shows "Demo Mode" banner at top with "Connect wallet to enable services" message
- All tabs visible (Config, Keys, Stats, Logs) with placeholder data
- Enable Service toggle disabled until wallet connects

```
┌──────────────────────────────────────────────────────┐
│ Seal Configuration                                    │
├──────────────────────────────────────────────────────┤
│ ⓘ Demo Mode - Connect wallet to enable services  [✕] │
├──────────────────────────────────────────────────────┤
│                                                       │
│  ✓ Always Included:                                  │
│    • Global geo-steering and failover (closest       │
│      key-server automatically selected)              │
│    • Auto-failover / retry for high-availability     │
│                                                       │
│  ─────────────────────────────────────────           │
│                                                       │
│  Guaranteed Bandwidth (?)                             │
│                                                       │
│  ┌────────────────────────────────────────┐          │
│  │ STARTER                                │          │
│  ├────────────────────────────────────────┤          │
│  │ 100 req/s per region • ~300 req/s globally       │
│  │ $20/month                              │          │
│  └────────────────────────────────────────┘          │
│                                                       │
│  ┌────────────────────────────────────────┐          │
│  │ PRO                         [SELECTED] │          │ ← Badge
│  ├────────────────────────────────────────┤          │
│ ┃│ 500 req/s per region • ~1,500 req/s globally    │┃│ ← Thick border
│ ┃│ $40/month                              │┃│
│  └────────────────────────────────────────┘          │
│                                                       │
│  ┌────────────────────────────────────────┐          │
│  │ BUSINESS                               │          │
│  ├────────────────────────────────────────┤          │
│  │ 2,000 req/s per region • ~6,000 req/s globally   │
│  │ $80/month                              │          │
│  └────────────────────────────────────────┘          │
│                                                       │
│  Burst (?)                                            │
│  [ ] Enable burst (available for Pro and Business)   │
│                                                       │
│  Packages Per Seal Key (?)                            │
│  [ 3 ]  (comes with 3, +$1/month per additional)     │
│                                                       │
│  Additional API Keys (?)                              │
│  [ 1 ]  (comes with 1, +$1/month per additional)     │
│                                                       │
│  Additional Seal Keys (?)                             │
│  [ 1 ]  (comes with 1, +$5/month per additional)     │
│                                                       │
│  ┌──────────────────────────────────────────┐        │
│  │ Total Monthly Fee           $XX.00       │        │
│  └──────────────────────────────────────────┘        │
│                                                       │
│  Usage Fees (metered, billed separately):            │
│  • Requests: $1.00 per 10,000 requests (all tiers)  │
│                                                       │
│  Enable Service                         [OFF] ⟳ ON   │
│                                                       │
└──────────────────────────────────────────────────────┘
```

**Behavior:**
- **Live price calculation:** As user changes options, "Total Monthly Fee" updates in real-time (using `useMemo()`)
- **Usage fees:** Listed below monthly fee (metered separately, not included)
- **Tooltips (?):** Click to show explanation for each field
- **"Enable Service" toggle switch:**
  - **No wallet connected:** Triggering toggle prompts "Connect Wallet" modal → After connection, service enables automatically (toggle switches to ON)
  - **Wallet connected:** Toggle validates form and enables service immediately (switches to ON)
  - **Service already provisioned:** Form is replaced with server-side state (shows configured view with tabs)
- **Server state precedence:** If service exists in DB, page shows configured state instead of onboarding form

**Form Fields (All Services):**

**0. Always Included Features (Top of Form)**
   - Type: Informational banner (not interactive)
   - Content:
     - "Global geo-steering and failover (closest key-server automatically selected)"
     - "Auto-failover / retry for high-availability"
   - Style: Light background, checkmark icon, non-dismissible
   - Purpose: Show value included with all tiers

**1. Guaranteed Bandwidth (?) - Tier Selection**
   - Type: **Horizontal card blocks** (stacked vertically, full-width)
   - Layout: Three stacked cards (full-width on all screen sizes)
   - Interaction: Click entire card to select
   - Each card shows:
     - **Header row:** Tier name (left) + "SELECTED" badge (right, when selected)
     - **Content row:** Capacity info on one line: "X req/s per region • ~Y req/s globally"
     - **Footer row:** Monthly price "$Z/month"

   **Selection States:**
   - **Default:** 1px solid border (gray-200)
   - **Hover:** 2px solid border (gray-400) + subtle cursor change
   - **Selected:**
     - 3px solid border (primary color: #f38020 orange)
     - "SELECTED" badge appears (top-right, pill-shaped, primary color background)
     - Optional: Subtle background tint (rgba(243, 128, 32, 0.05))

   - Tooltip: "Choose your guaranteed bandwidth tier. We operate in 3 regions (US-East, US-West, EU-Frankfurt), so global capacity is approximately 3× per-region capacity."

   **Tier Details:**
   - **Starter:** 100 req/s per region, ~300 req/s globally, $20/mo
   - **Pro:** 1,000 req/s per region, ~3,000 req/s globally, $40/mo
   - **Enterprise:** Custom capacity, contact sales

   **Responsive:**
   - Desktop: Full-width cards, 3px padding between cards
   - Mobile: Same layout (works perfectly, no changes needed)

2. **Burst (?)**
   - Type: Checkbox
   - Enabled only for Pro and Enterprise tiers (disabled for Starter)
   - Tooltip: "Allow temporary traffic bursts beyond guaranteed bandwidth. Additional charges apply for burst usage."
   - Pricing: +$10/month (only if enabled)

3. **Packages Per Seal Key (?)**
   - Type: Number input (starts at 3)
   - Default: 3 (included with all tiers)
   - Tooltip: "Number of packages per Seal key for organizing your services. Packages are children of seal keys. Each additional package costs $1/month per seal key."
   - Pricing: For each seal key: max(0, packagesPerSealKey - 3) × $1/month
     - **Example:** If you have 2 seal keys and set packagesPerSealKey to 5:
       - Seal Key 1: (5-3) × $1 = $2/month
       - Seal Key 2: (5-3) × $1 = $2/month
       - Total additional packages cost: $4/month
   - Note: When you create a new seal key, it comes with this many packages

4. **Total API Keys (?)**
   - Type: Number input (starts at 1, min: 1)
   - Default: 1 (included with all tiers)
   - Label: "Total API Keys (1 included)"
   - Tooltip: "API keys for authenticating requests. You get 1 free, each additional key costs $1/month."
   - Pricing: max(0, totalApiKeys - 1) × $1/month
   - UI: Number input with decrement disabled at 1, increment button increases count

5. **Total Seal Keys (?)**
   - Type: Number input (starts at 1, min: 1)
   - Default: 1 (included with all tiers)
   - Label: "Total Seal Keys (1 included)"
   - Tooltip: "Seal-specific keys for cryptographic operations. You get 1 free, each additional key costs $5/month."
   - Pricing: max(0, totalSealKeys - 1) × $5/month
   - UI: Number input with decrement disabled at 1, increment button increases count

**Pricing Display:**
- **Total Monthly Fee:** Total recurring monthly charge (all config options summed)
- **Usage Fees:** Bulleted list (metered separately, not included in monthly fee)
  - Requests: $1.00 per 10,000 requests (all tiers)

**Pricing Example (Pro tier, burst enabled, 5 packages per key, 2 total seal keys, 2 total API keys):**
```
Pro tier: $40/month
Burst enabled: $10/month
Total Seal Keys: 2 (1 included, 1 additional × $5) = $5/month
Packages per Seal key: 5 (3 included per key, 2 additional per key × $1)
  - Seal Key 1: (5-3) × $1 = $2/month
  - Seal Key 2: (5-3) × $1 = $2/month
  - Total: $4/month
Total API keys: 2 (1 included, 1 additional × $1) = $1/month
────────────────────────────────
Total Monthly Fee: $60/month
```

**Note:** When gRPC and GraphQL are implemented in the future, they will use the same configuration form and pricing model as Seal.

---

#### State 2: Configured (Active Service)

**Tab-based layout with read-only config.**

**When wallet disconnected:**
- Shows "Demo Mode" banner at top
- Config displayed as read-only (Edit button disabled)
- Enable Service toggle disabled
- Reconnect wallet to manage service

```
┌──────────────────────────────────────────────────────┐
│ Seal Service                     [Status: Active 🟢] │
├──────────────────────────────────────────────────────┤
│ ⓘ Demo Mode - Connect wallet to enable services  [✕] │
├──────────────────────────────────────────────────────┤
│                                                       │
│  [ Configuration ]  [ Keys ]  [ Stats ]  [ Logs ]    │  ← Tabs
│  ────────────────                                     │
│                                                       │
│  Current Configuration                      [Edit 󰏫] │  ← Read-only + Edit icon
│                                                       │
│  Guaranteed Bandwidth:     Business (2K req/s/region) │
│  Burst:                    Enabled                    │
│  Packages Per Seal Key:    5                          │
│  Additional API Keys:      2                          │
│  Additional Seal Keys:     1                          │
│                                                       │
│  ┌──────────────────────────────────────────┐        │
│  │ Total Monthly Fee           $93.00       │        │
│  └──────────────────────────────────────────┘        │
│                                                       │
│  Current Month Usage:                                 │
│  • Requests: 125,000 ($12.50)                        │
│                                                       │
│  Enable Service                         OFF ⟳ [ON]   │
│                                                       │
└──────────────────────────────────────────────────────┘
```

**Tab 1: Configuration (Default Active)**

- **Read-only config display**
- **Edit button (pencil icon)** → Click to edit
  - Opens modal or inline form (same form as onboarding)
  - Shows current values pre-filled
  - Live price recalculation
  - "Save Changes" button → Updates config
  - Note: Config changes may cause charges/credits (handled later)
- **Current usage** (this billing period)
- **"Enable Service" toggle** (ON position) → Switch to OFF to disable service

**Tab 2: Keys**

```
┌──────────────────────────────────────────────────────┐
│  Keys & Packages                                      │
│                                                       │
│  API Keys (2 active)                                  │
│  ┌────────────────────────────────────────┐          │
│  │  key_abc123...  [Copy] [Revoke]       │          │
│  │  key_def456...  [Copy] [Revoke]       │          │
│  └────────────────────────────────────────┘          │
│                          [ Add New API Key ]         │
│                                                       │
│  Seal Keys & Packages (1 seal key)                    │
│  ┌────────────────────────────────────────┐          │
│  │  seal_xyz789...  [Copy] [Revoke] [▼]  │          │
│  │                                        │          │
│  │  Packages (5):                         │          │
│  │    • package-1  [Edit] [Delete]        │          │
│  │    • package-2  [Edit] [Delete]        │          │
│  │    • package-3  [Edit] [Delete]        │          │
│  │    • package-4  [Edit] [Delete]        │          │
│  │    • package-5  [Edit] [Delete]        │          │
│  │                                        │          │
│  │    [ Add Package to this Seal Key ]    │          │
│  └────────────────────────────────────────┘          │
│                         [ Add New Seal Key ]         │
│                                                       │
└──────────────────────────────────────────────────────┘
```

**Keys Tab (Before Service Enabled / Demo Mode):**
```
┌──────────────────────────────────────────────────────┐
│  Keys & Packages                                      │
├──────────────────────────────────────────────────────┤
│ ⓘ Demo Mode - Connect wallet to enable services  [✕] │
├──────────────────────────────────────────────────────┤
│                                                       │
│  ⓘ After enabling this service, you'll be able to:  │
│                                                       │
│  • Add and manage API keys                           │
│  • Add and manage Seal keys                          │
│  • Add packages to Seal keys for organization        │
│                                                       │
│  Enable the service from the Configuration tab       │
│  to access these features.                           │
│                                                       │
└──────────────────────────────────────────────────────┘
```

**Keys Tab Behavior (After Service Enabled):**
- **API Keys Section:**
  - List of active API keys (truncated display)
  - Copy button → Copies full key to clipboard
  - Revoke button → Disables key (confirmation required, requires wallet)
  - **"Add New API Key":**
    - If wallet not connected → Prompts "Connect Wallet" modal, then creates key after connection
    - If wallet connected → Creates new key (+$1/month), shows full key once (copy prompt)

- **Seal Keys & Packages Section:**
  - Each seal key has an expandable card ([▼] to collapse/expand)
  - **Seal Key actions:**
    - Copy → Copies full seal key to clipboard
    - Revoke → Disables seal key and all its packages (confirmation required, requires wallet)
  - **Packages (nested under each seal key):**
    - Packages are children of their parent seal key
    - Each package shows: name + [Edit] [Delete] actions
    - Edit → Rename package (requires wallet)
    - Delete → Remove package (confirmation if deleting would go below 3 total packages, requires wallet)
    - **"Add Package to this Seal Key":**
      - If wallet not connected → Prompts "Connect Wallet" modal, then creates package after connection
      - If wallet connected → Creates new package under this seal key (+$1/month)
  - **"Add New Seal Key":**
    - If wallet not connected → Prompts "Connect Wallet" modal, then creates seal key after connection
    - If wallet connected → Creates new seal key (+$5/month) with default 3 packages, appears as collapsed card

**Hierarchy:** Service → Seal Keys → Packages (each seal key owns its packages)

**Note:** Adding/deleting keys or packages updates monthly fee and triggers billing events.

### Key Lifecycle & Revocation Semantics

**Key Creation:**
- New keys generated server-side (secure random)
- Shown once in modal: "Copy this key now - it won't be shown again"
- **Security:** Raw key never stored - only bcrypt hash stored in database
- Billing adjustment applied immediately (pro-rated for current month)
- Logged in activity feed with timestamp

**Key Revocation:**
- **Effect Timing:** Immediate (no grace period)
- **Confirmation Required:** "Are you sure? This key will stop working immediately and cannot be recovered."
- **Impact on Traffic:** Requests using revoked key receive 401 Unauthorized
- **Billing:** Credit applied immediately (pro-rated for remaining month)
- **Audit Trail:** Logged with timestamp, key ID (last 4 chars), and revoking wallet address

**Key Rotation Best Practices (shown in tooltip/help):**
1. Create new key (+$1/month temporarily)
2. Update your applications to use new key
3. Test that new key works
4. Revoke old key (credit applied)
- **Recommended rotation:** Every 90 days or on security event

**Package Deletion:**
- Can delete packages down to minimum (3 per seal key)
- Deleting below 3 shows error: "Each seal key must have at least 3 packages"
- Deletion is immediate (no grace period)
- Credit applied pro-rated for remaining month

**Seal Key Revocation:**
- Revokes parent seal key AND all child packages
- Confirmation: "This will revoke the seal key and all {N} packages under it. Continue?"
- Immediate effect (401 on requests)
- Pro-rated credit for seal key + all packages

### Anti-Abuse & Rate Limiting (Key Operations)

**Rate Limits (Per Wallet Address):**
- **API Key Create/Revoke:** Max 5 operations per hour
- **Seal Key Create/Revoke:** Max 3 operations per hour
- **Package Add/Delete:** Max 10 operations per hour
- **Config Updates (billing changes):** Max 2 per hour

**Minimum Time Windows:**
- Cannot revoke a key within 5 minutes of creation (prevents accidental spam)
- Cannot change billing-impacting config more than twice per hour

**Abuse Detection & Throttling:**
- Backend monitors for rapid create/revoke cycles
- If detected: Throttle operations + show warning: "Too many changes. Please wait {minutes} before trying again."
- If repeated abuse: Temporary account lock (manual review required)

**Billing Implications:**
- All billing changes (add/remove keys, packages, config) are logged with wallet signature
- Prevents disputes: "You authorized this change at {timestamp}"
- Pro-rated charges/credits prevent gaming the system (e.g., rapid add/remove cycles)

**Tab 3: Stats**

```
┌──────────────────────────────────────────────────────┐
│  Stats                                                │
├──────────────────────────────────────────────────────┤
│ ⓘ Demo Mode - Connect wallet to enable services  [✕] │
├──────────────────────────────────────────────────────┤
│                                                       │
│  ⓘ Stats are updated hourly. Data appears after     │
│     24 hours of service activity.                    │
│                                                       │
│  Requests (Last 7 Days)                              │
│  ┌────────────────────────────────────────┐          │
│  │                                        │          │
│  │     [Empty graph placeholder]          │          │
│  │                                        │          │
│  └────────────────────────────────────────┘          │
│                                                       │
│  Bandwidth Usage (Last 7 Days)                       │
│  ┌────────────────────────────────────────┐          │
│  │                                        │          │
│  │     [Empty graph placeholder]          │          │
│  │                                        │          │
│  └────────────────────────────────────────┘          │
│                                                       │
│  Response Time (p50/p95/p99)                         │
│  ┌────────────────────────────────────────┐          │
│  │                                        │          │
│  │     [Empty graph placeholder]          │          │
│  │                                        │          │
│  └────────────────────────────────────────┘          │
│                                                       │
└──────────────────────────────────────────────────────┘
```

**Stats Tab Behavior:**
- **Always show graph placeholders** (even when empty)
- **Info banner:** "Stats updated hourly. Data appears after 24 hours."
- **Purpose:** Show users what observability they'll get
- **Graphs to show (empty initially):**
  - Requests over time (line chart)
  - Bandwidth usage (area chart)
  - Response times (multi-line: p50, p95, p99)
  - Optional: Error rate, geographic distribution

**Tab 4: Logs**

```
┌──────────────────────────────────────────────────────┐
│  Activity Log                                         │
├──────────────────────────────────────────────────────┤
│ ⓘ Demo Mode - Connect wallet to enable services  [✕] │
├──────────────────────────────────────────────────────┤
│                                                       │
│  ┌────────────────────────────────────────┐          │
│  │ Jan 9, 2025 14:23                      │          │
│  │ Service enabled                        │          │
│  │ Configuration: 2 endpoints, US-East    │          │
│  ├────────────────────────────────────────┤          │
│  │ Jan 9, 2025 14:25                      │          │
│  │ Charge: $45.00                         │          │
│  │ Monthly base fee for January           │          │
│  ├────────────────────────────────────────┤          │
│  │ Jan 10, 2025 09:15                     │          │
│  │ Configuration updated                  │          │
│  │ Changed: Endpoints 2 → 3               │          │
│  ├────────────────────────────────────────┤          │
│  │ Jan 10, 2025 09:15                     │          │
│  │ Charge: $10.00                         │          │
│  │ Pro-rated charge for additional endpoint│         │
│  └────────────────────────────────────────┘          │
│                                                       │
│                           [ Load More ]              │
│                                                       │
└──────────────────────────────────────────────────────┘
```

**Logs Tab Content:**
- **Configuration changes:** When user edits settings
- **Charges/Credits:** Billing events (monthly charges, pro-rated changes)
- **Service events:** Enabled/disabled, errors
- **Format:** Reverse chronological (newest first)
- **Pagination:** "Load More" button at bottom

**Note:** Logs are audit trail + transparency (users see exactly what they're charged for).

---

### Page 2: Support

**URL:** `/support`

**Purpose:** Help resources and contact information.

```
┌──────────────────────────────────────────────────────┐
│ Support                                               │
├──────────────────────────────────────────────────────┤
│                                                       │
│  Contact Us                                           │
│  ┌────────────────────────────────────────┐          │
│  │  Email: support@mhax.io                │          │
│  │  Response time: 24-48 hours            │          │
│  └────────────────────────────────────────┘          │
│                                                       │
│  Community                                            │
│  ┌────────────────────────────────────────┐          │
│  │  [Discord] Join our Discord server     │          │
│  │  Get help from the community           │          │
│  └────────────────────────────────────────┘          │
│                                                       │
│  Frequently Asked Questions                           │
│  ┌────────────────────────────────────────┐          │
│  │  ▶ How do I configure my first service?│          │
│  │  ▶ What is guaranteed bandwidth?       │          │
│  │  ▶ How does burst pricing work?        │          │
│  │  ▶ How do I generate additional keys?  │          │
│  │  ▶ What payment methods are supported? │          │
│  │  ▶ How do I cancel a service?          │          │
│  └────────────────────────────────────────┘          │
│                                                       │
└──────────────────────────────────────────────────────┘
```

**Sections:**

1. **Contact Us**
   - Email: `support@mhax.io` (clickable mailto link)
   - Expected response time
   - Optional: Add contact form later

2. **Community**
   - Discord invite button/link (will be defined later)
   - Brief description: "Get help from the community"

3. **Frequently Asked Questions**
   - Collapsible accordion (▶ expands to ▼)
   - Common questions with detailed answers
   - Examples:
     - How do I configure my first service?
     - What is guaranteed bandwidth?
     - How does burst pricing work?
     - How do I generate additional keys?
     - What payment methods are supported?
     - How do I cancel a service?
   - Can be expanded as needed

**Note:** Keep support page simple for MVP. Can add knowledge base, video tutorials, API docs later.

---

### Page 3: Billing

**URL:** `/billing`

**Purpose:** Consolidated view of all usage, charges, and wallet balance.

**Two States: Connected vs. Not Connected**

**State 1: Wallet Not Connected (Demo Mode)**
```
┌──────────────────────────────────────────────────────┐
│ Billing & Usage                                       │
├──────────────────────────────────────────────────────┤
│ ⓘ Demo Mode - Connect wallet to enable services  [✕] │
├──────────────────────────────────────────────────────┤
│                                                       │
│  ⓘ Connect your wallet to view billing information  │
│                                                       │
│  ┌────────────────────────────────────────┐          │
│  │                                        │          │
│  │     [Connect Wallet]                   │          │
│  │                                        │          │
│  │  Connect to view:                      │          │
│  │  • Wallet balance                      │          │
│  │  • Current month charges               │          │
│  │  • Usage details                       │          │
│  │  • Billing history                     │          │
│  │                                        │          │
│  └────────────────────────────────────────┘          │
│                                                       │
└──────────────────────────────────────────────────────┘
```

**State 2: Wallet Connected**
```
┌──────────────────────────────────────────────────────┐
│ Billing & Usage                                       │
├──────────────────────────────────────────────────────┤
│                                                       │
│  Wallet Balance                      $127.50         │
│  ┌────────────────────────────────────────┐          │
│  │  [ Top Up ]  [ Withdraw ]             │          │
│  └────────────────────────────────────────┘          │
│                                                       │
│  Current Month (January 2025)                         │
│  ┌────────────────────────────────────────┐          │
│  │  Seal Service              $46.25      │          │
│  │  gRPC Service              $12.00      │          │
│  │  GraphQL Service            $8.50      │          │
│  │  ─────────────────────────────────     │          │
│  │  Total                     $66.75      │          │
│  └────────────────────────────────────────┘          │
│                                                       │
│  Usage Details (Current Month)                        │
│  ┌────────────────────────────────────────┐          │
│  │  Service    │ Requests  │ Cost         │          │
│  ├────────────────────────────────────────┤          │
│  │  Seal       │ 125,000   │ $12.50       │          │
│  │  gRPC       │ 32,000    │ $3.20        │          │
│  │  GraphQL    │ 18,000    │ $1.80        │          │
│  └────────────────────────────────────────┘          │
│                                                       │
│  Billing History                                      │
│  ┌────────────────────────────────────────┐          │
│  │  Jan 1, 2025   Invoice #001   $66.75  │          │
│  │  Dec 1, 2024   Invoice #000   $54.20  │          │
│  │  ...                                   │          │
│  └────────────────────────────────────────┘          │
│                                                       │
└──────────────────────────────────────────────────────┘
```

**Sections:**

1. **Wallet Balance (Top)**
   - Current balance (large, prominent)
   - "Top Up" button → Opens wallet deposit modal
   - "Withdraw" button → Opens wallet withdrawal modal

2. **Current Month Summary**
   - Breakdown by service
   - Total charges
   - Note: Auto-charged from wallet balance

3. **Usage Details**
   - Table showing usage metrics per service
   - Current billing period (month-to-date)

4. **Billing History**
   - List of past invoices (monthly)
   - Click invoice → View detailed breakdown

**Wallet Integration:**
- Balance synced with Web3 wallet escrow
- Top-up → Deposit SUI tokens to escrow
- Withdraw → Release SUI tokens from escrow
- Auto-billing: Charges deducted from balance automatically

### Billing & Currency Model

**See [ESCROW_DESIGN.md](./ESCROW_DESIGN.md) for complete escrow account architecture, protections, and flows.**

**Summary:**

**Canonical Currency: USD (denominated), SUI (settled)**

All prices displayed in USD, but payments/deposits/withdrawals use SUI tokens on Sui blockchain.

**Key UX Elements (detailed flows in [ESCROW_DESIGN.md](./ESCROW_DESIGN.md)):**

- **Rate Display:** Always show SUI/USD rate with timestamp and source count
  - Example: "1 SUI = $2.45 (updated 47s ago, from 3 sources)"

- **Escrow Account Model:**
  - User deposits once → Suiftly auto-charges for services (no repeated signatures)
  - Balance shown in USD throughout UI
  - User can withdraw anytime (minimum $50 if services active)

- **Monthly Spending Limit (On-Chain):**
  - Default: $2,000/month (user-adjustable: $100-$50,000)
  - Enforced by smart contract
  - User sets limit on first deposit

- **Proactive Validation:**
  - Frontend validates balance + monthly limit in real-time
  - "Save Changes" button disabled if insufficient funds or would exceed limit
  - Clear error banners show exact problem and solution
  - No failed save attempts

- **Charging Behavior:**
  - Immediate: Service enable, tier changes, add keys/packages
  - Deferred: Usage fees (end of month)
  - Credits: Instant (revoke keys, tier downgrades)

- **Low Balance Warnings:**
  - Balance < estimate: Warning toast
  - Balance < $10: Warning banner on all pages
  - Balance = $0: Service paused, 7-day grace period

**See [ESCROW_DESIGN.md](./ESCROW_DESIGN.md) for:**
- Complete deposit/withdrawal flows
- Smart contract interface
- Database schema
- Ledger reconciliation details
- Security considerations
- Testing scenarios

---

## Header Components

### Wallet Widget (Persistent)

**Always visible in top-right of header.**

**State 1: Not Connected (Default for new users)**
```
┌────────────────────────────────────────┐
│  Logo  Suiftly      [Connect Wallet] 󰅂 │  ← Header
└────────────────────────────────────────┘
```
- Shows: "Connect Wallet" button (prominent, primary style)
- Click → Opens wallet connection modal
- No wallet address shown

**State 2: Connected**
```
┌─────────────────────────────────────────────┐
│  Logo  Suiftly  [󰇃 $127.50 ▼]  [0x1a2b...] │  ← Header
└─────────────────────────────────────────────┘
```
- Shows: Wallet icon + balance + truncated address
- Dropdown indicator on balance

**Wallet Dropdown (When Connected):**
Click balance to expand:
```
┌─────────────────────────────┐
│ Wallet Balance     $127.50  │
│ 0x1a2b3c4d5e...             │
├─────────────────────────────┤
│  [Top Up]    [Withdraw]     │
├─────────────────────────────┤
│  Recent Activity            │
│  • Jan 9: +$50.00 (deposit) │
│  • Jan 9: -$45.00 (Seal)    │
│  • Jan 8: -$12.00 (gRPC)    │
├─────────────────────────────┤
│  [Disconnect Wallet]        │
└─────────────────────────────┘
```

**Actions:**
- **Connect Wallet:** Opens wallet connection modal (Sui wallet)
- **Top Up:** Opens deposit modal (Web3 transaction) [requires connected wallet]
- **Withdraw:** Opens withdrawal modal (Web3 transaction) [requires connected wallet]
- **Disconnect Wallet:** Calls logout endpoint (clears httpOnly cookie), clears auth state, header returns to "Connect Wallet" button
- **Recent Activity:** Last 5 transactions (link to full billing page)

**Disconnect Behavior:**
1. User clicks "Disconnect Wallet" in dropdown
2. Confirmation prompt: "Disconnect wallet? You'll need to reconnect to manage services."
3. If confirmed:
   - Call `/api/auth/logout` (clears httpOnly cookie)
   - Clear client-side auth state (wallet address, balance, etc.)
   - Header shows "Connect Wallet" button again
   - Service pages remain accessible (exploration mode)
   - Configured services show in read-only mode (can't edit without reconnecting)
4. Toast: "Wallet disconnected"

**Development Mock:**
- Show "Connect Wallet" OR "Use Mock Wallet" button
- Mock wallet: Hardcoded address (0xMOCK123...), balance: $1000.00
- Top-up/withdraw shows success toast (no real transaction)

---

## Key User Flows

### Flow 1: Onboarding (First-Time User - No Wallet)

```
1. Visit app.suiftly.io
   ↓
2. Dashboard loads immediately (no auth wall)
   ↓
3. Header shows: [Connect Wallet] button (top-right)
   ↓
4. User sees sidebar: Seal, gRPC, GraphQL, Billing, Support
   ↓
5. Navigate to /services/seal (default or via sidebar)
   ↓
6. See configuration form (onboarding state)
   ↓
7. User adjusts options (tier, burst, keys) → sees live pricing
   ↓
8. Click tooltips (?) to learn about each field
   ↓
9. User explores other services (gRPC, GraphQL) → same experience
   ↓
10. User decides to enable Seal service
    ↓
11. Click "Enable Service"
    ↓
12. Modal appears: "Connect Wallet Required"
    ↓
13. Click "Connect Wallet" in modal
    ↓
14. Wallet popup → Approve + Sign
    ↓
15. Wallet connected → Header updates (shows address + balance)
    ↓
16. Modal closes → Service enabled automatically
    ↓
17. Service page transitions to tab view (Config/Keys/Stats/Logs)
    ↓
18. Sidebar shows Seal with 🟢 green dot
    ↓
19. Toast: "Seal service enabled! $XX.XX charged."
```

**Exploration Mode (No Wallet):**
- All pages accessible
- Pricing calculator works
- Tooltips functional
- Stats/Logs show empty states
- "Enable Service" button visible but requires wallet connection

**Onboarding Tips:**
- Optional tooltip tour on first visit
- After enabling first service, show toast: "Service enabled! Configure more services or view your billing."
- Gentle reminder: "Connect wallet to enable services" (dismissible banner, top of page)

---

### Flow 2: Configure First Service (With Wallet Prompt)

```
1. User on /services/seal (not configured, wallet not connected)
   ↓
2. Configuration form visible (all fields interactive)
   ↓
3. Select tier: Pro
   ↓
4. Enable burst: checked
   ↓
5. Adjust additional packages: 5
   ↓
6. See Monthly Fee update: $63.00 (live calculation)
   ↓
7. Click tooltips (?) to learn about fields
   ↓
8. Review usage fees (listed below)
   ↓
9. Click "Enable Service"
   ↓
10. Modal appears: "Connect Wallet Required"
    ↓
11. Click "Connect Wallet" in modal
    ↓
12. Sui wallet popup → Approve + Sign
    ↓
13. Modal shows "Verifying signature..." spinner
    ↓
14. Backend verifies signature → JWT issued → Modal updates
    ↓
15. Modal shows "Enabling service..." with spinner
    ↓
16. Validation (Zod schema)
    ↓
17. API call: POST /api/services.updateConfig
    ↓
18. Success → Config saved → Modal closes → Tabs appear
    ↓
19. Wallet charged: $63.00 (pro-rated for current month)
    ↓
20. Toast: "Seal service enabled. $63.00 charged."
    ↓
21. Header shows wallet address + balance
```

---

### Flow 3: Edit Existing Service Configuration

```
1. User on /services/seal (configured state)
   ↓
2. Click [Edit 󰏫] icon (top-right of config)
   ↓
3. Modal opens with current config pre-filled
   ↓
4. Change tier: Starter ($20) → Pro ($40)
   ↓
5. See new Monthly Estimate: $40.00
   ↓
6. See note: "You'll be charged $X.XX (pro-rated) immediately from your escrow balance"
   ↓
7. Check balance sufficient (if not, show error: "Insufficient balance. Top up required.")
   ↓
8. Click "Save Changes"
   ↓
9. API call: PATCH /api/services.updateConfig
   ↓
10. Backend validates balance → Calculates pro-rated charge
    ↓
11. Success → Charge auto-deducted from escrow balance (no wallet signature needed)
    ↓
12. Config updated → Modal closes
    ↓
13. Balance decremented: $127.50 → $117.50 (example: $10 pro-rated charge)
    ↓
14. Logs tab shows new entry: "Configuration updated - Pro tier enabled - Charged $10.00 (pro-rated)"
    ↓
15. Toast: "Configuration updated. $10.00 charged from escrow balance."
```

**Downgrade Example (Credit Applied):**
```
User changes tier: Pro ($40) → Starter ($20)
Pro-rated credit: +$X.XX added to escrow balance
Toast: "Configuration updated. $X.XX credit applied to your balance."
Balance shown increases immediately
User can withdraw credit at any time
```

**Note:** All charges/credits applied immediately via escrow model (no additional wallet signatures needed).

---

### Flow 4: Top-Up Wallet (Deposit to Escrow)

```
1. User clicks wallet widget in header
   ↓
2. Dropdown expands
   ↓
3. Click "Top Up"
   ↓
4. Modal opens: "Deposit Funds to Escrow"
   ↓
5. Enter amount: $100
   ↓
6. Shows conversion: "Deposit ~40.82 SUI to escrow (rate: 1 SUI = $2.45, from 3 sources, updated 23s ago)"
   ↓
7. Click "Deposit"
   ↓
8. Wallet popup → User approves blockchain transaction to Suiftly escrow contract
   ↓
9. Transaction submitted → Modal shows "Pending confirmation... (TX: 0xabc123...)"
   ↓
10. Backend monitors: 0 → 1 → 2 → 3 confirmations (~3-5 seconds)
    ↓
11. After 3 confirmations → Transaction finalized
    ↓
12. Backend credits USD balance in database (SUI now in escrow)
    ↓
13. Balance updates: $127.50 → $227.50
    ↓
14. Modal closes
    ↓
15. Toast: "Deposit successful. +$100.00 added to your escrow balance."
    ↓
16. Activity log entry: "Deposit: +$100.00 (40.82 SUI) - TX: 0xabc123..."
```

**Note:** Once deposited, Suiftly can auto-charge for services without requiring additional wallet signatures. User can withdraw remaining balance at any time.

**Development Mock:**
- Skip Web3 transaction
- Instantly update balance (fake)
- Show success toast

---

## Component Inventory

### Layout Components

| Component | Purpose | Location |
|-----------|---------|----------|
| `DashboardLayout` | Main layout wrapper (header + sidebar + content) | `components/layout/` |
| `Header` | Logo + wallet widget + user menu | `components/layout/` |
| `Sidebar` | Service navigation + billing link | `components/layout/` |
| `ServiceLayout` | Tab wrapper for service pages | `components/layout/` |
| `DemoModeBanner` | Info banner shown when wallet not connected | `components/layout/` |

### Wallet Components

| Component | Purpose | Location |
|-----------|---------|----------|
| `WalletWidget` | Balance display + dropdown | `components/wallet/` |
| `DepositModal` | Top-up funds modal | `components/wallet/` |
| `WithdrawModal` | Withdraw funds modal | `components/wallet/` |
| `WalletBalance` | Balance display (reusable) | `components/wallet/` |

### Service Components

| Component | Purpose | Location |
|-----------|---------|----------|
| `ServiceConfigForm` | Configuration form (onboarding) | `components/services/` |
| `ServiceConfigDisplay` | Read-only config view | `components/services/` |
| `ServiceTabs` | Tab navigation (Config/Keys/Stats/Logs) | `components/services/` |
| `PricingCalculator` | Live monthly fee calculator | `components/services/` |
| `UsageFeesList` | Enumerated usage fees | `components/services/` |
| `TierSelector` | Horizontal tier cards with selection state | `components/services/` |
| `TierCard` | Individual tier card (clickable, shows selection) | `components/services/` |
| `SelectedBadge` | "SELECTED" pill badge for tier cards | `components/services/` |
| `IncludedFeaturesBanner` | Always-included features info banner | `components/services/` |
| `TooltipField` | Form field with (?) tooltip | `components/services/` |

### Stats Components

| Component | Purpose | Location |
|-----------|---------|----------|
| `StatsPlaceholder` | Empty graph with title | `components/stats/` |
| `RequestsChart` | Requests over time (line chart) | `components/stats/` |
| `BandwidthChart` | Bandwidth usage (area chart) | `components/stats/` |
| `ResponseTimeChart` | Latency metrics (multi-line) | `components/stats/` |

### Billing Components

| Component | Purpose | Location |
|-----------|---------|----------|
| `BillingOverview` | Current month summary | `components/billing/` |
| `UsageTable` | Usage breakdown by service | `components/billing/` |
| `InvoiceList` | Past invoices | `components/billing/` |
| `InvoiceDetail` | Detailed invoice view | `components/billing/` |

### Keys Components

| Component | Purpose | Location |
|-----------|---------|----------|
| `KeysList` | Display API/Seal keys with actions | `components/keys/` |
| `KeyCard` | Individual key display (copy/revoke) | `components/keys/` |
| `AddKeyButton` | Add new key (shows modal) | `components/keys/` |
| `SealKeyCard` | Expandable seal key with nested packages | `components/keys/` |
| `PackagesList` | Manage packages nested under seal keys | `components/keys/` |
| `KeysPlaceholder` | Pre-enable info message | `components/keys/` |

### Support Components

| Component | Purpose | Location |
|-----------|---------|----------|
| `ContactCard` | Email contact info | `components/support/` |
| `FAQAccordion` | Collapsible FAQ items | `components/support/` |
| `CommunityLinks` | Discord invite, community links | `components/support/` |

### UI Components (shadcn/ui)

| Component | Usage |
|-----------|-------|
| `Button` | All buttons (primary/secondary/ghost) |
| `Card` | Config cards, pricing cards |
| `Modal` | Edit config, deposit/withdraw, add keys, "Connect Wallet Required" |
| `Tabs` | Service page tabs (Config/Keys/Stats/Logs) |
| `Table` | Usage table, invoice list |
| `Input` | Form fields (number inputs for keys/packages) |
| `RadioGroup` | Tier selection (Starter/Pro/Business) |
| `Checkbox` | Burst enable/disable |
| `Toast` | Success/error notifications |
| `Tooltip` | Help text for (?) icons |
| `Accordion` | FAQ items |

---

## Routing Structure

### Routes (TanStack Router)

```
/                              → Redirect to /services/seal (always, no auth required)

/services/seal                 → Seal service page (accessible without wallet)
/services/grpc                 → gRPC service page (accessible without wallet)
/services/graphql              → GraphQL service page (accessible without wallet)

/billing                       → Billing overview (shows $0 if no wallet connected)
/billing/invoices/:id          → Detailed invoice view (requires wallet)

/support                       → Support page (public, no wallet needed)

/settings                      → User settings (requires wallet)
/settings/spending-limits      → Configure on-chain spending caps
```

**Route Access:**
- **Public Routes (No wallet needed):**
  - All service pages (exploration mode)
  - Billing overview page (shows empty state)
  - Support page

- **Wallet-Required Actions:**
  - Enable/disable services
  - Edit service configs
  - Add/revoke keys
  - View invoice details
  - Top-up/withdraw wallet

- **No route-level authentication:** All pages load without wallet. Actions prompt connection when needed.

**Route State:**
- Service page state (configured vs. not configured) determined by API data
- Active tab state stored in URL params (e.g., `/services/seal?tab=stats`)

---

## Form Schemas (Zod)

### Service Config (Seal Service)

**For MVP, this schema applies to the Seal service only. Future services (gRPC, GraphQL) will use the same schema when implemented.**

```typescript
const serviceConfigSchema = z.object({
  guaranteedBandwidth: z.enum(['starter', 'pro', 'business']),
  burstEnabled: z.boolean(),
  packagesPerSealKey: z.number().min(3), // Comes with 3, can add more
  totalApiKeys: z.number().min(1),       // Total API keys (1 included)
  totalSealKeys: z.number().min(1),      // Total Seal keys (1 included)
}).refine((data) => {
  // Burst only available for Pro and Business
  if (data.burstEnabled && data.guaranteedBandwidth === 'starter') {
    return false
  }
  return true
}, {
  message: "Burst is only available for Pro and Enterprise tiers",
  path: ["burstEnabled"]
})
```

**Pricing Constants:**
```typescript
const PRICING = {
  tiers: {
    starter: { base: 20, reqPerSec: 100 },
    pro: { base: 40, reqPerSec: 500 },
    business: { base: 80, reqPerSec: 2000 },
  },
  burst: 10, // +$10/month if enabled
  additionalPackagePerKey: 1, // $1/month per package (after 3) per seal key
  additionalApiKey: 1, // $1/month per key (after 1)
  additionalSealKey: 5, // $5/month per key (after 1)
}

// Calculate monthly fee
function calculateMonthlyFee(config: ServiceConfig): number {
  let total = PRICING.tiers[config.guaranteedBandwidth].base

  if (config.burstEnabled) {
    total += PRICING.burst
  }

  // Additional API keys cost (1 included)
  total += Math.max(0, config.totalApiKeys - 1) * PRICING.additionalApiKey

  // Additional seal keys cost (1 included)
  total += Math.max(0, config.totalSealKeys - 1) * PRICING.additionalSealKey

  // Packages cost: per seal key, 3 included per key
  const additionalPackagesPerKey = Math.max(0, config.packagesPerSealKey - 3)
  total += additionalPackagesPerKey * config.totalSealKeys * PRICING.additionalPackagePerKey

  return total
}
```

**Note:** Pricing values in the code above are examples. Actual pricing defined in [SEAL_SERVICE_CONFIG.md](./SEAL_SERVICE_CONFIG.md#pricing-model). The implementation should import pricing constants from a shared configuration file.

---

## Responsive Design

### Breakpoints (Tailwind Defaults)

- `sm`: 640px (tablet)
- `md`: 768px (tablet landscape)
- `lg`: 1024px (desktop)
- `xl`: 1280px (large desktop)

### Mobile Behavior

**Sidebar:**
- Desktop: Always visible (left side)
- Mobile: Hidden by default, hamburger menu in header

**Tabs:**
- Desktop: Horizontal tabs
- Mobile: Dropdown or vertical tabs (depends on space)

**Forms:**
- Desktop: Wide forms with side-by-side fields
- Mobile: Stacked fields (full width)

**Tier Cards:**
- Desktop: Full-width horizontal cards (stacked)
- Mobile: Same layout (no changes needed, works perfectly)

**Tables:**
- Desktop: Full table
- Mobile: Card-based layout (stacked rows)

**Wallet Widget:**
- Desktop: Dropdown in header
- Mobile: Full-width modal (better UX)

---

## Design Tokens (Cloudflare-inspired)

**Based on Cloudflare's cf-ui design system with Suiftly branding.**

Source: [Cloudflare cf-ui Style Guide](https://cloudflare.github.io/cf-ui/)

Suiftly adapts Cloudflare's design system with the following changes:
- **Primary Color:** Suiftly orange (#f38020) instead of Cloudflare's Marine blue
- **Typography:** Same Open Sans font family
- **Spacing & Layout:** Cloudflare's 0.5rem base unit system
- **Colors:** Cloudflare's semantic palette (Marine, Grass, Apple, Tangerine) + Suiftly orange
- **Components:** Cloudflare-style cards, forms, buttons with Suiftly branding

### Colors

```javascript
colors: {
  // Primary Brand (Suiftly)
  primary: {
    DEFAULT: '#f38020',  // Suiftly orange (similar to Cloudflare's Tangerine #FF7900)
    hover: '#e67319',
    light: '#ff9747',
  },

  // Cloudflare-inspired Accent Colors
  marine: '#2F7BBF',     // Cloudflare's primary blue (for links, info)
  grass: '#9BCA3E',      // Success states
  apple: '#BD2527',      // Error states
  tangerine: '#FF7900',  // Original Cloudflare orange

  // Neutrals (Cloudflare palette)
  moonshine: '#F7F7F7',  // Light background
  dust: '#EBEBEB',       // Borders, dividers
  storm: '#808285',      // Muted text
  charcoal: '#333333',   // Primary text

  // Semantic Colors
  success: '#9BCA3E',    // Cloudflare Grass (active services)
  warning: '#FF7900',    // Cloudflare Tangerine
  error: '#BD2527',      // Cloudflare Apple
  info: '#2F7BBF',       // Cloudflare Marine

  // Grays (for cards, borders)
  gray: {
    50: '#F7F7F7',       // Moonshine
    100: '#EBEBEB',      // Dust
    200: '#dedede',      // Form borders
    300: '#c4c4c4',
    400: '#808285',      // Storm
    500: '#6b6b6b',
    600: '#4a4a4a',
    700: '#333333',      // Charcoal
    800: '#1a1a1a',
    900: '#0a0a0a',
  },

  // Backgrounds
  white: '#ffffff',
  black: '#0a0a0a',
}
```

### Typography (Cloudflare cf-ui)

```javascript
fontFamily: {
  sans: ['"Open Sans"', 'Helvetica', 'Arial', 'sans-serif'],  // Cloudflare's font
  mono: ['ui-monospace', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
}

fontSize: {
  xs: '0.73333rem',    // ~11px
  sm: '0.86667rem',    // ~13px (Cloudflare small)
  base: '1rem',        // 16px (Cloudflare normal)
  lg: '1.13333rem',    // ~17px
  xl: '1.33333rem',    // ~20px
  '2xl': '2rem',       // 32px (Cloudflare large)
  '3xl': '2.5rem',
  '4xl': '3rem',
}

fontWeight: {
  normal: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
}
```

### Spacing (Cloudflare cf-ui base unit: 0.5rem)

```javascript
spacing: {
  0: '0',
  0.5: '0.26667rem',   // Cloudflare XS
  1: '0.5rem',         // 8px (base unit)
  2: '1rem',           // 16px
  3: '1.5rem',         // 24px (Cloudflare card padding)
  4: '2rem',           // 32px
  5: '2.5rem',
  6: '3rem',           // 48px (page padding)
  8: '4rem',
  10: '5rem',
  12: '6rem',
}
```

### Border Radius (Cloudflare cf-ui)

```javascript
borderRadius: {
  none: '0',
  sm: '2px',           // Cloudflare small
  DEFAULT: '3px',      // Cloudflare medium
  md: '0.5rem',        // 8px (tier cards)
  lg: '0.75rem',       // 12px (modals)
  full: '9999px',      // Pills, badges
}
```

### Shadows (Subtle, Cloudflare-style)

```javascript
boxShadow: {
  sm: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
  DEFAULT: '0 2px 8px rgba(0, 0, 0, 0.1)',    // Card hover
  md: '0 4px 12px rgba(0, 0, 0, 0.15)',       // Modals
  lg: '0 8px 24px rgba(0, 0, 0, 0.2)',
}
```

### Tier Card Design Specifications

**Structure (Horizontal Cards):**
```tsx
<div className="tier-card" onClick={handleSelect}>
  {/* Header Row */}
  <div className="tier-header">
    <h3>STARTER</h3>
    {isSelected && <span className="badge">SELECTED</span>}
  </div>

  {/* Content Row */}
  <p className="tier-capacity">
    100 req/s per region • ~300 req/s globally
  </p>

  {/* Footer Row */}
  <p className="tier-price">$20/month</p>
</div>
```

**CSS Classes (Cloudflare-inspired):**
```css
.tier-card {
  border: 1px solid #EBEBEB; /* Cloudflare Dust */
  border-radius: 8px; /* Cloudflare md radius */
  padding: 24px; /* Cloudflare spacing-3 (1.5rem) */
  background: #ffffff;
  cursor: pointer;
  transition: all 0.2s ease;
  margin-bottom: 12px;
  font-family: "Open Sans", Helvetica, Arial, sans-serif; /* Cloudflare font */
}

.tier-card:hover {
  border: 2px solid #808285; /* Cloudflare Storm */
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1); /* Cloudflare default shadow */
}

.tier-card.selected {
  border: 3px solid #f38020; /* Suiftly primary orange */
  background: rgba(243, 128, 32, 0.03); /* subtle tint */
}

.tier-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.tier-header h3 {
  font-weight: 600;
  font-size: 0.86667rem; /* Cloudflare sm (13px) */
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: #333333; /* Cloudflare Charcoal */
}

.badge {
  background: #f38020; /* Suiftly primary */
  color: #ffffff;
  padding: 2px 10px;
  border-radius: 9999px; /* full (pill) */
  font-size: 0.73333rem; /* Cloudflare xs (11px) */
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.tier-capacity {
  color: #808285; /* Cloudflare Storm (muted text) */
  font-size: 0.86667rem; /* Cloudflare sm */
  margin-bottom: 8px;
  line-height: 1.5;
}

.tier-price {
  font-weight: 600;
  font-size: 1rem; /* Cloudflare base */
  color: #333333; /* Cloudflare Charcoal */
}
```

**Accessibility:**
- Keyboard navigation: Tab through cards, Enter/Space to select
- ARIA attributes: `role="radio"`, `aria-checked`, `aria-label`
- Focus indicator: Outline on keyboard focus

---

## Accessibility

- **Keyboard navigation:** All interactive elements focusable
- **ARIA labels:** For icons, dropdowns, modals
- **Color contrast:** WCAG AA compliant
- **Focus indicators:** Visible outlines on focus
- **Screen reader support:** Semantic HTML, proper labels

---

## Error States & Handling

### Wallet Connection Errors

**Wallet Rejection (User Cancels):**
- Modal closes
- Toast: "Wallet connection cancelled"
- User remains in demo mode

**Signature Verification Failure:**
- Modal shows error: "Signature verification failed. Please try again."
- Retry button in modal
- Option to cancel and stay in demo mode

**Network Error (Can't Reach Backend):**
- Modal shows: "Network error. Check your connection and try again."
- Retry button
- Fall back to demo mode on cancel

### Service Enable/Config Update Errors

**Insufficient Balance:**
- Before enable: Check balance, show warning if insufficient
- Error modal: "Insufficient balance ($X needed, $Y available). Top up your wallet to continue."
- [Top Up] button in error modal
- [Cancel] returns to config form

**Validation Errors:**
- Inline form errors (Zod schema validation)
- Highlight invalid fields in red
- Show specific error message below field
- Example: "Burst is only available for Pro and Enterprise tiers"

**Backend Error (500, timeout):**
- Toast: "An error occurred. Please try again."
- Config form state preserved (don't lose user's input)
- Retry button or manual retry

**Rate Limit:**
- Toast: "Too many requests. Please wait a moment and try again."
- Disable form submit for 10 seconds

### Key Management Errors

**Key Creation Failure:**
- Modal shows error: "Failed to create key. Please try again."
- Retry button
- Billing not charged if creation fails

**Revocation Failure:**
- Toast: "Failed to revoke key. Please try again."
- Key remains active (not revoked) until success

**Copy to Clipboard Failure:**
- Toast: "Failed to copy. Please select and copy manually."
- Key displayed in selectable text field

### Billing & Payment Errors

**Top-Up Transaction Failure:**
- Modal shows: "Transaction failed. Please check your wallet and try again."
- Show blockchain error message if available
- Balance not updated until blockchain confirms

**Withdrawal Transaction Failure:**
- Modal shows: "Withdrawal failed: {reason}"
- Balance not decremented
- Link to transaction explorer if TX was submitted

**Low Balance Warning:**
- Toast (dismissible): "Low balance: $X remaining. Top up to avoid service interruption."
- Trigger when balance < 1 month estimated charges
- Show once per day max

**Insufficient Funds (Service Pause):**
- Banner on all service pages: "Service paused due to insufficient funds. Top up within 7 days to resume."
- Grace period: 7 days before termination
- [Top Up] button in banner
- Email notification sent

### General Network & API Errors

**API Timeout:**
- Toast: "Request timed out. Please try again."
- Preserve form state

**401 Unauthorized (JWT Expired):**
- Clear auth state
- Redirect to home
- Toast: "Session expired. Please reconnect your wallet."

**403 Forbidden:**
- Toast: "You don't have permission to perform this action."
- Log to console for debugging

**404 Not Found (Service/Key):**
- Redirect to parent page (e.g., service list)
- Toast: "Resource not found."

**429 Rate Limit:**
- Toast: "Too many requests. Please wait {seconds}s."
- Exponential backoff for retries

### Empty States (Not Errors, but Worth Documenting)

**No Services Configured:**
- Show onboarding card: "Get started by configuring your first service"
- Large [Configure Seal] button

**No Usage Data Yet:**
- Stats tab: "Stats updated hourly. Data appears after 24 hours of activity."
- Empty graph placeholders

**No Activity Logs:**
- Logs tab: "No activity yet. Enable a service to see logs."

## Performance Considerations

### Lazy Loading

- **Charts:** Load chart library (Recharts/Chart.js) only on Stats tab
- **Wallet Widget:** Load Sui SDK only when needed
- **Modals:** Code-split modals (load on open)

### Optimistic UI

- **Config updates (non-financial):** Show new config immediately, revert if API fails
- **Financial operations (deposits, charges):** NEVER optimistic - always wait for confirmation

### Caching (TanStack Query)

- **Service configs:** Cache for 5 minutes (low churn)
- **Usage stats:** Cache for 1 hour (hourly updates)
- **Billing data:** Cache for 5 minutes
- **On auth state change:** Invalidate all auth-scoped queries

---

## Development Mock Strategy

### Mock Wallet

```typescript
// stores/wallet.ts (Zustand)
export const useWalletStore = create<WalletState>((set) => ({
  address: import.meta.env.DEV ? '0xMOCK123...' : null,
  balance: import.meta.env.DEV ? 1000.00 : 0,

  connect: async () => {
    if (import.meta.env.DEV) {
      // Mock: instant connection
      set({ address: '0xMOCK123...', balance: 1000.00 })
    } else {
      // Real: Sui wallet connection
      // ...
    }
  },

  deposit: async (amount: number) => {
    if (import.meta.env.DEV) {
      // Mock: instant deposit
      set((state) => ({ balance: state.balance + amount }))
    } else {
      // Real: Web3 transaction
      // ...
    }
  }
}))
```

### Mock API Responses

```typescript
// lib/trpc/client.ts
if (import.meta.env.DEV) {
  // Use MSW (Mock Service Worker) to intercept API calls
  // Return realistic data for services, billing, usage
}
```

### Mock Data (Initial Development)

- **Services:** Pre-configured Seal service (active)
- **Usage:** 12.5M requests, 450 GB bandwidth
- **Billing:** $127.50 balance, $66.75 current month
- **Logs:** 5-10 fake log entries

---

## Open Questions / Future Considerations

1. **Dashboard Home Page**
   - Currently: Redirect to `/services/seal`
   - Future: Dedicated home with overview cards, recent activity
   - Recommendation: Skip for MVP, redirect to first service

2. **User Settings Page**
   - Email notifications?
   - Team/organization management (wallet linking, roles)?
   - Recommendation: Add later (not MVP)

3. **Usage-Based Spending Cap (Off-Chain)**
   - Additional protection: Max $X per month for metered usage (requests/bandwidth)
   - Example: Monthly usage cap of $500 (separate from base service fees)
   - Would prevent runaway usage charges from API misuse or traffic spikes
   - Recommendation: Add as future enhancement after MVP

4. **Discord Invite Link**
   - Need to create Discord server and get invite link
   - Placeholder in Support page for now

5. **Service Status Page**
   - Show Suiftly infrastructure status (uptime, incidents)
   - Recommendation: Static page (separate from app)

6. **Service Bundling/Discounts**
   - Discounts for enabling multiple services?
   - Recommendation: Handle in pricing logic later

7. **Usage Alerts**
   - Email/push when approaching bandwidth limit?
   - Recommendation: Add after MVP (notifications system)

8. **Invoice Generation**
   - PDF download for invoices?
   - Recommendation: Add later (nice-to-have)

9. **API Documentation**
   - Separate docs site (docs.suiftly.io)?
   - Or inline docs in app?
   - Recommendation: Separate docs site (not part of app)

---

## Next Steps for Scaffolding

Once this UI design is approved:

1. **Scaffold monorepo** (Turborepo + workspaces)
2. **Create database schema** (customers, service_configs, billing, logs)
3. **Setup API** (Fastify + tRPC routers based on pages above)
4. **Build webapp skeleton** (routes, layouts, components)
5. **Implement onboarding flow** (connect wallet → configure first service)
6. **Add mock data** (for UI development without backend)
7. **Iterate on UI** (styling, interactions, responsiveness)

---

## Summary

**Key UI Decisions:**
- ✅ Separate landing site (`suiftly.io`) vs. app (`app.suiftly.io`)
- ✅ No login page - wallet-based auth only
- ✅ **Exploration mode:** Full dashboard accessible WITHOUT wallet connection
- ✅ **Wallet connection on-demand:** Only required when enabling services or viewing configs
- ✅ **"Connect Wallet Required" modal:** Appears when action needs wallet (with [Connect] or [Cancel])
- ✅ **Connect Wallet button in header:** Top-right, prominent (changes to address+balance when connected)
- ✅ **Cloudflare cf-ui design system:** Colors, typography, spacing from Cloudflare's style guide
- ✅ Cloudflare-inspired sidebar navigation (Seal, gRPC, GraphQL, Billing, Support)
- ✅ Service pages: Onboarding form → Tab-based view (Config/Keys/Stats/Logs)
- ✅ **Always-included features banner:** Shows geo-steering and auto-failover (top of config)
- ✅ **Horizontal tier cards:** Starter/Pro/Enterprise shown as full-width stacked cards (not radio buttons)
- ✅ **Selection indicators:** Border highlight (3px orange) + "SELECTED" badge (top-right)
- ✅ **Per-region and global capacity:** Each tier shows req/s per region + global (~3x)
- ✅ Tier-based pricing with live "Total Monthly Fee" calculator
- ✅ Seal service fully configured; gRPC/GraphQL show "coming soon" pages
- ✅ Tooltip (?) on each config field for explanations
- ✅ Keys tab for managing API keys, Seal keys, and packages
- ✅ Usage fees enumerated (metered separately from monthly fee)
- ✅ Stats tab shows empty graphs (set expectations)
- ✅ Logs tab shows config changes + charges (transparency)
- ✅ Support page with contact email, Discord, FAQ
- ✅ Persistent wallet widget in header (shows connection state)
- ✅ Mock wallet for development (no real Web3 needed initially)

**Pricing Model:**
- See [SEAL_SERVICE_CONFIG.md](./SEAL_SERVICE_CONFIG.md#pricing-model) for complete pricing details
- Tier base fees, add-on pricing, usage fees, and calculation examples documented there
- UI implements live pricing calculator based on SEAL_SERVICE_CONFIG.md pricing rules

**Always Included (All Tiers):**
- Global geo-steering and failover (closest key-server automatically selected)
- Auto-failover / retry for high-availability
- 3-region deployment (US-East, US-West, EU-Frankfurt)

**Ready to scaffold!** 🚀

---

## Acceptance Test Checklist (High-Risk Flows)

Minimal set of critical tests to validate before production:

1. **Wallet Auth & Session**
   - [ ] User can connect wallet, sign challenge, receive JWT in httpOnly cookie
   - [ ] Session expires after 4 hours (or prompts re-sign at 30 min remaining)
   - [ ] Disconnecting wallet clears session and returns to demo mode

2. **Service Enable with Billing**
   - [ ] Enabling service checks sufficient balance before charging
   - [ ] Charge is applied only after backend confirms (no optimistic billing)
   - [ ] Activity log shows charge with correct amount and timestamp

3. **Top-Up (Deposit) Reconciliation**
   - [ ] Blockchain TX submitted → shows "Pending confirmation (1/3, 2/3, 3/3)"
   - [ ] Balance updates only after 3 confirmations (~3-5 sec on Sui)
   - [ ] Failed TX shows error, balance NOT credited
   - [ ] TX hash links to blockchain explorer

4. **Rate Oracle & Conversion**
   - [ ] Median rate from ≥2 sources displayed with timestamp
   - [ ] Stale rates (>5 min) rejected
   - [ ] Slippage warning shown if sources differ >5%

5. **Key Revocation & Billing**
   - [ ] Revoke key → immediate 401 on requests using that key
   - [ ] Pro-rated credit applied to balance
   - [ ] Audit log entry created with key ID (last 4 chars) and timestamp

6. **Rate Limiting & Abuse Prevention**
   - [ ] Cannot revoke key within 5 min of creation
   - [ ] Exceeding rate limits (5 API key ops/hr) shows throttle warning
   - [ ] Rapid create/revoke cycles trigger temporary account lock

7. **Insufficient Balance & Service Pause**
   - [ ] Balance below 1-month estimate → shows low balance warning toast
   - [ ] Balance reaches $0 → service paused with 7-day grace period banner
   - [ ] Top-up during grace period resumes service immediately

8. **Error Handling (Critical Paths)**
   - [ ] Network error during wallet connect → shows retry with fallback to demo mode
   - [ ] Insufficient balance on enable → shows error modal with "Top Up" button
   - [ ] JWT expired (401) → clears auth, redirects to home, shows "Session expired" toast
