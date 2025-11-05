# Migration Squash Guide

**When to use:** Early development stage with no production data.

## Prerequisites

- [ ] All developers have committed their work
- [ ] No production database exists
- [ ] Team is coordinated for database reset

## Step 1: Backup Current Schema Definition

```bash
# Your schema files are the source of truth - already in git ✅
cd packages/database/src/schema
git status  # Ensure all schema changes are committed
```

## Step 2: Delete Old Migrations

```bash
cd packages/database

# Backup old migrations (optional - for reference)
mkdir -p ../../.migration-backup
cp -r migrations ../../.migration-backup/migrations-$(date +%Y%m%d)

# Delete old migrations
rm -rf migrations/*
```

## Step 3: Generate Fresh Migration from Current Schema

```bash
# Generate new single migration from current schema
DATABASE_URL="postgresql://deploy:deploy_password_change_me@localhost/suiftly_dev" npm run db:generate
```

This creates: `migrations/0000_initial_schema.sql` (or similar name)

## Step 4: Rename Migration for Clarity

```bash
cd migrations

# Find the generated migration
ls -l

# Rename to descriptive name
mv 0000_*.sql 0000_initial_schema.sql

# Update meta.json to match new filename
# Edit: migrations/meta/0000_snapshot.json (update "tag" field)
```

## Step 5: Reset All Developer Databases

**Coordinate with team:** Everyone runs these commands at the same time.

```bash
# Drop and recreate database
PGPASSWORD=deploy_password_change_me psql -h localhost -U deploy -c "DROP DATABASE IF EXISTS suiftly_dev;"
PGPASSWORD=deploy_password_change_me psql -h localhost -U deploy -c "CREATE DATABASE suiftly_dev;"

# Apply new migration
cd packages/database
DATABASE_URL="postgresql://deploy:deploy_password_change_me@localhost/suiftly_dev" npm run db:migrate
```

## Step 6: Verify and Commit

```bash
# Verify database state
DATABASE_URL="postgresql://deploy:deploy_password_change_me@localhost/suiftly_dev" npm run db:studio
# Check all tables exist and have correct structure

# Commit squashed migration
git add migrations/
git commit -m "chore: squash migrations to single initial schema

- Consolidated 5 migrations into single initial schema
- Clean slate for production-ready migration history
- All dev databases reset and synchronized"
```

## Step 7: Team Synchronization

Post in team chat:

```
🔄 Migration squash complete!

Action required:
1. Pull latest main
2. Run: ./scripts/dev/reset-database.sh
3. Restart dev servers

Database will be reset to clean state.
```

## When to Squash Again

Squash migrations periodically during pre-production:

- **Weekly** during rapid iteration (what you're doing now)
- **Before major milestones** (e.g., before adding new service types)
- **Last time before production launch** (final squash!)

After production launch: **NEVER squash** - use incremental migrations only.

## Alternative: Skip Migrations Until Production

If schema changes are frequent, consider:

```bash
# Add to .gitignore
echo "packages/database/migrations/" >> .gitignore

# Use push instead of migrate in development
npm run db:push  # Syncs schema directly, no migrations

# Generate migrations only when ready for production
```

This is how Django and Rails developers often work - migrations are generated before deployment, not during development.

## Troubleshooting

### Error: "Migration already applied"

```bash
# Drizzle tracks migrations in __drizzle_migrations table
# Drop this table to reset migration tracking
PGPASSWORD=deploy_password_change_me psql -h localhost -U deploy -d suiftly_dev -c "DROP TABLE IF EXISTS __drizzle_migrations;"
```

### Error: "Table already exists"

```bash
# Means you need a full reset - drop and recreate database
PGPASSWORD=deploy_password_change_me psql -h localhost -U deploy -c "DROP DATABASE IF EXISTS suiftly_dev CASCADE;"
PGPASSWORD=deploy_password_change_me psql -h localhost -U deploy -c "CREATE DATABASE suiftly_dev;"
```

### Schema Drift (schema and migrations out of sync)

```bash
# Let Drizzle regenerate from schema (source of truth)
rm -rf migrations/*
npm run db:generate
```

## Best Practices

1. **Schema files are source of truth** - Never edit migrations manually
2. **Squash frequently in development** - Keep migration count low
3. **Coordinate squashes** - Entire team resets at same time
4. **Document squash in commit message** - Explain what was consolidated
5. **Consider skipping migrations entirely** until production-ready

## Production Migration Strategy

Once you go to production:

1. **Stop squashing** - All changes are incremental
2. **Test migrations** - Apply to staging before production
3. **Rollback plan** - Keep down migrations (or snapshot backups)
4. **Zero-downtime** - Use blue-green deployments for schema changes
5. **Data migrations** - Separate from schema migrations

But that's a problem for future you! 🚀
