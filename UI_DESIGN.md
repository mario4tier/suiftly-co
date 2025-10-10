# UI Design Specification

## Overview

Customer-facing platform for Suiftly infrastructure services with a Cloudflare-inspired UX.

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
│  Sidebar    │         Main Content Area            │
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

## Authentication Flow

**No traditional login page - wallet-based authentication only.**

**Key principle:** Users can explore the entire dashboard WITHOUT connecting wallet (Cloudflare-style). Wallet connection only required when enabling services or viewing existing configs.

### First-Time User Flow (No Wallet Connection)

1. User visits `app.suiftly.io`
2. **Immediately sees dashboard** (no auth wall)
   - Full sidebar navigation visible
   - All service pages accessible
   - Pricing calculator works
   - Stats/Logs tabs show placeholder states
3. Header shows: **[Connect Wallet]** button (top-right, prominent)
4. User can explore freely:
   - Navigate to Seal/gRPC/GraphQL pages
   - Adjust config options and see live pricing
   - Read tooltips and help text
   - View Support page, FAQ
   - Everything works EXCEPT "Enable Service" button

### Wallet Connection Trigger

**Wallet connection required when:**
- User clicks "Enable Service" button (first attempt to activate)
- User tries to view existing service config (if they have one)
- User clicks wallet balance/deposit/withdraw

**Connection Flow:**
1. User clicks "Enable Service" (without wallet connected)
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
6. Modal closes → "Enable Service" action proceeds automatically
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
│ [Logo] Suiftly     [Connect Wallet] 󰅂 │
└────────────────────────────────────────┘
```

**Connected:**
```
┌─────────────────────────────────────────────┐
│ [Logo] Suiftly  [󰇃 $127.50 ▼]  [0x1a2...] │
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

## Sidebar Navigation

### Structure

```
┌─────────────────┐
│ Services        │
├─────────────────┤
│ 󰤄 Seal         │  ← Icon + label
│ 󰖟 gRPC         │
│ 󰘦 GraphQL      │
│                 │
│ ─────────────   │  ← Divider
│                 │
│ 󰵀 Billing      │
│ 󰋗 Support      │
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

---

## Page Layouts

### Page 1: Service Pages (Seal / gRPC / GraphQL)

**URL Pattern:** `/services/seal`, `/services/grpc`, `/services/graphql`

Each service page has **two states:**
1. **Not Configured State** (onboarding)
2. **Configured State** (active service with tabs)

**Note:** All services share the same configuration options (tier-based pricing model).

---

#### State 1: Not Configured (Onboarding)

**Full-page configuration form with live pricing.**

```
┌──────────────────────────────────────────────────────┐
│ Seal Configuration                                    │
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
│  • Requests: $0.XX per 1M requests                   │
│  • Bandwidth: $0.XX per GB (beyond guaranteed)       │
│                                                       │
│                      [ Enable Service ]              │
│                                                       │
└──────────────────────────────────────────────────────┘
```

**Behavior:**
- **Live price calculation:** As user changes options, "Total Monthly Fee" updates in real-time (using `useMemo()`)
- **Usage fees:** Listed below monthly fee (metered separately, not included)
- **Tooltips (?):** Click to show explanation for each field
- **"Enable Service" button:**
  - **If wallet NOT connected:** Show "Connect Wallet Required" modal
    - Modal offers: [Connect Wallet] or [Cancel]
    - After connecting → proceeds with enable automatically
  - **If wallet connected:**
    - Validates form (Zod schema)
    - Creates service config in DB
    - Charges wallet
    - Transitions to "Configured State" (tabs appear)
    - Shows success toast: "Seal service enabled. $XX.XX charged."

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
   - **Pro:** 500 req/s per region, ~1,500 req/s globally, $40/mo
   - **Business:** 2,000 req/s per region, ~6,000 req/s globally, $80/mo

   **Responsive:**
   - Desktop: Full-width cards, 3px padding between cards
   - Mobile: Same layout (works perfectly, no changes needed)

2. **Burst (?)**
   - Type: Checkbox
   - Enabled only for Pro and Business tiers (disabled for Starter)
   - Tooltip: "Allow temporary traffic bursts beyond guaranteed bandwidth. Additional charges apply for burst usage."
   - Pricing: +$10/month (only if enabled)

3. **Packages Per Seal Key (?)**
   - Type: Number input (starts at 3)
   - Default: 3 (included with all tiers)
   - Tooltip: "Number of packages per Seal key for organizing your services. Each additional package costs $1/month."
   - Pricing: (count - 3) × $1/month

4. **Additional API Keys (?)**
   - Type: Number input (starts at 1)
   - Default: 1 (included with all tiers)
   - Tooltip: "API keys for authenticating requests. Each additional key costs $1/month."
   - Pricing: (count - 1) × $1/month

5. **Additional Seal Keys (?)**
   - Type: Number input (starts at 1)
   - Default: 1 (included with all tiers)
   - Tooltip: "Seal-specific keys for cryptographic operations. Each additional key costs $5/month."
   - Pricing: (count - 1) × $5/month

**Pricing Display:**
- **Total Monthly Fee:** Total recurring monthly charge (all config options summed)
- **Usage Fees:** Bulleted list (metered separately, not included in monthly fee)
  - Requests (per million)
  - Bandwidth overages (beyond guaranteed)

**Pricing Example (Business tier, burst enabled, 5 packages per key, 2 API keys, 1 Seal key):**
```
Business tier: $80/month
Burst enabled: $10/month
Packages per Seal key: (5-3) × $1 = $2/month
Additional API keys: (2-1) × $1 = $1/month
Additional Seal keys: (1-1) × $5 = $0/month
────────────────────────────────
Total Monthly Fee: $93/month
```

**Note:** All services (Seal, gRPC, GraphQL) use the same configuration form and pricing model.

---

#### State 2: Configured (Active Service)

**Tab-based layout with read-only config.**

```
┌──────────────────────────────────────────────────────┐
│ Seal Service                     [Status: Active 🟢] │
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
│  • Requests: 12.5M ($1.25)                           │
│  • Bandwidth: 450 GB ($0.00 - within guaranteed)     │
│                                                       │
│                              [ Disable Service ]     │
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
- **Disable Service** button (bottom, less prominent)

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
│                         [ Generate New API Key ]     │
│                                                       │
│  Seal Keys (1 active)                                 │
│  ┌────────────────────────────────────────┐          │
│  │  seal_xyz789...  [Copy] [Revoke]      │          │
│  └────────────────────────────────────────┘          │
│                        [ Generate New Seal Key ]     │
│                                                       │
│  Packages (5 configured)                              │
│  ┌────────────────────────────────────────┐          │
│  │  package-1  [Edit] [Delete]            │          │
│  │  package-2  [Edit] [Delete]            │          │
│  │  package-3  [Edit] [Delete]            │          │
│  │  package-4  [Edit] [Delete]            │          │
│  │  package-5  [Edit] [Delete]            │          │
│  └────────────────────────────────────────┘          │
│                           [ Add New Package ]        │
│                                                       │
└──────────────────────────────────────────────────────┘
```

**Keys Tab (Before Service Enabled):**
```
┌──────────────────────────────────────────────────────┐
│  Keys & Packages                                      │
│                                                       │
│  ⓘ After enabling this service, you'll be able to:  │
│                                                       │
│  • Generate and manage API keys                      │
│  • Create and manage Seal keys                       │
│  • Configure packages for service organization       │
│                                                       │
│  Enable the service from the Configuration tab       │
│  to access these features.                           │
│                                                       │
└──────────────────────────────────────────────────────┘
```

**Keys Tab Behavior (After Service Enabled):**
- **API Keys Section:**
  - List of active keys (truncated display)
  - Copy button → Copies full key to clipboard
  - Revoke button → Disables key (confirmation required)
  - "Generate New API Key" → Creates new key, shows full key once (copy prompt)

- **Seal Keys Section:**
  - Same pattern as API keys
  - Higher cost ($5/month vs $1/month)

- **Packages Section:**
  - List of configured packages
  - Edit → Rename package
  - Delete → Remove package (confirmation required, only if count > 3)
  - "Add New Package" → Creates new package (+$1/month charge)

**Note:** Generating/deleting keys updates monthly fee and triggers billing events.

**Tab 3: Stats**

```
┌──────────────────────────────────────────────────────┐
│  Stats                                                │
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

**State 1: Wallet Not Connected**
```
┌──────────────────────────────────────────────────────┐
│ Billing & Usage                                       │
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
│  │  Service    │ Requests  │ Bandwidth    │          │
│  ├────────────────────────────────────────┤          │
│  │  Seal       │ 12.5M     │ 450 GB       │          │
│  │  gRPC       │ 3.2M      │ 120 GB       │          │
│  │  GraphQL    │ 1.8M      │ 80 GB        │          │
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
- **Disconnect Wallet:** Clears JWT, resets to "not connected" state
- **Recent Activity:** Last 5 transactions (link to full billing page)

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
3. Select tier: Business
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
13. Wallet connected → Modal closes
    ↓
14. Validation (Zod schema)
    ↓
15. API call: POST /api/services.updateConfig
    ↓
16. Success → Config saved → Tabs appear
    ↓
17. Wallet charged: $63.00 (pro-rated for current month)
    ↓
18. Toast: "Seal service enabled. $63.00 charged."
    ↓
19. Header shows wallet address + balance
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
4. Change Endpoints: 2 → 3
   ↓
5. See new Monthly Estimate: $55.00
   ↓
6. See note: "You'll be charged $10.00 (pro-rated) immediately"
   ↓
7. Click "Save Changes"
   ↓
8. API call: PATCH /api/services.updateConfig
   ↓
9. Success → Config updated → Modal closes
   ↓
10. Wallet charged: $10.00 (pro-rated)
    ↓
11. Logs tab shows new entry: "Configuration updated"
    ↓
12. Toast: "Configuration updated. $10.00 charged."
```

**Note:** Handle credits later (e.g., downgrading from 3 → 2 endpoints).

---

### Flow 4: Top-Up Wallet

```
1. User clicks wallet widget in header
   ↓
2. Dropdown expands
   ↓
3. Click "Top Up"
   ↓
4. Modal opens: "Deposit Funds"
   ↓
5. Enter amount: $100
   ↓
6. Click "Deposit"
   ↓
7. Web3 wallet popup → Approve transaction
   ↓
8. Transaction confirmed
   ↓
9. Balance updates: $127.50 → $227.50
   ↓
10. Modal closes
    ↓
11. Toast: "Deposit successful. +$100.00"
```

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
| `GenerateKeyButton` | Create new key (shows modal) | `components/keys/` |
| `PackagesList` | Manage packages | `components/keys/` |
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
| `Modal` | Edit config, deposit/withdraw, key generation, "Connect Wallet Required" |
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

/settings (future)             → User settings (requires wallet)
```

**Route Access:**
- **Public Routes (No wallet needed):**
  - All service pages (exploration mode)
  - Billing overview page (shows empty state)
  - Support page

- **Wallet-Required Actions:**
  - Enable/disable services
  - Edit service configs
  - Generate/revoke keys
  - View invoice details
  - Top-up/withdraw wallet

- **No route-level authentication:** All pages load without wallet. Actions prompt connection when needed.

**Route State:**
- Service page state (configured vs. not configured) determined by API data
- Active tab state stored in URL params (e.g., `/services/seal?tab=stats`)

---

## Form Schemas (Zod)

### Service Config (All Services)

**All services (Seal, gRPC, GraphQL) use the same configuration schema.**

```typescript
const serviceConfigSchema = z.object({
  guaranteedBandwidth: z.enum(['starter', 'pro', 'business']),
  burstEnabled: z.boolean(),
  packagesPerSealKey: z.number().min(3), // Comes with 3, can add more
  additionalApiKeys: z.number().min(1),  // Comes with 1, can add more
  additionalSealKeys: z.number().min(1), // Comes with 1, can add more
}).refine((data) => {
  // Burst only available for Pro and Business
  if (data.burstEnabled && data.guaranteedBandwidth === 'starter') {
    return false
  }
  return true
}, {
  message: "Burst is only available for Pro and Business tiers",
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
  additionalPackage: 1, // $1/month per package (after 3)
  additionalApiKey: 1, // $1/month per key (after 1)
  additionalSealKey: 5, // $5/month per key (after 1)
}

// Calculate monthly fee
function calculateMonthlyFee(config: ServiceConfig): number {
  let total = PRICING.tiers[config.guaranteedBandwidth].base

  if (config.burstEnabled) {
    total += PRICING.burst
  }

  total += Math.max(0, config.packagesPerSealKey - 3) * PRICING.additionalPackage
  total += Math.max(0, config.additionalApiKeys - 1) * PRICING.additionalApiKey
  total += Math.max(0, config.additionalSealKeys - 1) * PRICING.additionalSealKey

  return total
}
```

**Note:** Pricing values above are finalized:
- Starter: $20/mo, 100 req/s per region (~300 req/s globally)
- Pro: $40/mo, 500 req/s per region (~1,500 req/s globally)
- Business: $80/mo, 2,000 req/s per region (~6,000 req/s globally)
- Burst: +$10/mo (Pro/Business only)
- Packages per Seal key: $1/mo each (after 3)
- Additional API keys: $1/mo each (after 1)
- Additional Seal keys: $5/mo each (after 1)

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

## Performance Considerations

### Lazy Loading

- **Charts:** Load chart library (Recharts/Chart.js) only on Stats tab
- **Wallet Widget:** Load Sui SDK only when needed
- **Modals:** Code-split modals (load on open)

### Optimistic UI

- **Config updates:** Show new config immediately, revert if API fails
- **Wallet balance:** Update UI before blockchain confirmation

### Caching (TanStack Query)

- **Service configs:** Cache for 5 minutes (low churn)
- **Usage stats:** Cache for 1 hour (hourly updates)
- **Billing data:** Cache for 5 minutes

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
   - API keys for programmatic access?
   - Team/organization management?
   - Recommendation: Add later (not MVP)

3. **Tier Pricing Details**
   - Need to define exact costs for Starter/Pro/Business
   - Need to define req/sec limits for each tier
   - Will be added to pricing constants later

4. **Discord Invite Link**
   - Need to create Discord server and get invite link
   - Placeholder in Support page for now

5. **Service Status Page**
   - Show Suiftly infrastructure status (uptime, incidents)
   - Recommendation: Static page (separate from app)

6. **Service Bundling/Discounts**
   - Discounts for enabling multiple services?
   - Recommendation: Handle in pricing logic later

7. **Key Management Details**
   - What happens when revoking a key? (immediate vs. grace period)
   - Key rotation strategy/recommendations
   - Key permissions/scopes (if applicable)

8. **Usage Alerts**
   - Email/push when approaching bandwidth limit?
   - Recommendation: Add after MVP (notifications system)

9. **Invoice Generation**
   - PDF download for invoices?
   - Recommendation: Add later (nice-to-have)

10. **API Documentation**
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
- ✅ **Horizontal tier cards:** Starter/Pro/Business shown as full-width stacked cards (not radio buttons)
- ✅ **Selection indicators:** Border highlight (3px orange) + "SELECTED" badge (top-right)
- ✅ **Per-region and global capacity:** Each tier shows req/s per region + global (~3x)
- ✅ Tier-based pricing with live "Total Monthly Fee" calculator
- ✅ All services use same config options (global, no region selection)
- ✅ Tooltip (?) on each config field for explanations
- ✅ Keys tab for managing API keys, Seal keys, and packages
- ✅ Usage fees enumerated (metered separately from monthly fee)
- ✅ Stats tab shows empty graphs (set expectations)
- ✅ Logs tab shows config changes + charges (transparency)
- ✅ Support page with contact email, Discord, FAQ
- ✅ Persistent wallet widget in header (shows connection state)
- ✅ Mock wallet for development (no real Web3 needed initially)

**Configuration Pricing Model:**
- **Guaranteed Bandwidth Tiers:**
  - Starter: $20/mo → 100 req/s per region (~300 req/s globally)
  - Pro: $40/mo → 500 req/s per region (~1,500 req/s globally)
  - Business: $80/mo → 2,000 req/s per region (~6,000 req/s globally)
- **Burst:** +$10/month (available for Pro/Business only)
- **Packages Per Seal Key:** $1/month each (comes with 3)
- **Additional API Keys:** $1/month each (comes with 1)
- **Additional Seal Keys:** $5/month each (comes with 1)

**Always Included (All Tiers):**
- Global geo-steering and failover (closest key-server automatically selected)
- Auto-failover / retry for high-availability
- 3-region deployment (US-East, US-West, EU-Frankfurt)

**Ready to scaffold!** 🚀
