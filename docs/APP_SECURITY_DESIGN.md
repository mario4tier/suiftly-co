# Application Security Design

**Secret management and database field encryption for Suiftly**

## Quick Reference: ~/.suiftly.env

**Production:**
```bash
# ~/.suiftly.env (chmod 600)
JWT_SECRET=<32-byte-base64>
DB_APP_FIELDS_ENCRYPTION_KEY=<32-byte-base64>
COOKIE_SECRET=<32-byte-base64>
# X_API_KEY_SECRET: 64 hex chars - MUST be identical on API server AND all HAProxy nodes
X_API_KEY_SECRET=<64-hex-chars>
DATABASE_URL=postgresql://deploy:PROD_PASSWORD@localhost/suiftly_prod
# FLUENTD_DB_PASSWORD: For HAProxy log ingestion (fluentd-gm → PostgreSQL)
FLUENTD_DB_PASSWORD=<random-password>
# SEAL_MASTER_SEED_*: For keyserver nodes only (derives customer keys)
SEAL_MASTER_SEED_MAINNET=<0x + 64-hex-chars>
SEAL_MASTER_SEED_TESTNET=<0x + 64-hex-chars>

# Generate base64 secrets: openssl rand -base64 32
# Generate X_API_KEY_SECRET: python3 -c "import secrets; print(secrets.token_hex(32))"
# Generate FLUENTD_DB_PASSWORD: python3 -c "import secrets; print(secrets.token_urlsafe(24))"
# Generate SEAL_MASTER_SEED: python3 -c "import secrets; print('0x' + secrets.token_hex(32))"
# Backup to password manager BEFORE using in production
# CRITICAL: X_API_KEY_SECRET must be copied to all HAProxy nodes
# CRITICAL: SEAL_MASTER_SEED_* must be identical across all keyservers for the same network
```

**Development (optional - config has safe defaults):**
```bash
# ~/.suiftly.env (chmod 600)
# These are base64-encoded 32-byte secrets with "dev" markers
JWT_SECRET=ZGV2LXNlY3JldC1mb3ItdGVzdGluZy1vbmx5ISEhISE=
DB_APP_FIELDS_ENCRYPTION_KEY=ZGV2LWVuY3J5cHRpb24ta2V5LXRlc3Qtb25seSEhISE=
COOKIE_SECRET=ZGV2LWNvb2tpZS1zZWNyZXQtdGVzdGluZy1vbmx5ISE=
# X_API_KEY_SECRET: 64 hex chars (shared with HAProxy test infrastructure)
X_API_KEY_SECRET=8776c4c0e84428c6e86fca4647abe16459649aa78fe4c72e7643dc3a14343337
DATABASE_URL=postgresql://deploy:deploy_password_change_me@localhost/suiftly_dev
# FLUENTD_DB_PASSWORD: For HAProxy log ingestion (auto-set by setup-user.py)
FLUENTD_DB_PASSWORD=fluentd_dev_password
# SEAL_MASTER_SEED_*: Test seeds for development (NEVER use in production!)
SEAL_MASTER_SEED_MAINNET=0x5d175fc5977e9a65c199a43025988a3219e1f3e2efe7c2688c0a4a9427b8e216
SEAL_MASTER_SEED_TESTNET=0xf045c830cd9940bc2f367609dc25c946fdbfa325b958bfd850b1691d5376e6ce
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

| Secret | Purpose | Format | Notes |
|--------|---------|--------|-------|
| `JWT_SECRET` | Sign/verify access & refresh tokens | 32+ bytes base64 | AUTHENTICATION_DESIGN.md |
| `DB_APP_FIELDS_ENCRYPTION_KEY` | Encrypt DB fields (API keys, tokens) | 32+ bytes base64 | This doc |
| `COOKIE_SECRET` | Secure cookie signing | 32+ bytes base64 | Fastify cookie plugin |
| `X_API_KEY_SECRET` | Encrypt API keys for HAProxy validation | 64 hex chars (32 bytes) | Shared with HAProxy |
| `DATABASE_URL` | PostgreSQL connection (contains password) | URI | Production only |
| `FLUENTD_DB_PASSWORD` | fluentd-gm PostgreSQL user password | URL-safe string | Copied to /etc/fluentd/fluentd.env |
| `SEAL_MASTER_SEED_MAINNET` | Seal key derivation (mainnet keyservers) | 66 hex chars (0x + 32 bytes) | Keyserver nodes only |
| `SEAL_MASTER_SEED_TESTNET` | Seal key derivation (testnet keyservers) | 66 hex chars (0x + 32 bytes) | Keyserver nodes only |

### X_API_KEY_SECRET (Special Case)

**Purpose:** Encrypts the customer ID embedded in API keys (37-char format: `S<36-chars>`).

**Why separate from DB_APP_FIELDS_ENCRYPTION_KEY:**
- `DB_APP_FIELDS_ENCRYPTION_KEY`: AES-256-GCM for DB storage (API Server only)
- `X_API_KEY_SECRET`: AES-128-CTR + HMAC for API key encryption (shared with HAProxy Lua)

**Storage locations (different for each service):**

| Service | Location | Permissions | Why |
|---------|----------|-------------|-----|
| API Server | `~/.suiftly.env` | 600 (user only) | Loaded by config.ts at startup |
| HAProxy | `/etc/default/haproxy` | 600 (root only) | Sourced by systemd as root |
| fluentd-gm | `/etc/fluentd/fluentd.env` | 640 (root:fluentd) | Sourced by systemd for fluentd user |

**API Server** reads from user's home directory because it runs as a regular user.

**HAProxy** uses `/etc/default/haproxy` (a file, not a directory):
- Standard Debian/Ubuntu location for HAProxy environment variables
- Systemd's `EnvironmentFile=/etc/default/haproxy` sources this file **as root**
- HAProxy receives env vars from systemd (never reads the file directly)
- 600 permissions (root-only) protects the secret from other users

```bash
# /etc/default/haproxy (file contents)
X_API_KEY_SECRET="8776c4c0e84428c6e86fca4647abe16459649aa78fe4c72e7643dc3a14343337"
```

**fluentd-gm** uses `/etc/fluentd/fluentd.env`:
- Systemd's `EnvironmentFile=/etc/fluentd/fluentd.env` sources this file
- 640 permissions (root:fluentd) allows fluentd group to read
- Contains `FLUENTD_DB_PASSWORD` for PostgreSQL connection

```bash
# /etc/fluentd/fluentd.env (file contents)
FLUENTD_DB_PASSWORD=fluentd_dev_password
```

**Setup script** (`setup-user.py`) configures all locations automatically in dev/test.

**CRITICAL - Must be identical on:**
- API Server (`~/.suiftly.env`)
- All HAProxy nodes (`/etc/default/haproxy`)

**If keys differ:** HAProxy cannot decrypt API keys → all authenticated requests fail with 401

**See:** [API_KEY_DESIGN.md](API_KEY_DESIGN.md) for cryptographic details

### SEAL_MASTER_SEED (Keyserver Nodes Only)

**Purpose:** Derive customer encryption keys for Seal keyservers. Each customer key is derived from the master seed using a unique derivation index.

**Why two secrets:**
- `SEAL_MASTER_SEED_MAINNET`: For mainnet keyservers (mseal1, mseal2)
- `SEAL_MASTER_SEED_TESTNET`: For testnet keyservers (tseal1, tseal2)

**Format:** `0x` prefix + 64 hex characters (32 bytes)
```bash
# Generate a new master seed
python3 -c "import secrets; print('0x' + secrets.token_hex(32))"
```

**Storage (keyserver nodes only):**

| Role | Location | Notes |
|------|----------|-------|
| Keyserver | `~/.suiftly.env` | Loaded by seal-wrapper.sh at startup |
| API Server | Not needed | API servers don't derive keys |
| HAProxy | Not needed | HAProxy doesn't derive keys |

**CRITICAL - Must be identical across:**
- All mainnet keyservers (mseal1, mseal2) → same `SEAL_MASTER_SEED_MAINNET`
- All testnet keyservers (tseal1, tseal2) → same `SEAL_MASTER_SEED_TESTNET`

**If seeds differ:** Keys derived on different keyservers won't match → decryption fails.

**Startup validation:**
The seal-wrapper.sh script validates that the required seed is present before starting the keyserver:
- Mainnet keyservers require `SEAL_MASTER_SEED_MAINNET`
- Testnet keyservers require `SEAL_MASTER_SEED_TESTNET`

**Development vs Production:**
- **Development:** Use test seeds from configs.py (already in the development example above)
- **Production:** Generate new seeds, store in password manager, copy to all keyserver nodes

**Security notes:**
- Master seeds are more sensitive than individual keys (compromise reveals ALL derived keys)
- Backup securely to password manager before deployment
- Never commit to git or include in container images

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
# 1. Restore API Server secrets from password manager
echo "JWT_SECRET=..." > ~/.suiftly.env
echo "DB_APP_FIELDS_ENCRYPTION_KEY=..." >> ~/.suiftly.env
echo "COOKIE_SECRET=..." >> ~/.suiftly.env
echo "X_API_KEY_SECRET=..." >> ~/.suiftly.env  # MUST match HAProxy nodes!
echo "DATABASE_URL=..." >> ~/.suiftly.env
echo "FLUENTD_DB_PASSWORD=..." >> ~/.suiftly.env
chmod 600 ~/.suiftly.env

# 2. Copy X_API_KEY_SECRET to all HAProxy nodes
# HAProxy uses /etc/default/haproxy (NOT ~/.suiftly.env)
ssh haproxy-node 'echo "X_API_KEY_SECRET=\"...\"" | sudo tee -a /etc/default/haproxy'
ssh haproxy-node 'sudo systemctl restart haproxy'

# 3. Copy FLUENTD_DB_PASSWORD to fluentd-gm nodes
# fluentd-gm uses /etc/fluentd/fluentd.env
ssh db-node 'echo "FLUENTD_DB_PASSWORD=..." | sudo tee /etc/fluentd/fluentd.env'
ssh db-node 'sudo chown root:fluentd /etc/fluentd/fluentd.env && sudo chmod 640 /etc/fluentd/fluentd.env'
ssh db-node 'sudo systemctl restart fluentd-gm'

# 4. Restore SEAL master seeds on keyserver nodes
# Each keyserver user needs the seed in their ~/.suiftly.env
ssh keyserver-node 'sudo -u mseal1 bash -c "echo SEAL_MASTER_SEED_MAINNET=... >> ~/.suiftly.env && chmod 600 ~/.suiftly.env"'
ssh keyserver-node 'sudo -u tseal1 bash -c "echo SEAL_MASTER_SEED_TESTNET=... >> ~/.suiftly.env && chmod 600 ~/.suiftly.env"'
# Repeat for mseal2, tseal2, etc.

# 5. Restore database from backup
psql suiftly_prod < backup.sql

# 6. Verify encryption works
curl https://api.suiftly.io/health

# 7. Restart keyserver services
ssh keyserver-node 'sudo systemctl restart mseal1 mseal2 tseal1 tseal2'
```

**RTO:** ~45 minutes | **RPO:** 24 hours (daily backups)

---

## Summary

**System enforces security through:**
1. Secrets in `~/.suiftly.env` (outside git, chmod 600)
2. Startup validation (crashes if weak/wrong secrets)
3. AES-256-GCM encryption for DB fields (authenticated, random IV)
4. AES-128-CTR + HMAC for API keys (shared with HAProxy)
5. Environment isolation (dev secrets blocked in prod)
6. Backup security (only ciphertext in DB dumps)

**Two encryption layers:**
- `DB_APP_FIELDS_ENCRYPTION_KEY`: Protects data at rest in database
- `X_API_KEY_SECRET`: Protects API keys in transit (HAProxy validation)

**Defense in depth:** Even if one layer breached, secrets remain protected.
