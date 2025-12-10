# KVCrypt Refactoring Plan

## Overview

Simplify KVCrypt by removing OVH KMS envelope encryption in favor of direct symmetric encryption with ACL-protected key files.

## Architecture Decision

**Before (OVH KMS Envelope Encryption):**
```
OVH KMS → generates DEK → encrypt vault with DEK → store encrypted DEK + ciphertext
```

**After (Direct Encryption):**
```
Local key file → directly encrypt/decrypt vault content
```

**Rationale:**
- OVH KMS adds complexity without meaningful benefit for our use case
- Vault files are small (<1GB), so no crypto performance advantage from envelope encryption
- ACL-protected key files provide equivalent security to encrypted credentials
- Eliminates external dependency (OVH availability)
- Simplifies code significantly

## Key File Design

**Location:** `/opt/coord/.sys/{vault}.key`

**Format:** 32 bytes of raw key material (AES-256)

**Protection:**
- File permissions: `640` (owner read/write, group read)
- ACL groups control access:
  - `tk-readers` group → can read `tk.key`
  - `ma-readers` group → can read `ma.key`
  - etc.

**Generation:**
```bash
# Generate new key
openssl rand 32 > /opt/coord/.sys/tk.key
chmod 640 /opt/coord/.sys/tk.key
setfacl -m g:tk-readers:r /opt/coord/.sys/tk.key
```

## Files to DELETE

### Python Implementation (complete removal)
- `/home/olet/walrus/scripts/sync/kvcrypt.py` - Python CLI
- `/home/olet/walrus/scripts/utilities/encrypted_storage.py` - Python store
- `/home/olet/walrus/scripts/ovh-kms-client.py` - OVH KMS client
- `/home/olet/walrus/scripts/kms-pem-install.py` - OVH credential installer
- `/home/olet/walrus/scripts/test-kvcrypt.py` - Python tests
- `/home/olet/walrus/scripts/test-kvcrypt-edge-cases.py` - Python edge case tests

### TypeScript KMS-related
- `/home/olet/walrus/packages/kvcrypt/src/lib/kms-client.ts` - OVH KMS wrapper

## Files to CREATE

### Key Provider
`/home/olet/walrus/packages/kvcrypt/src/lib/key-provider.ts`
```typescript
/**
 * Provides encryption keys from ACL-protected key files.
 *
 * Key files are stored at /opt/coord/.sys/{vault}.key
 * Access controlled by Linux ACLs (e.g., tk-readers group)
 */
export interface KeyProvider {
  getKey(vaultType: VaultType): Promise<Buffer>;
}

export function createKeyProvider(options?: {
  keyDir?: string;  // Default: /opt/coord/.sys
}): KeyProvider;
```

### Test Key Provider
For testing without ACL-protected files:
```typescript
export function createTestKeyProvider(keyMap: Record<string, Buffer>): KeyProvider;
```

## Files to MODIFY

### store.ts
- Remove KMS client dependency
- Use KeyProvider instead
- Simplify put/get to use direct encryption

**Before:**
```typescript
const store = createStore({
  storageDir: '/path/to/vaults',
  kmsKeyId: 'test-key-id',
  kmsInstance: 'test-kms',
});
```

**After:**
```typescript
const store = createStore({
  storageDir: '/path/to/vaults',
  keyProvider: createKeyProvider(),  // Or createTestKeyProvider for tests
});
```

### crypto.ts
- Keep AES-256-GCM implementation (unchanged)
- May simplify envelope-related code if present

### types.ts
- Remove KMS-related types
- Add KeyProvider type

## Files to KEEP (unchanged)

- `crypto.ts` - Core AES-256-GCM encrypt/decrypt (no KMS logic)
- Test files structure (but content will change)

## Test Strategy

### Unit Tests (no ACL required)
Use `createTestKeyProvider` with in-memory keys:
```typescript
const testKey = crypto.randomBytes(32);
const store = createStore({
  storageDir: tempDir,
  keyProvider: createTestKeyProvider({ tk: testKey }),
});
```

### Integration Tests (ACL required)
For CI/production verification with real key files:
```typescript
const store = createStore({
  storageDir: '/opt/coord/vaults',
  keyProvider: createKeyProvider(),
});
```

## Migration Notes

- No backward compatibility needed (fresh start)
- Existing encrypted files are NOT compatible (different encryption scheme)
- All vault data must be re-encrypted after migration

## CLI Changes

The TypeScript CLI replaces Python CLI:

**Before (Python):**
```bash
python3 scripts/sync/kvcrypt.py put tk '{"key": "value"}'
python3 scripts/sync/kvcrypt.py get tk key
```

**After (TypeScript):**
```bash
npx kvcrypt put tk '{"key": "value"}'
npx kvcrypt get tk key
```

## Implementation Order

1. Create `key-provider.ts` with both production and test providers
2. Modify `store.ts` to use KeyProvider
3. Update/fix all test files to use test provider
4. Create TypeScript CLI (`bin/kvcrypt.ts`)
5. Delete all Python files
6. Update documentation (CONTROL_PLANE_DESIGN.md CLI examples)

## Security Considerations

- Key files protected by Linux ACLs (not encryption)
- Disk-level encryption (LUKS) provides additional protection
- No network dependency for encryption operations
- Key rotation: Generate new key, re-encrypt all vaults, delete old key
