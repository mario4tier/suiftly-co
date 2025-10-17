# Seal Service Configuration

## Overview

This document defines the tier structure, rate limiting, and configuration for the Seal encryption service. It serves as the single source of truth for business logic that affects UI, billing, and infrastructure configuration.

## Service Tiers

### Tier Structure

| Tier | Guaranteed req/s per region | Burst Available | Usage Pricing (all tiers) |
|------|----------------------------|-----------------|---------------------------|
| **Starter** | 100 | ❌ No | $1.00 per 10K requests |
| **Pro** | 1,000 | ✅ Yes (2x) | $1.00 per 10K requests |
| **Enterprise** | Custom | ✅ Yes (Custom) | Custom pricing |

**Key Points:**
- Usage pricing is **$1.00 per 10,000 requests** for all tiers (Starter, Pro)
- Tiers determine **guaranteed bandwidth** (req/s per region), not usage pricing
- Monthly base fees and add-on pricing listed in Pricing Model section below

### Rate Limiting Model

**Key Principles:**
- **Guaranteed req/s**: Hard limit per region - customer always gets this capacity
- **Burst capability**: Available only for Pro and Enterprise tiers
- **No RPM limits**: No per-minute restrictions (only per-second)
- **No connection limits**: No concurrent connection restrictions

**Burst Behavior (Pro/Enterprise only):**
- Allows temporary spikes above guaranteed rate
- Pro: Up to 2x guaranteed rate (2,000 req/s) for 10 seconds
- Enterprise: Custom burst configuration
- Burst tokens regenerate at guaranteed rate when below limit

## MA_VAULT Configuration

The MA_VAULT stores customer API keys and rate limits for HAProxy enforcement.

### Entry Format

```json
{
  "customer:<customer_id>": {
    "api_keys": ["<hashed_key1>", "<hashed_key2>"],
    "tier": "pro",
    "limits": {
      "guaranteed_rps": 1000,
      "burst_rps": 2000,        // Only for pro/enterprise
      "burst_duration_sec": 10 // Only for pro/enterprise
    },
    "seal_keys": {
      "count": 2,
      "package_ids": ["0x123...", "0x456..."]
    },
    "status": "active"  // active, suspended, throttled
  }
}
```

### Status Values

- **active**: Normal operation
- **suspended**: No requests allowed (e.g., non-payment)
- **throttled**: Reduced to 50% of guaranteed rate (soft limit)

## HAProxy Integration

### Sticky Table Configuration

HAProxy enforces rate limits using stick tables based on MA_VAULT data:

```haproxy
# Stick table tracks per-customer request rates
stick-table type string len 64 size 100k expire 60s \
            store http_req_rate(1s)

# Apply guaranteed rate limit
http-request deny if { sc_http_req_rate(0) gt var(txn.guaranteed_rps) }

# Burst handling (Pro/Enterprise only) - managed by separate burst table
stick-table type string len 64 size 100k expire 60s \
            store gpc0_rate(10s)  # Burst token bucket
```

### Map File Format

Generated from MA_VAULT by Local Manager:

```
# api_limits.map
# Format: api_key customer_id,tier,guaranteed_rps,burst_rps,status
<api_key_hash> customer123,pro,1000,2000,active
<api_key_hash> customer456,starter,100,0,active
<api_key_hash> customer789,enterprise,10000,15000,active
```

## Pricing Model

### Monthly Base Fees

| Tier | Monthly Base Fee | Description |
|------|-----------------|-------------|
| **Starter** | $20/month | 100 req/s per region, no burst |
| **Pro** | $40/month | 1,000 req/s per region, burst available |
| **Enterprise** | Custom | Custom capacity and pricing |

### Add-On Pricing

| Feature | Cost | Notes |
|---------|------|-------|
| **Burst Capability** | +$10/month | Pro/Enterprise only, allows 2x capacity for 10s |
| **Additional Seal Keys** | +$5/month each | 1 included, additional keys for isolation |
| **Additional Packages** | +$1/month each per seal key | 3 included per seal key |
| **Additional API Keys** | +$1/month each | 1 included, additional for key rotation |

**Pricing Rules:**
- **Seal Keys**: `max(0, totalSealKeys - 1) × $5/month`
- **Packages**: `sum(max(0, packagesPerKey - 3) × $1/month)` for each seal key
- **API Keys**: `max(0, totalApiKeys - 1) × $1/month`
- **Burst**: `$10/month` if enabled (Pro/Enterprise only)

### Usage-Based Billing

- **Billing metric**: Per 10,000 successful requests (2xx/3xx responses)
- **Usage rate**: $1.00 per 10,000 requests (all tiers)
- **Failed requests**: Not charged (4xx/5xx responses)
- **Billing cycle**: Monthly billing at end of month
- **Minimum charge**: $0.01 (rounded up to nearest cent)

### Example Pricing Calculations

**Example 1: Starter Tier (Basic)**
- Tier: Starter ($20/month)
- Seal Keys: 1 (included)
- Packages: 3 (included)
- API Keys: 1 (included)
- **Total Monthly Fee**: $20/month
- **Usage**: Metered separately at $1/10K requests

**Example 2: Pro Tier (Moderate)**
- Tier: Pro ($40/month)
- Burst: Enabled (+$10/month)
- Seal Keys: 2 (1 included, 1 × $5 = $5/month)
- Packages per key: 5 (3 included, 2 additional × $1 × 2 keys = $4/month)
- API Keys: 2 (1 included, 1 × $1 = $1/month)
- **Total Monthly Fee**: $60/month
- **Usage**: Metered separately at $1/10K requests

**Example 3: Pro Tier (Heavy)**
- Tier: Pro ($40/month)
- Burst: Enabled (+$10/month)
- Seal Keys: 3 (1 included, 2 × $5 = $10/month)
- Packages per key: 5 each (3 included, 2 additional × $1 × 3 keys = $6/month)
- API Keys: 4 (1 included, 3 × $1 = $3/month)
- **Total Monthly Fee**: $69/month
- **Usage**: Metered separately at $1/10K requests

### Tier Selection Guidelines

**Starter Tier:**
- Development and testing
- Low-traffic applications (<100 req/s sustained)
- Personal projects

**Pro Tier:**
- Production applications
- Need for burst capacity
- Medium traffic (up to 500 req/s per region)
- Multiple encryption keys

**Business Tier:**
- High-traffic production (up to 2000 req/s per region)
- Multiple applications/environments
- Extended burst capacity

**Enterprise Tier:**
- Custom SLA requirements
- Dedicated support
- Custom rate limits and pricing

## Regional Deployment

### Rate Limits Per Region

Each region maintains independent rate limits:
- Customer gets full tier capacity in each region
- No cross-region rate limit sharing
- Burst tokens are region-specific

### Example Multi-Region Setup

Pro tier customer (500 req/s guaranteed per region):
- US-East: 500 req/s + burst capability (up to 1000 req/s)
- EU-West: 500 req/s + burst capability (up to 1000 req/s)
- Asia-Pacific: 500 req/s + burst capability (up to 1000 req/s)

Total potential: 1,500 req/s globally (3,000 req/s with burst)

## Monitoring & Alerting

### Customer-Facing Metrics

Available in dashboard:
- Current req/s usage per region
- Burst token availability (Pro/Business)
- Daily/Monthly request totals
- Rate limit violations count

### Internal Metrics

For operations team:
- Per-customer req/s trends
- Burst utilization patterns
- Rate limit violation patterns
- Tier distribution analytics

## Migration & Upgrades

### Tier Upgrades

When customer upgrades tier:
1. Update database tier assignment
2. Global Manager generates new MA_VAULT
3. Local Managers apply new limits (~30 second propagation)
4. No service interruption

### Tier Downgrades

When customer downgrades:
1. Effective at next billing cycle
2. Burst capability removed immediately (if applicable)
3. Rate limits adjusted to new tier

## Future Enhancements

Planned improvements (not in MVP):
- Auto-scaling based on usage patterns
- Dynamic burst allocation
- Regional tier differentiation
- Request priority queuing for Enterprise