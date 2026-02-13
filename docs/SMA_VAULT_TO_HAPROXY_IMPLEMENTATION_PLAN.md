# SMA_VAULT to HAProxy Implementation Plan (MVP)

## Overview

Implement customer configuration propagation from SMA_VAULT to HAProxy maps. The vault contains pre-encoded map data so LM can write it directly without runtime encoding.

**Data Flow**:
1. **GM** reads customer config from DB → encodes to 67-char CSV hex → stores in vault
2. **LM** extracts pre-encoded hex from vault → writes to map file + HAProxy socket
3. **HAProxy** uses map for rate limits, IP allowlist, API key validation

## Vault Schema Design

**New structure** with `customerId` at top level and `services[]` array:

```typescript
interface CustomerVaultConfig {
  customerId: number;
  services: ServiceVaultConfig[];
}

interface ServiceVaultConfig {
  serviceType: 'seal';          // Future: 'grpc', 'graphql'
  network: 'mainnet' | 'testnet';

  // Config fields
  apiKeyFps: number[];          // 32-bit fingerprints
  tier: string;                 // "starter" | "pro" | "enterprise"
  status: 'active' | 'suspended' | 'disabled';
  isUserEnabled: boolean;
  sealKeys?: SealKeyVaultConfig[];

  // IP allowlist (for control bit 1)
  ipAllowlist?: string[];       // CIDRs: ["192.168.0.0/24", "10.0.0.1/32"]

  // Pre-encoded HAProxy map data
  mapConfigHex: string;         // "header,api_keys,ip_filter,extra" (67 chars)
  extraApiKeyFps?: number[];    // Keys 3-20 for extra_keys.map (when >2 keys)
}
```

## HAProxy Map Format

### Primary Config Map (67 chars CSV)
```
<customer_id> <header_hex>,<api_keys_hex>,<ip_filter_hex>,<extra_hex>
```

**Header Field** (16 hex): `00000ILGLBLQCCCC`
- Positions 5-6: ILIM (per-IP limit)
- Positions 7-8: GLIM (guaranteed limit)
- Positions 9-10: BLIM (burst limit)
- Position 11: BQoS (priority 0x0-0xF)
- Positions 12-15: Control flags

**Control Flags**:
- Bit 0: COURTESY_OPS (1 req/sec override)
- Bit 1: IP_ALLOWLIST_ENABLED (check allowlist.map)
- Bit 2: EXTRA_KEYS_ENABLED (check extra_keys.map)

### Supplementary Maps

**IP Allowlist** (`/etc/haproxy/conf.d/204-mseal_allowlist.map`):
```
<customer_id> <cidr1>,<cidr2>,<cidr3>
```

**Extra API Keys** (`/etc/haproxy/conf.d/204-mseal_extra_keys.map`):
```
<customer_id> <fp1>,<fp2>,<fp3>,...
```

## Tier Configuration

```typescript
const TIER_CONFIG = {
  starter:    { ilim: 0x02, glim: 0x02, blim: 0x00, bqos: 0x0 },  // 8 req/sec, no burst
  pro:        { ilim: 0x10, glim: 0x06, blim: 0x06, bqos: 0x2 },  // 24 req/sec + burst
  enterprise: { ilim: 0x40, glim: 0x18, blim: 0x18, bqos: 0x3 },  // 96 req/sec + burst
};
```

**GLIM Logic**:
- GLIM = tier_base when `status='active' AND isUserEnabled=true`
- GLIM = 0 otherwise → HAProxy returns 403

**Priority Calculation** (for burst traffic):
- Priority = 20 - BQoS (lower number = higher priority)
- Guaranteed traffic always gets Priority = 0

## Files to Modify

### 1. GM: `suiftly-co/services/global-manager/src/tasks/generate-vault.ts`

**Changes**:
1. Add `TIER_CONFIG` constant
2. Restructure `CustomerVaultConfig` to use `services[]` array
3. Add encoding functions:
   - `encodeHeaderField()` - ILIM/GLIM/BLIM/BQoS/Control
   - `encodeApiKeysField()` - First 2 fingerprints
   - `encodeIpFilterField()` - First 2 IPv4 addresses (from allowlist)
   - `encodeCustomerMapConfig()` - Combine all fields
4. Modify `buildVaultData()` to:
   - Query services per customer
   - Build `services[]` array with encoded `mapConfigHex`
   - Set control bits for IP allowlist (>0 CIDRs) and extra keys (>2 keys)
   - Include `extraApiKeyFps` when customer has >2 API keys
   - Include `ipAllowlist` when customer has IP restrictions

### 2. LM: `mhaxbe/services/local-manager/src/map-writer.ts`

**Changes**:
1. Add `writeCustomerMap()` for primary config map
2. Add `writeAllowlistMap()` for IP allowlist entries
3. Add `writeExtraKeysMap()` for extra API keys (>2)
4. Add validation for hex format

### 3. LM: `mhaxbe/services/local-manager/src/haproxy-updater.ts`

**Changes**:
1. Update `haproxyUpdateCallback()` to:
   - Extract all customer service configs from vault
   - Build entries for config, allowlist, and extra_keys maps
   - Write all three maps (disk)
   - Apply delta updates via HAProxy socket

2. Add `applyDeltaUpdates()` for HAProxy socket commands:
   - `add map` for new customers
   - `set map` for modified customers
   - `del map` for removed customers
   - Uses `VaultDiff` to identify changes

### 4. LM: `mhaxbe/services/local-manager/src/haproxy-socket.ts`

**Changes**:
1. Add `addMapEntry(mapPath, key, value)` - runtime map add
2. Add `setMapEntry(mapPath, key, value)` - runtime map update
3. Add `delMapEntry(mapPath, key)` - runtime map delete
4. Add `clearMap(mapPath)` - clear all entries (for full reload)

## Implementation Phases

### Phase 1: GM Encoding
1. Restructure CustomerVaultConfig with services[] array
2. Add TIER_CONFIG constant
3. Add encoding functions (header, api_keys, ip_filter)
4. Modify buildVaultData() to encode all fields
5. Add unit tests for encoding

### Phase 2: LM Map Writing
1. Add writeCustomerMap() for primary config
2. Add writeAllowlistMap() for IP allowlist
3. Add writeExtraKeysMap() for extra API keys
4. Update haproxyUpdateCallback() to write all maps

### Phase 3: HAProxy Socket Commands
1. Add addMapEntry(), setMapEntry(), delMapEntry() to haproxy-socket.ts
2. Add clearMap() for full reload fallback
3. Add error handling and retry logic

### Phase 4: Delta Updates
1. Add applyDeltaUpdates() to haproxy-updater.ts
2. Integrate with VaultDiff from vault-handler.ts
3. Fall back to full rewrite on socket errors

### Phase 5: Integration Testing
1. E2E test: Subscribe → API key → Map entry → Request through HAProxy
2. Test: Disable service → GLIM=0 → 403 response
3. Test: IP allowlist → Only allowed IPs pass
4. Test: >2 API keys → Extra keys map used

## Validation Checklist

- [ ] GM encodes starter tier → GLIM=0x02, BQoS=0x0
- [ ] GM encodes pro tier → GLIM=0x06, BLIM=0x06, BQoS=0x2
- [ ] GM encodes enterprise tier → GLIM=0x18, BLIM=0x18, BQoS=0x3
- [ ] GM encodes disabled service → GLIM=0x00 (all zeros)
- [ ] GM sets control bit 1 when ipAllowlist has entries
- [ ] GM sets control bit 2 when >2 API keys
- [ ] LM writes primary config map with customer entries
- [ ] LM writes allowlist map for customers with IP restrictions
- [ ] LM writes extra_keys map for customers with >2 keys
- [ ] LM applies delta updates via HAProxy socket
- [ ] HAProxy returns 200 for enabled customer within rate limit
- [ ] HAProxy returns 403 for disabled customer (GLIM=0)
- [ ] HAProxy returns 403 for IP not in allowlist
- [ ] HAProxy returns 429 when rate limit exceeded
- [ ] E2E test passes: `seal-real-requests.spec.ts`
