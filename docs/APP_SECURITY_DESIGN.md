# Application Security Design

**Secret management and database field encryption for Suiftly**

## Quick Reference: ~/.suiftly.env

**Production:**
```bash
# ~/.suiftly.env (chmod 600)
JWT_SECRET=<32-byte-base64>
DB_APP_FIELDS_ENCRYPTION_KEY=<32-byte-base64>
COOKIE_SECRET=<32-byte-base64>
DATABASE_URL=postgresql://deploy:PROD_PASSWORD@localhost/suiftly_prod

# Generate: openssl rand -base64 32
# Backup to password manager BEFORE using in production
```

**Development (optional - config has safe defaults):**
```bash
# ~/.suiftly.env (chmod 600)
# These are base64-encoded 32-byte secrets with "dev" markers
JWT_SECRET=ZGV2LXNlY3JldC1mb3ItdGVzdGluZy1vbmx5ISEhISE=
DB_APP_FIELDS_ENCRYPTION_KEY=ZGV2LWVuY3J5cHRpb24ta2V5LXRlc3Qtb25seSEhISE=
COOKIE_SECRET=ZGV2LWNvb2tpZS1zZWNyZXQtdGVzdGluZy1vbmx5ISE=
DATABASE_URL=postgresql://deploy:deploy_password_change_me@localhost/suiftly_dev
```

---

## Secret Management

### Storage

**Location:** `~/.suiftly.env` (home directory, NOT project directory)
- **Why not `~/.env`?** Avoids conflicts with Python venv directories
- **Permissions:** `chmod 600 ~/.suiftly.env`
- **Production:** Each server has unique secrets backed up to password manager
- **Development:** Optional (config.ts provides safe defaults)
- **NEVER in git:** Secrets loaded from outside repository tree

### Required Secrets

| Secret | Purpose | Min Length | Notes |
|--------|---------|-----------|-------|
| `JWT_SECRET` | Sign/verify access & refresh tokens | 32 bytes | AUTHENTICATION_DESIGN.md |
| `DB_APP_FIELDS_ENCRYPTION_KEY` | Encrypt API keys, Seal keys, refresh tokens | 32 bytes | This doc |
| `COOKIE_SECRET` | Secure cookie signing | 32 bytes | Fastify cookie plugin |
| `DATABASE_URL` | PostgreSQL connection (contains password) | N/A | Production only |

### Environment Detection

**System config:** `/etc/walrus/system.conf`
```bash
DEPLOYMENT_TYPE=production  # or 'test' or 'development'
APISERVER=1                 # 1 = runs API servers, 0 = other role
```

**Guards (enforced at startup):**
- If `APISERVER=1`: `~/.suiftly.env` MUST exist
- If production: Secrets MUST NOT contain "dev" or "test" markers
- If production: Secrets MUST NOT match default test secrets

### Implementation

**See:** [apps/api/src/lib/config.ts](../apps/api/src/lib/config.ts)

**Startup sequence:**
1. Read `/etc/walrus/system.conf` (determine environment)
2. Load `~/.suiftly.env` into `process.env` (if exists)
3. Parse/validate with Zod schema (includes dev defaults)
4. Run `validateSecretSafety()` - blocks dev secrets in prod
5. Export `config` object for app use

**CRITICAL:** All code MUST use `config.DB_APP_FIELDS_ENCRYPTION_KEY`, NOT `process.env.DB_APP_FIELDS_ENCRYPTION_KEY`
- Reason: Defaults only applied to `config` object, not raw `process.env`
- Fixed files: encryption.ts, jwt-config.ts, auth.ts, rest-auth.ts, config.ts

### Variables NOT in .env Files

**`MOCK_AUTH`** - NEVER in `.env` files (can be Python directory)
- Defaults to `true` in dev/test, `false` in production based on `NODE_ENV`
- Override via environment variable if needed: `MOCK_AUTH=true npm run dev`

**`NODE_ENV`** - Set by startup scripts or CI/CD, not in `.env`

---

## Database Field Encryption

### What Gets Encrypted

**✅ Encrypt:** API keys, Seal API keys, refresh tokens (stored in `*_encrypted` columns)
**❌ Don't encrypt:** Wallet addresses, configs, logs, metrics, nonces, timestamps

**Note:** This encryption is for database storage security. For the cryptographic design of API key generation and encoding (AES-128-CTR with HMAC), see [API_KEY_DESIGN.md](API_KEY_DESIGN.md).

### Algorithm: AES-256-GCM

**Why AES-256-GCM:**
- Authenticated encryption (detects tampering via authTag)
- Random IV per encryption (prevents pattern analysis)
- Hardware accelerated (AES-NI)
- Minimal overhead (~0.1ms per operation)

**Format:** `IV:authTag:ciphertext` (all base64-encoded)

### Implementation

**See:** [apps/api/src/lib/encryption.ts](../apps/api/src/lib/encryption.ts)

```typescript
import { config } from './config.js';
import { encryptSecret, decryptSecret } from './encryption.js';

// Encrypt before storing
const encrypted = encryptSecret(apiKey);
await db.insert(apiKeys).values({ keyEncrypted: encrypted });

// Decrypt after querying
const record = await db.query.apiKeys.findFirst({ ... });
const plaintext = decryptSecret(record.keyEncrypted);
```

**Database convention:** Use `_encrypted` suffix for encrypted columns

### Security Properties

| Threat | Protected? |
|--------|-----------|
| DB backup stolen | ✅ Only ciphertext exposed |
| DB credentials leaked | ✅ Master key separate |
| SQL injection | ✅ Drizzle ORM + ciphertext useless |
| Ciphertext tampering | ✅ authTag verification fails |
| App server compromise | ⚠️ Need `~/.suiftly.env` access (chmod 600) |

---

## Environment Isolation

### Safeguards

1. **Secrets outside git:** `~/.suiftly.env` in home directory (impossible to commit)
2. **Environment markers:** Dev/test secrets contain "DEV" or "TEST" (validates not in prod)
3. **Production guards:** Crash if dev secrets detected in production
4. **Dev warnings:** Warn if production-like secret in dev/test

### Validation Rules

**Production MUST:**
- Have `~/.suiftly.env` file (no environment variable fallback)
- NOT contain "dev", "test", "DEV", "TEST" in secrets
- NOT match default test secrets from docs

**Dev/Test SHOULD:**
- Include "DEV" or "TEST" marker in secrets
- Warn if production-like secret detected

---

## Backup & Recovery

### Database Backups

**Properties:**
- ✅ Backups contain only ciphertext (safe to store remotely)
- ✅ Master key NOT in backup (stored separately)
- ✅ Attacker cannot decrypt without `DB_APP_FIELDS_ENCRYPTION_KEY`

**Master key backup:**
- Store in password manager (1Password/Bitwarden)
- Store encrypted offline backup (USB in safe)
- Document recovery process

### Disaster Recovery

```bash
# 1. Restore master key from password manager
echo "JWT_SECRET=..." > ~/.suiftly.env
echo "DB_APP_FIELDS_ENCRYPTION_KEY=..." >> ~/.suiftly.env
echo "COOKIE_SECRET=..." >> ~/.suiftly.env
echo "DATABASE_URL=..." >> ~/.suiftly.env
chmod 600 ~/.suiftly.env

# 2. Restore database from backup
psql suiftly_prod < backup.sql

# 3. Verify encryption works
curl https://api.suiftly.io/health
```

**RTO:** ~30 minutes | **RPO:** 24 hours (daily backups)

---

## Summary

**System enforces security through:**
1. Secrets in `~/.suiftly.env` (outside git, chmod 600)
2. Startup validation (crashes if weak/wrong secrets)
3. AES-256-GCM encryption (authenticated, random IV)
4. Environment isolation (dev secrets blocked in prod)
5. Backup security (only ciphertext in DB dumps)

**Defense in depth:** Even if one layer breached, secrets remain protected.
