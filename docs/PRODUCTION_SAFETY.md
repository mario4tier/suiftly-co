# Production Safety Mechanisms

This document explains the safety mechanisms that prevent accidental database destruction in production.

## Overview

All destructive development scripts (e.g., `reset-database.sh`, `squash-migrations.sh`) have **four layers of protection** to prevent running on production systems.

## Safety Layers

### Layer 1: system.conf Environment Check ⭐ **PRIMARY SAFEGUARD**

**Location:** `/path/to/repo/system.conf`

```bash
# Development machine (system.conf)
ENVIRONMENT=development

# Production server (system.conf)
ENVIRONMENT=production  # ← Blocks all dev scripts
```

**How it works:**
- Production servers MUST have `ENVIRONMENT=production` in `system.conf`
- Dev scripts check this file first
- If `ENVIRONMENT=production`, script exits immediately with error

**Setup:**
```bash
# On production server:
cp system.conf.example system.conf
sed -i 's/ENVIRONMENT=development/ENVIRONMENT=production/' system.conf
chmod 600 system.conf  # Protect from accidental edits
```

---

### Layer 2: Database Name Blocking

**Blocked names:**
- `suiftly_prod`
- `suiftly_production`
- `production`
- `prod`
- `main`

**How it works:**
- Scripts check `$DB_NAME` environment variable
- If matches blocked list, exit with error
- Even if system.conf is missing, production DB names are blocked

**Test:**
```bash
# This will be blocked:
DB_NAME=suiftly_prod ./scripts/dev/reset-database.sh
# ❌ ERROR: Database name 'suiftly_prod' appears to be a production database
```

---

### Layer 3: Non-Standard Database Name Confirmation

**How it works:**
- Default expected name: `suiftly_dev`
- If `DB_NAME` is anything else, requires manual confirmation
- User must type the exact database name to proceed

**Example:**
```bash
DB_NAME=my_test_db ./scripts/dev/reset-database.sh

⚠️  WARNING: Non-standard database name detected: my_test_db
   Expected: suiftly_dev

   Type the database name exactly to confirm:
> my_test_db  ← Must type this exactly
```

---

### Layer 4: Remote Host Blocking

**How it works:**
- Scripts only allow `localhost` or `127.0.0.1`
- Production databases are typically on remote hosts
- Any remote host triggers error

**Test:**
```bash
# This will be blocked:
DB_HOST=db.production.example.com ./scripts/dev/reset-database.sh
# ❌ ERROR: Remote database host detected: db.production.example.com
```

---

## Protected Scripts

All scripts in `scripts/dev/` with destructive operations include these safeguards:

### ✅ Protected:
- `reset-database.sh` - Drops and recreates database
- `squash-migrations.sh` - Deletes migration history

### ⚠️ Review Before Adding:
When adding new destructive scripts, copy the safeguard block from `reset-database.sh`.

---

## Production Deployment Checklist

Before deploying to production:

- [ ] Create `system.conf` on production server
- [ ] Set `ENVIRONMENT=production` in `system.conf`
- [ ] Verify `system.conf` is not in git (`git status` should not show it)
- [ ] Use production database names (e.g., `suiftly_prod`)
- [ ] Database host should NOT be localhost
- [ ] Test that dev scripts are blocked:
  ```bash
  # Should fail on production:
  ./scripts/dev/reset-database.sh
  # ❌ ERROR: Production environment detected in system.conf
  ```

---

## How to Override (Emergency)

**⚠️ DANGER: Only for emergency recovery situations**

If you MUST run a dev script with overridden safeguards:

```bash
# 1. Temporarily rename system.conf
mv system.conf system.conf.backup

# 2. Run your command with explicit parameters
DB_NAME=suiftly_dev DB_HOST=localhost ./scripts/dev/reset-database.sh

# 3. IMMEDIATELY restore system.conf
mv system.conf.backup system.conf
```

**Never commit changes that disable safeguards!**

---

## Testing Safeguards

### Test 1: Production Environment Block
```bash
# Create test system.conf
echo "ENVIRONMENT=production" > system.conf

# Should be blocked:
./scripts/dev/reset-database.sh
# Expected: ❌ ERROR: Production environment detected

# Cleanup
rm system.conf
```

### Test 2: Production Database Name Block
```bash
# Should be blocked:
DB_NAME=suiftly_prod ./scripts/dev/reset-database.sh
# Expected: ❌ ERROR: Database name 'suiftly_prod' appears to be a production database
```

### Test 3: Remote Host Block
```bash
# Should be blocked:
DB_HOST=192.168.1.100 ./scripts/dev/reset-database.sh
# Expected: ❌ ERROR: Remote database host detected
```

### Test 4: Normal Development (Should Work)
```bash
# Should succeed:
DB_NAME=suiftly_dev DB_HOST=localhost ./scripts/dev/reset-database.sh
# Expected: ✅ Proceeds with confirmation prompt
```

---

## Emergency Contacts

If safeguards fail or block legitimate development work:

1. Check `system.conf` - is ENVIRONMENT correct?
2. Check database name - is it `suiftly_dev`?
3. Check hostname - is it `localhost`?
4. Contact team lead before overriding safeguards

---

## Implementation Details

**Safeguard code location:** Lines 8-61 in `scripts/dev/reset-database.sh`

**Key environment variables:**
- `ENVIRONMENT` - Set in system.conf
- `DB_NAME` - Database name to reset
- `DB_HOST` - Database hostname
- `DB_USER` - Database username
- `DB_PASSWORD` - Database password

**Exit codes:**
- `0` - Success (database reset completed)
- `1` - Blocked by safeguards (see error message)

---

## Philosophy

**Defense in depth:** Multiple independent safeguards

Even if one layer fails:
- Missing system.conf? → Database name check catches production DBs
- Typo in DB name? → Confirmation prompt catches it
- Remote host accidentally used? → Remote host check blocks it

**Fail-safe by default:** Scripts refuse to run unless explicitly cleared by all checks.

This is intentionally paranoid. Better to block legitimate dev work than risk production data loss.
