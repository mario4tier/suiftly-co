# Database Permissions Model

## Philosophy: Test Production Permissions in Development

We use **production-like minimal permissions** for the `deploy` user even in development. This ensures permission issues are caught early, not in production.

## Two-User Model

### 1. `postgres` (Superuser) - Database Administration
**Used for:**
- Database creation/deletion (`./scripts/dev/reset-database.sh`)
- Schema migrations (`npm run db:migrate`)
- Test data setup (`./scripts/dev/reset-test-data.sh`)
- TimescaleDB configuration
- Granting permissions

**Access:** Local only (sudo -u postgres), no password needed

### 2. `deploy` (Minimal Runtime User) - API Operations
**Used for:**
- API runtime operations (apps/api)
- Customer data queries
- Transaction processing
- Ledger operations

**Permissions (minimal, production-ready):**
```sql
-- Can connect to database
GRANT CONNECT ON DATABASE suiftly_dev TO deploy;

-- Can use public schema
GRANT USAGE ON SCHEMA public TO deploy;

-- Can read/write data (NO DDL - no CREATE, ALTER, DROP)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO deploy;

-- Can use sequences for auto-increment IDs
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO deploy;

-- Same permissions for future tables/sequences
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO deploy;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO deploy;
```

**What `deploy` CANNOT do (by design):**
- ❌ Create/alter/drop tables
- ❌ Create/drop databases
- ❌ Truncate tables
- ❌ Modify schema
- ❌ Create extensions
- ❌ Manage users/roles

## Configuration

### Development (.env files)
```bash
# packages/database/.env - Used by API at runtime
DATABASE_URL=postgresql://deploy:deploy_password_change_me@localhost/suiftly_dev

# For migrations/setup - use postgres
DATABASE_URL=postgresql://postgres@localhost/suiftly_dev
```

### Production
Same model, but:
- Use strong password for `deploy` user
- Consider renaming `postgres` superuser (security through obscurity)
- Firewall rules: only allow `deploy` user from application servers
- Disable `postgres` remote access

## Scripts Behavior

### `./scripts/dev/reset-database.sh`
1. Drops database (as postgres)
2. Creates fresh database (as postgres)
3. Installs TimescaleDB (as postgres)
4. Runs migrations (as postgres)
5. **Grants minimal permissions to deploy user**
6. Verifies permissions

### `./scripts/dev/reset-test-data.sh`
- Truncates all tables (as postgres)
- Fast reset for testing
- Preserves schema

### Playwright Tests
- Use test endpoints that operate as `deploy` user
- Test permission model is realistic
- If permission issue occurs, fix in dev (not prod)

## Verifying Permissions

Check what `deploy` user can do:

```bash
sudo -u postgres psql -d suiftly_dev <<EOF
-- List table privileges
SELECT grantee, privilege_type, table_name
FROM information_schema.table_privileges
WHERE grantee = 'deploy'
ORDER BY table_name, privilege_type;

-- List sequence privileges
SELECT grantee, privilege_type, sequence_name
FROM information_schema.usage_privileges
WHERE grantee = 'deploy'
ORDER BY sequence_name, privilege_type;
EOF
```

Expected output: SELECT, INSERT, UPDATE, DELETE on all tables, USAGE on sequences.

## Why This Matters

**Early detection of permission issues:**
- ❌ Bad: Deploy to production → permission denied → emergency fix
- ✅ Good: Run locally → permission denied → fix before deployment

**Examples:**
1. If code tries `ALTER TABLE` → fails in dev, not prod
2. If code needs new permission → add it intentionally, not as emergency grant
3. Migration runs as postgres → deploy user sees finished tables

## Troubleshooting

### "Permission denied for table X"
**Cause:** New table created but permissions not granted.

**Fix:** Re-run `./scripts/dev/reset-database.sh` to grant permissions on new tables.

### "Must be owner of table X"
**Cause:** Code trying to ALTER/DROP tables.

**Fix:** This is by design. Schema changes must go through migrations (as postgres).

### API can't connect
**Cause:** Check `packages/database/.env` uses `deploy` user.

**Fix:** Ensure `DATABASE_URL=postgresql://deploy:deploy_password_change_me@localhost/suiftly_dev`

## Production Checklist

- [ ] Change `deploy` password from default
- [ ] Verify `deploy` has only SELECT, INSERT, UPDATE, DELETE
- [ ] Test that API works with `deploy` user
- [ ] Disable `postgres` remote access
- [ ] Set up separate migration user (or use postgres locally only)
- [ ] Document who has postgres/superuser access
