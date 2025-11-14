# API Key Schema Testing Guide

This document explains how to test the new API key schema changes (INTEGER fingerprint with collision retry).

## Schema Changes

The `api_keys` table now uses:
- **PRIMARY KEY**: `api_key_fp` (INTEGER) - 32-bit signed fingerprint
- **UNIQUE**: `api_key_id` (VARCHAR) - Full API key string
- **Collision handling**: Retry loop generates new key if fingerprint collides

## Testing Steps

### 1. Reset Database (Apply Migrations)

First, apply the schema changes:

```bash
./scripts/dev/reset-database.sh
```

This will:
- Apply migration `0006_change_api_key_fp_to_primary_key.sql`
- Change `api_key_fp` from VARCHAR to INTEGER PRIMARY KEY
- Add UNIQUE constraint on `api_key_id`

### 2. Run Unit Tests

Test the fingerprint calculation and API key generation:

```bash
cd apps/api
npm test -- api-keys.test.ts
```

**What these tests verify:**
- Fingerprint extraction from first 7 Base32 chars
- Signed 32-bit integer range (-2^31 to 2^31-1)
- Deterministic fingerprint calculation
- Handling both positive and negative fingerprints
- Uniqueness across 1000 keys

### 3. Run Database Integration Tests

Test the actual database storage and retrieval:

```bash
cd apps/api
npm test -- api-keys-db.test.ts
```

**What these tests verify:**
- `api_key_fp` stored in database matches `createApiKeyFingerprint(api_key_id)`
- Collision retry logic works correctly
- Multiple keys with different fingerprints
- All service types (seal, grpc, graphql)
- All seal type configurations
- Both positive and negative fingerprints are stored correctly

### 4. Verify Manually (Optional)

You can also verify the changes manually:

```bash
# Connect to database
sudo -u postgres psql -d suiftly_dev

# Check table structure
\d api_keys

# Expected output should show:
# api_key_fp | integer | not null (PRIMARY KEY)
# api_key_id | character varying(100) | not null (UNIQUE)

# Exit psql
\q
```

## Expected Test Results

### Unit Tests (api-keys.test.ts)
- ✅ All existing tests should pass
- ✅ New fingerprint verification tests (5 tests)
  - Extract correct 32-bit fingerprint
  - Handle positive range fingerprints
  - Handle negative range fingerprints
  - Produce unique fingerprints
  - Extract from correct position in key

### Database Integration Tests (api-keys-db.test.ts)
- ✅ Fingerprint consistency (3 tests)
  - Stored `api_key_fp` matches calculated fingerprint
  - Multiple keys have matching fingerprints
  - Signed 32-bit range validation
- ✅ Collision retry (1 test)
  - Successfully stores keys with retry logic
- ✅ Different service types (1 test)
  - Seal, gRPC, GraphQL all work correctly
- ✅ Different seal types (1 test)
  - All 6 seal configurations work correctly

## Troubleshooting

### Database Connection Issues

If you see authentication errors, you may need to configure PostgreSQL:

```bash
# The reset script will offer to auto-configure
./scripts/dev/reset-database.sh

# Or manually configure pg_hba.conf for local development
# See docs/ARCHITECTURE.md for details
```

### Test Failures

If tests fail:

1. **Check migrations applied**: Verify `api_key_fp` is INTEGER in database
2. **Check test database**: Tests use the same database as development
3. **Check SECRET_KEY**: Tests generate random SECRET_KEY for isolation

### Performance Notes

- **Unit tests**: ~50-100ms total (fast, no database)
- **DB integration tests**: ~500-1000ms (database operations)
- **Fingerprint uniqueness**: No collisions expected in small samples (<10K keys)
- **Collision rate**: ~0.014% at 600K keys (very rare)

## Implementation Details

### Fingerprint Calculation

```typescript
// Extract first 7 Base32 chars from API key (positions 1-7)
const fingerprintChars = apiKey.slice(1, 8);

// Decode to 32-bit unsigned integer
const decoded = base32Decode(fingerprintChars);
const unsigned = decoded.readUInt32BE(0);

// Convert to signed for PostgreSQL INTEGER storage
const signed = unsigned > 0x7FFFFFFF ? unsigned - 0x100000000 : unsigned;
```

### Collision Retry

```typescript
for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
  const plainKey = generateApiKey(...);
  const fingerprint = createApiKeyFingerprint(plainKey);

  try {
    await db.insert(apiKeys).values({ apiKeyFp: fingerprint, ... });
    return { record, plainKey };
  } catch (error) {
    if (error.code === '23505' && error.constraint === 'api_keys_pkey') {
      continue; // Retry with new key
    }
    throw error;
  }
}
```

## Success Criteria

All tests passing indicates:
- ✅ Schema migration successful
- ✅ Fingerprint calculation correct
- ✅ Database storage/retrieval working
- ✅ Collision retry implemented
- ✅ Type inference correct (Drizzle ORM)
- ✅ Ready for production use
