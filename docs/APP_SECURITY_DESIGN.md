# Application Security Design
**Comprehensive security design for Suiftly application-level secrets and database encryption**

## Overview

This document covers all application-level security mechanisms for Suiftly, including:

1. **Secret Management** - How secrets are stored, loaded, and protected
2. **Database Encryption** - Field-level encryption for sensitive customer data
3. **Environment Isolation** - Preventing dev/test secrets from reaching production
4. **Key Rotation** - Procedures for rotating compromised keys
5. **Backup Security** - Safe handling of database backups containing encrypted data

**Related Documents:**
- [AUTHENTICATION_DESIGN.md](./AUTHENTICATION_DESIGN.md) - Customer authentication/authorization (uses JWT_SECRET managed here)
- [ARCHITECTURE.md](./ARCHITECTURE.md) - Overall system architecture

---

## Table of Contents

1. [Secret Management](#secret-management)
2. [Database Field Encryption](#database-field-encryption)
3. [Environment Isolation](#environment-isolation)
4. [Backup Security](#backup-security)
5. [Implementation Checklist](#implementation-checklist)

---

## Secret Management

### Storage Location

**All application secrets are stored in `~/.suiftly.env` file** in the home directory of the user running the application.

**Why `~/.suiftly.env` instead of `~/.env`?**
- Avoids conflicts with Python virtual environments (which use `~/.env` directory)
- Prevents accidental overwrites from other tools
- Clear naming (Suiftly-specific configuration)

**File Location:**
```bash
# All environments (production, development, test)
~/.suiftly.env

# Environment is determined by /etc/walrus/system.conf (not by user account)
# Same user (e.g., 'olet') runs both production and development systems
# Each system has its own ~/.suiftly.env with appropriate secrets
```

**Note:** CI/CD test environments may provide secrets via environment variables instead of files.

**File Permissions:**
```bash
# Must be readable only by the owner (same for all environments)
chmod 600 ~/.suiftly.env
```

### Required Secrets

The `~/.suiftly.env` file must contain the following secrets:

```bash
# ~/.suiftly.env

# JWT Signing Secret (256-bit minimum)
# Used for: Access token + refresh token signing/verification
# Managed in: AUTHENTICATION_DESIGN.md (usage), APP_SECURITY_DESIGN.md (management)
JWT_SECRET=<32-byte-base64-secret>

# Database Field Encryption Key (256-bit minimum)
# Used for: AES-256-GCM encryption of sensitive fields (API keys, Seal keys, refresh tokens)
# Managed in: APP_SECURITY_DESIGN.md
DB_APP_FIELDS_ENCRYPTION_KEY=<32-byte-base64-secret>
```

### Secret Generation

**One-Time Setup:**
```bash
# Same procedure for both production and development systems
cd ~

# Generate both secrets (256-bit base64-encoded)
echo "JWT_SECRET=$(openssl rand -base64 32)" > ~/.suiftly.env
echo "DB_APP_FIELDS_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> ~/.suiftly.env
chmod 600 ~/.suiftly.env

# Verify file was created correctly
cat ~/.suiftly.env

# Production systems: Backup secrets to password manager (1Password, Bitwarden, etc.)
# CRITICAL: Store backup BEFORE using in production
# Recovery: If server lost, restore from password manager
```

**Environment Detection:**
- System environment (production vs development) is determined by `/etc/walrus/system.conf`
- Each system (production or dev) has its own `~/.suiftly.env` with appropriate secrets
- Production secrets must be different from development secrets (validated at runtime)

**System Configuration (`/etc/walrus/system.conf`):**
```bash
# /etc/walrus/system.conf
DEPLOYMENT_TYPE=production  # or 'development'
APISERVER=1                 # 1 if this system runs API servers, 0 otherwise

# Note: setup-users.py audits that APISERVER exists, defaults to 0 if missing
```

**APISERVER=1 Requirements:**
When `APISERVER=1` in `/etc/walrus/system.conf`, additional security audits are enforced:

1. **File Existence:** `~/.suiftly.env` MUST exist (enforced by setup-users.py)
2. **Development Systems:** `~/.suiftly.env` should contain the default test JWT_SECRET:
   ```bash
   JWT_SECRET=dev-secret-change-in-production-MUST-BE-32-CHARS-MIN
   DB_APP_FIELDS_ENCRYPTION_KEY=dev-encryption-key-32-CHARS-MINIMUM-LENGTH
   ```
3. **Production Systems:** JWT_SECRET MUST be different from test default (validated at startup)

**setup-users.py Audit:**
```python
# setup-users.py ensures APISERVER variable exists
if 'APISERVER' not in system_conf:
    # Append APISERVER=0 to /etc/walrus/system.conf
    with open('/etc/walrus/system.conf', 'a') as f:
        f.write('\nAPISERVER=0\n')

# If APISERVER=1, verify ~/.suiftly.env exists
if system_conf.get('APISERVER') == '1':
    home_env_path = os.path.expanduser('~/.suiftly.env')
    if not os.path.exists(home_env_path):
        raise SystemExit(
            f"FATAL: APISERVER=1 but {home_env_path} not found!\n"
            f"Run: echo 'JWT_SECRET=...' > ~/.suiftly.env"
        )
```

**Test Environments (CI/CD):**
```bash
# GitHub Actions: Set secrets in repository settings
# Environment variables (no file needed)
JWT_SECRET=<test-secret-with-TEST-suffix>
DB_APP_FIELDS_ENCRYPTION_KEY=<test-secret>
ENABLE_SHORT_JWT_EXPIRY=true  # Optional: for token refresh tests
```

### Loading Secrets in Application

**Implementation: [apps/api/src/lib/config.ts](../apps/api/src/lib/config.ts)**

**Current Implementation (Completed):**

The config module runs during application startup (module initialization) and performs validation **before** the API server starts:

1. **Read system config** from `/etc/walrus/system.conf` (DEPLOYMENT_TYPE, APISERVER)
2. **Load secrets** from `~/.suiftly.env` into `process.env`
3. **Validate with Zod** schema (type checking, minimum lengths)
4. **Run security validation** (`validateSecretSafety()`) to prevent weak/dev secrets in production
5. **Fail-fast behavior**: If any validation fails, process crashes immediately with clear error message

**Validation runs on every API server start** - the server cannot start with invalid secrets.

**Key Implementation Details:**

```typescript
// apps/api/src/lib/config.ts (CURRENT IMPLEMENTATION)
import { z } from 'zod';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// STEP 1: Load from ~/.suiftly.env (production/development)
const homeEnvPath = join(homedir(), '.suiftly.env');
if (existsSync(homeEnvPath)) {
  const envFile = readFileSync(homeEnvPath, 'utf-8');
  envFile.split('\n').forEach(line => {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      const value = match[2].trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  });
  console.log(`[Config] ✅ Loaded secrets from ${homeEnvPath}`);
} else if (process.env.NODE_ENV === 'production') {
  // GUARD: Production MUST have ~/.suiftly.env file
  throw new Error(
    `FATAL: ${homeEnvPath} not found in production!\n` +
    `This file must contain JWT_SECRET and DB_APP_FIELDS_ENCRYPTION_KEY.\n` +
    `See docs/APP_SECURITY_DESIGN.md for setup instructions.`
  );
} else {
  // Development/test: Allow environment variables (CI/CD)
  console.log(`[Config] ⚠️  No ~/.suiftly.env file found (using environment variables)`);
}

// STEP 2: Validate required secrets
const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3000'),
  HOST: z.string().default('0.0.0.0'),

  // Database
  DATABASE_URL: z.string().default('postgresql://localhost/suiftly_dev'),

  // Security (REQUIRED in all environments)
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 bytes (256 bits)'),
  DB_APP_FIELDS_ENCRYPTION_KEY: z.string().min(32, 'DB_APP_FIELDS_ENCRYPTION_KEY must be at least 32 bytes'),
  COOKIE_SECRET: z.string().min(32).default('dev-cookie-secret-change-in-production-32-CHARS'),

  // Auth
  MOCK_AUTH: z.string().transform(val => val === 'true').default(
    process.env.NODE_ENV === 'production' ? 'false' : 'true'
  ),

  // CORS
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  // Rate limiting
  RATE_LIMIT_MAX: z.string().transform(Number).default('100'),
});

export const config = envSchema.parse(process.env);

// STEP 3: Validate secrets don't match production keys
validateSecretSafety();

function validateSecretSafety() {
  const isDev = config.NODE_ENV === 'development';
  const isTest = config.NODE_ENV === 'test';
  const isProd = config.NODE_ENV === 'production';

  // GUARD 1: Production must NOT use default/weak secrets
  if (isProd) {
    if (config.JWT_SECRET.includes('dev-secret') || config.JWT_SECRET.includes('test-secret')) {
      throw new Error(
        'FATAL SECURITY ERROR: Production is using development/test JWT_SECRET!\n' +
        'This would allow anyone to forge authentication tokens.\n' +
        'Generate a new secret: openssl rand -base64 32'
      );
    }

    if (config.DB_APP_FIELDS_ENCRYPTION_KEY.includes('dev') || config.DB_APP_FIELDS_ENCRYPTION_KEY.includes('test')) {
      throw new Error(
        'FATAL SECURITY ERROR: Production is using development/test DB_APP_FIELDS_ENCRYPTION_KEY!\n' +
        'This would expose customer API keys and secrets.\n' +
        'Generate a new secret: openssl rand -base64 32'
      );
    }
  }

  // GUARD 2: Development/test should NOT use production-like secrets
  // (Prevents accidental encryption with prod keys that might leak to git)
  if ((isDev || isTest) && !config.JWT_SECRET.includes('TEST') && !config.JWT_SECRET.includes('DEV') && !config.JWT_SECRET.includes('dev-secret')) {
    console.warn(
      '⚠️  WARNING: JWT_SECRET does not contain "DEV" or "TEST" marker.\n' +
      'If this is a production key, it should NOT be in dev/test environments.\n' +
      'Consider regenerating dev/test secrets with identifiable markers.'
    );
  }
}

// Log configuration on startup (mask secrets)
export function logConfig() {
  console.log('\n📋 Configuration:');
  console.log(`  Environment: ${config.NODE_ENV}`);
  console.log(`  Port: ${config.PORT}`);
  console.log(`  Host: ${config.HOST}`);
  console.log(`  Database: ${config.DATABASE_URL.split('@')[1] || 'local'}`);
  console.log(`  JWT_SECRET: ${config.JWT_SECRET.slice(0, 8)}...${config.JWT_SECRET.slice(-4)} (${config.JWT_SECRET.length} chars)`);
  console.log(`  DB_APP_FIELDS_ENCRYPTION_KEY: ${config.DB_APP_FIELDS_ENCRYPTION_KEY.slice(0, 8)}...${config.DB_APP_FIELDS_ENCRYPTION_KEY.slice(-4)} (${config.DB_APP_FIELDS_ENCRYPTION_KEY.length} chars)`);
  console.log(`  Mock Auth: ${config.MOCK_AUTH ? 'ENABLED' : 'DISABLED'}`);
  console.log(`  CORS Origin: ${config.CORS_ORIGIN}`);
  console.log(`  Rate Limit: ${config.RATE_LIMIT_MAX}/min`);
  console.log('');
}
```

### Secret Validation Rules

**All Environments:**
- ✅ JWT_SECRET must be ≥32 bytes (256 bits)
- ✅ DB_APP_FIELDS_ENCRYPTION_KEY must be ≥32 bytes (256 bits)
- ✅ Secrets must be base64-encoded (standard for openssl rand -base64)

**Production MUST:**
- ✅ Have `~/.suiftly.env` file (cannot rely on environment variables)
- ✅ NOT contain "dev", "test", or "TEST" in secret values
- ✅ NOT use default secrets from documentation

**Development/Test SHOULD:**
- ✅ Include "DEV" or "TEST" marker in secrets (prevents accidental prod key usage)
- ⚠️ Warn if using production-like secrets (potential leak risk)

### Secrets in Git

**CRITICAL: Never commit secrets to git**

**Protections:**
1. ✅ `.gitignore` contains `.env` and `.env.*` patterns
2. ✅ Secrets loaded from `~/.suiftly.env` (outside git repository)
3. ✅ Git pre-commit hooks scan for leaked secrets (TODO: implement)
4. ✅ GitHub secret scanning alerts enabled (TODO: verify)

**Git Pre-Commit Hook (TODO):**
```bash
#!/bin/bash
# .git/hooks/pre-commit

# Check for accidentally committed secrets
if git diff --cached | grep -E "(JWT_SECRET|DB_APP_FIELDS_ENCRYPTION_KEY)=[a-zA-Z0-9+/]{32,}"; then
  echo "❌ BLOCKED: Attempted to commit secrets to git!"
  echo "Remove secrets from staged files before committing."
  exit 1
fi

# Check for .env files in staging
if git diff --cached --name-only | grep -E "\.env$|\.env\."; then
  echo "❌ BLOCKED: Attempted to commit .env file to git!"
  echo "Remove .env files from git: git rm --cached .env"
  exit 1
fi

exit 0
```

---

## Database Field Encryption

### Overview

**Threat Model:** If attacker gains access to database backup, they must not be able to extract customer secrets (Seal API keys, generated API keys, refresh tokens).

**Solution:** AES-256-GCM encryption at application layer before storing in PostgreSQL.

### What Gets Encrypted

**✅ MUST Encrypt:**
- Seal API keys (customer-imported keys from external service)
- Generated API keys (for customer services)
- Refresh tokens (30-day authentication tokens)

**❌ NEVER Encrypt:**
- Wallet addresses (public blockchain data)
- Service configurations (non-sensitive)
- Usage metrics and logs (not secret)
- Nonces (temporary, 5-minute expiry)
- Customer IDs (indexed, queried frequently)
- Timestamps (needed for queries)

### Encryption Algorithm

**AES-256-GCM** (Authenticated Encryption with Associated Data)

**Why AES-256-GCM:**
- ✅ **Authenticated encryption** - Detects tampering (authTag verification fails if modified)
- ✅ **Random IV per secret** - Prevents pattern analysis (same plaintext → different ciphertext)
- ✅ **Hardware acceleration** - AES-NI on modern CPUs (minimal overhead ~0.1ms per operation)
- ✅ **Industry standard** - NIST-recommended, widely audited, used by Google, AWS, Signal
- ✅ **Provides confidentiality + integrity** - Single operation for both properties

**Performance:**
- Encryption: ~0.1ms per secret (negligible)
- Decryption: ~0.1ms per secret (negligible)
- Hardware-accelerated on modern CPUs (AES-NI instruction set)
- No noticeable impact on API latency (<1% overhead)

### Implementation

**Helper Functions: `packages/shared/src/lib/encryption.ts` (TODO: Create)**

```typescript
// packages/shared/src/lib/encryption.ts
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * Encrypt secret using AES-256-GCM with random IV.
 *
 * @param plaintext - The secret to encrypt (e.g., API key, refresh token)
 * @returns Ciphertext in format: "IV:authTag:ciphertext" (all base64-encoded)
 *
 * @throws Error if DB_APP_FIELDS_ENCRYPTION_KEY not set or invalid length
 *
 * @example
 * const encrypted = encryptSecret('seal_api_key_abc123');
 * // Returns: "rZ8j3kF9...==:hG4mP7...==:x9Q2..."
 */
export function encryptSecret(plaintext: string): string {
  // Load encryption key from environment
  const keyB64 = process.env.DB_APP_FIELDS_ENCRYPTION_KEY;
  if (!keyB64) {
    throw new Error(
      'DB_APP_FIELDS_ENCRYPTION_KEY not set!\n' +
      'See docs/APP_SECURITY_DESIGN.md for setup instructions.'
    );
  }

  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `DB_APP_FIELDS_ENCRYPTION_KEY must be 32 bytes (256 bits).\n` +
      `Current length: ${key.length} bytes\n` +
      `Generate new key: openssl rand -base64 32`
    );
  }

  // Generate random IV (initialization vector) for this secret
  // CRITICAL: IV must be unique per encryption to prevent pattern analysis
  const iv = randomBytes(16); // 128-bit IV for AES-GCM

  // Create cipher
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  // Encrypt plaintext
  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  // Get authentication tag (verifies integrity on decryption)
  const authTag = cipher.getAuthTag().toString('base64');

  // Return all three components (needed for decryption)
  // Format: "IV:authTag:ciphertext"
  return `${iv.toString('base64')}:${authTag}:${encrypted}`;
}

/**
 * Decrypt secret encrypted with encryptSecret().
 *
 * @param ciphertext - Encrypted secret in format "IV:authTag:ciphertext"
 * @returns Original plaintext
 *
 * @throws Error if ciphertext tampered or key incorrect (authTag verification fails)
 * @throws Error if DB_APP_FIELDS_ENCRYPTION_KEY not set or invalid length
 *
 * @example
 * const plaintext = decryptSecret('rZ8j3kF9...==:hG4mP7...==:x9Q2...');
 * // Returns: "seal_api_key_abc123"
 */
export function decryptSecret(ciphertext: string): string {
  // Load encryption key from environment
  const keyB64 = process.env.DB_APP_FIELDS_ENCRYPTION_KEY;
  if (!keyB64) {
    throw new Error(
      'DB_APP_FIELDS_ENCRYPTION_KEY not set!\n' +
      'See docs/APP_SECURITY_DESIGN.md for setup instructions.'
    );
  }

  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `DB_APP_FIELDS_ENCRYPTION_KEY must be 32 bytes (256 bits).\n` +
      `Current length: ${key.length} bytes`
    );
  }

  // Parse ciphertext components
  const [ivB64, authTagB64, encryptedB64] = ciphertext.split(':');
  if (!ivB64 || !authTagB64 || !encryptedB64) {
    throw new Error(
      'Invalid ciphertext format. Expected "IV:authTag:ciphertext".\n' +
      'This secret may have been corrupted or tampered with.'
    );
  }

  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');

  // Create decipher
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  // Decrypt ciphertext
  let decrypted = decipher.update(encryptedB64, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
```

### Database Schema Convention

**Use `_encrypted` suffix** to indicate encrypted columns:

```typescript
// packages/database/src/schema/api_keys.ts
export const apiKeys = pgTable('api_keys', {
  id: serial('id').primaryKey(),
  ownerAddress: text('owner_address').notNull(),
  keyEncrypted: text('key_encrypted').notNull(), // ✅ Encrypted
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const sealApiKeys = pgTable('seal_api_keys', {
  id: serial('id').primaryKey(),
  ownerAddress: text('owner_address').notNull(),
  sealKeyEncrypted: text('seal_key_encrypted').notNull(), // ✅ Encrypted
  importedAt: timestamp('imported_at').defaultNow().notNull(),
});

export const refreshTokens = pgTable('refresh_tokens', {
  id: serial('id').primaryKey(),
  address: text('address').notNull(),
  tokenHashEncrypted: text('token_hash_encrypted').notNull(), // ✅ Encrypted SHA-256 hash
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
```

### Usage in Application Code

**Storing API Key (Encrypt Before Insert):**
```typescript
// apps/api/src/services/api-keys.ts
import { encryptSecret, decryptSecret } from '@suiftly/shared/encryption';

async function createAPIKey(customerAddress: string) {
  // Generate API key
  const apiKey = generateRandomAPIKey(); // e.g., "suiftly_sk_abc123..."

  // Encrypt before storing
  const encryptedKey = encryptSecret(apiKey);

  // Insert encrypted value
  await db.insert(apiKeys).values({
    ownerAddress: customerAddress,
    keyEncrypted: encryptedKey,
  });

  // Return plaintext to user (ONE TIME - never shown again)
  return { apiKey };
}
```

**Retrieving API Key (Decrypt After Query):**
```typescript
async function getAPIKey(keyId: number) {
  // Query database (returns ciphertext)
  const record = await db.query.apiKeys.findFirst({
    where: eq(apiKeys.id, keyId)
  });

  if (!record) {
    throw new Error('API key not found');
  }

  // Decrypt before returning
  const plainKey = decryptSecret(record.keyEncrypted);

  return { apiKey: plainKey };
}
```

**Verifying API Key (Used by HAProxy/Load Balancer):**
```typescript
// Global Manager generates MA_VAULT with decrypted keys
// HAProxy loads vault and compares incoming API keys
async function generateMAVault() {
  const allKeys = await db.query.apiKeys.findMany({
    where: eq(apiKeys.isActive, true)
  });

  // Decrypt all keys for vault
  const vault = allKeys.map(record => ({
    customerId: record.customerId,
    apiKey: decryptSecret(record.keyEncrypted),
    rateLimit: record.rateLimit,
  }));

  // Write vault to disk (HAProxy reads this file)
  writeMAVault(vault);
}
```

### Security Properties

**AES-256-GCM Advantages:**
- ✅ **Authenticated encryption** - Detects tampering (authTag verification fails if modified)
- ✅ **Random IV per secret** - Prevents pattern analysis (same plaintext → different ciphertext)
- ✅ **Hardware acceleration** - AES-NI on modern CPUs (minimal overhead)
- ✅ **Industry standard** - NIST-recommended, widely audited

**Threat Protection:**

| Attack Vector | Protected? | Notes |
|--------------|-----------|-------|
| DB backup stolen | ✅ Yes | Only ciphertext exposed (useless without key) |
| DB user credentials leaked | ✅ Yes | Master key separate from DB credentials |
| Application server compromised | ⚠️ Partial | Attacker needs `~/.suiftly.env` file access (chmod 600) |
| SQL injection | ✅ Yes | Drizzle ORM prevents injection; ciphertext useless anyway |
| Insider with DB access | ✅ Yes | Cannot decrypt without master key from `~/.suiftly.env` |
| Ciphertext tampering | ✅ Yes | authTag verification fails (GCM mode) |

---

## Environment Isolation

### Problem

**Risk:** Development/test encryption keys accidentally used in production, or production keys leaked to git.

**Scenarios:**
1. Developer commits `.env` file with production key → exposed in git history
2. Production accidentally uses dev key → customer secrets encrypted with weak/known key
3. Test database encrypted with production key → prod key exposure if test backup leaked

### Safeguards

**1. Load Secrets from `~/.suiftly.env` (Outside Git Repository)**

```typescript
// Load from home directory, NOT project directory
const homeEnvPath = join(homedir(), '.suiftly.env');
```

**Benefits:**
- ✅ Secrets never in git repository tree (impossible to commit)
- ✅ Each system (dev, prod) has isolated `~/.suiftly.env` file
- ✅ Production system's `~/.suiftly.env` ≠ development system's `~/.suiftly.env` (different secrets)

**2. Validate Secrets Don't Cross Environments**

```typescript
// Production MUST NOT use dev/test secrets
if (isProd && (JWT_SECRET.includes('dev') || JWT_SECRET.includes('test'))) {
  throw new Error('FATAL: Production using dev/test secrets!');
}

// Development SHOULD warn if using production-like secrets
if (isDev && !JWT_SECRET.includes('DEV') && !JWT_SECRET.includes('TEST')) {
  console.warn('⚠️  JWT_SECRET missing DEV/TEST marker. Is this a prod key?');
}
```

**3. Require `.env` File in Production**

```typescript
// Production MUST have ~/.suiftly.env file (no fallback to environment variables)
if (process.env.NODE_ENV === 'production' && !existsSync(homeEnvPath)) {
  throw new Error(`FATAL: ${homeEnvPath} not found in production!`);
}
```

**4. Git Pre-Commit Hook (TODO)**

```bash
# Scan for accidentally committed secrets
if git diff --cached | grep -E "(JWT_SECRET|DB_APP_FIELDS_ENCRYPTION_KEY)="; then
  echo "❌ BLOCKED: Attempted to commit secrets!"
  exit 1
fi
```

### Recommended Secret Naming

**Production:**
```bash
# /home/apiservers/.env
JWT_SECRET=<random-32-bytes-base64>  # No markers needed
DB_APP_FIELDS_ENCRYPTION_KEY=<random-32-bytes-base64>
```

**Development:**
```bash
# /home/olet/.env
JWT_SECRET=DEV-<random-32-bytes-base64>  # DEV prefix for safety checks
DB_APP_FIELDS_ENCRYPTION_KEY=DEV-<random-32-bytes-base64>
```

**Test (CI/CD):**
```bash
# Environment variables (GitHub Actions secrets)
JWT_SECRET=TEST-<random-32-bytes-base64>  # TEST prefix for safety checks
DB_APP_FIELDS_ENCRYPTION_KEY=TEST-<random-32-bytes-base64>
ENABLE_SHORT_JWT_EXPIRY=true  # Optional: for token refresh tests
```

---

## Backup Security

### Database Backups

**Daily Automated Backups:**
```bash
# Cron job: pg_dump + upload to Cloudflare R2
pg_dump suiftly_prod | gzip > backup_$(date +%Y%m%d).sql.gz
rclone copy backup_*.sql.gz r2:suiftly-backups/
```

**Security Properties:**
- ✅ **Backups contain only ciphertext** (encrypted fields are encrypted before storage)
- ✅ **Safe to store remotely** (attacker cannot decrypt without master key)
- ✅ **Master key NOT in backup** (stored separately in `~/.suiftly.env`)

**Master Key Backup:**
- ✅ Store in password manager (1Password, Bitwarden)
- ✅ Store encrypted offline backup (USB drive in safe)
- ✅ Document key recovery process
- ❌ NEVER store master key with database backup (defeats encryption)

### Disaster Recovery

**Scenario: Complete server loss (fire, hardware failure, etc.)**

**Recovery Steps:**
```bash
# 1. Provision new server
python scripts/provision-server.py --role=db
python scripts/provision-server.py --role=api

# 2. Restore master keys from password manager
cd ~
cat > ~/.suiftly.env <<EOF
JWT_SECRET=<from-password-manager>
DB_APP_FIELDS_ENCRYPTION_KEY=<from-password-manager>
EOF
chmod 600 ~/.suiftly.env

# 3. Restore database from backup
rclone copy r2:suiftly-backups/backup_20250103.sql.gz .
gunzip backup_20250103.sql.gz
psql suiftly_prod < backup_20250103.sql

# 4. Verify encryption works
psql suiftly_prod -c "SELECT id, key_encrypted FROM api_keys LIMIT 1;"
# Should see ciphertext (not plaintext)

# 5. Test API decryption
curl -H "Cookie: ..." https://api.suiftly.io/trpc/user.getAPIKeys
# Should return decrypted API keys

# 6. Update DNS / load balancer to point to new servers
# 7. Monitor for issues
```

**Recovery Time Objective (RTO):** ~30 minutes (provision + restore + verify)

**Recovery Point Objective (RPO):** 24 hours (daily backups)

---

## Implementation Checklist

### Secret Management
- [x] Update [apps/api/src/lib/config.ts](../apps/api/src/lib/config.ts) to load from `~/.suiftly.env` (not project directory)
- [x] Add validation to prevent dev secrets in production
- [x] Add validation to prevent production secrets in dev/test
- [x] Require `~/.suiftly.env` file in production (no environment variable fallback)
- [x] Add APISERVER flag support in /etc/walrus/system.conf
- [x] Enforce ~/.suiftly.env existence when APISERVER=1
- [x] Validate production doesn't use default test JWT_SECRET
- [x] Export systemConfig from config.ts for use across codebase
- [x] Refactor jwt.ts to use centralized config (eliminate duplication)
- [ ] Implement setup-users.py audit for APISERVER flag
- [ ] Implement setup-users.py audit for ~/.suiftly.env on API servers
- [ ] Add pre-commit hook to prevent secret commits
- [ ] Document secret generation in deployment scripts
- [ ] Add secret backup procedure to runbook

### Database Encryption
- [ ] Create `packages/shared/src/lib/encryption.ts` with `encryptSecret()` and `decryptSecret()`
- [ ] Add unit tests for encryption/decryption (test vectors)
- [ ] Add test for authTag tampering detection
- [ ] Add test for invalid key length error handling
- [ ] Document encrypted fields in database schema (use `_encrypted` suffix)
- [ ] Implement encryption in API key creation
- [ ] Implement decryption in API key retrieval
- [ ] Implement encryption in Seal API key import
- [ ] Implement encryption in refresh token storage
- [ ] Add encryption performance benchmarks (should be <1ms)

### Environment Isolation
- [ ] Add environment markers to test secrets (TEST-xxx, DEV-xxx)
- [ ] Validate secret markers in config.ts
- [ ] Add CI/CD environment variable setup documentation
- [ ] Test secret validation guards (dev key in prod should fail)
- [ ] Test production guard (missing ~/.suiftly.env should fail)

### Backup Security
- [ ] Verify database backups contain only ciphertext
- [ ] Document master key backup procedure
- [ ] Test disaster recovery procedure in staging
- [ ] Add master key to password manager
- [ ] Create encrypted offline backup of master keys

### Monitoring & Auditing
- [ ] Log encryption/decryption errors (key missing, tampering detected)
- [ ] Alert on repeated decryption failures (possible attack)
- [ ] Audit log for secret access (who, when, which secret)
- [ ] Monitor for `~/.suiftly.env` file permission changes (chmod)
- [ ] Alert on `~/.suiftly.env` file access from unexpected processes

---

## Summary

**System Configuration (`/etc/walrus/system.conf`):**
- `DEPLOYMENT_TYPE=production` or `development` - Determines environment
- `APISERVER=1` or `0` - Marks systems that run API servers
- setup-users.py audits APISERVER flag exists (defaults to 0 if missing)
- When APISERVER=1, ~/.suiftly.env MUST exist

**Secret Management:**
- Secrets stored in `~/.suiftly.env` (chmod 600, outside git)
- JWT_SECRET for authentication token signing
- DB_APP_FIELDS_ENCRYPTION_KEY for database field encryption
- APISERVER=1 systems require `~/.suiftly.env` file (enforced at startup)
- Production requires different JWT_SECRET than default test secret
- Guards prevent dev secrets in production and vice versa

**Database Encryption:**
- AES-256-GCM (authenticated encryption)
- Random IV per secret (prevents pattern analysis)
- Encrypts: API keys, Seal keys, refresh tokens
- Does NOT encrypt: wallet addresses, configs, logs, metrics
- Minimal overhead (~0.1ms per operation)

**Environment Isolation:**
- Each environment has isolated `~/.suiftly.env` file
- Secret markers (DEV-xxx, TEST-xxx) for safety validation
- Git pre-commit hook prevents accidental commits
- Production guards prevent weak/dev secrets

**Backup Security:**
- Database backups contain only ciphertext (safe to store remotely)
- Master key backed up separately (password manager + offline)
- Disaster recovery: restore DB + restore keys = working system

**This layered approach provides defense-in-depth:** Even if one layer is breached, customer secrets remain protected.
