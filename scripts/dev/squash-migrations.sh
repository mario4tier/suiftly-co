#!/bin/bash
# Squash all migrations into a single "initial schema" migration
# Use this during early development before production deployment

set -e  # Exit on error

echo "🔄 Migration Squash Tool"
echo "======================="
echo ""
echo "⚠️  WARNING: This will:"
echo "   - Delete all existing migrations"
echo "   - Generate a fresh initial migration from schema files"
echo "   - Require all developers to reset their databases"
echo ""
echo "❓ Have you coordinated with your team?"
echo "   Press Ctrl+C to cancel, or Enter to continue..."
read -r

# Navigate to database package
cd "$(dirname "$0")/../../packages/database"

# Step 1: Backup old migrations
echo ""
echo "1️⃣  Backing up existing migrations..."
if [ -d "migrations" ] && [ "$(ls -A migrations/*.sql 2>/dev/null)" ]; then
  BACKUP_DIR="../../.migration-backups/backup-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BACKUP_DIR"
  cp -r migrations "$BACKUP_DIR/"
  echo "   ✅ Backed up to: $BACKUP_DIR"
else
  echo "   ⚠️  No existing migrations found"
fi

# Step 2: Delete old migrations
echo "2️⃣  Deleting old migrations..."
rm -rf migrations/*
echo "   ✅ Migrations deleted"

# Step 3: Generate fresh migration from schema
echo "3️⃣  Generating fresh migration from schema..."
DATABASE_URL="postgresql://deploy:deploy_password_change_me@localhost/suiftly_dev" npm run db:generate
echo "   ✅ New migration generated"

# Step 4: Rename to descriptive name
echo "4️⃣  Renaming migration..."
cd migrations
GENERATED_FILE=$(ls 0000_*.sql 2>/dev/null | head -1)
if [ -n "$GENERATED_FILE" ]; then
  mv "$GENERATED_FILE" "0000_initial_schema.sql"
  echo "   ✅ Renamed to: 0000_initial_schema.sql"
else
  echo "   ⚠️  Warning: Could not find generated migration file"
fi

# Step 5: Update meta.json
cd meta
META_FILE=$(ls 0000_*.json 2>/dev/null | head -1)
if [ -n "$META_FILE" ]; then
  # Update the tag field in JSON
  sed -i 's/"tag": "[^"]*"/"tag": "0000_initial_schema"/' "$META_FILE"
  mv "$META_FILE" "0000_snapshot.json"
  echo "   ✅ Updated meta file"
fi

cd ../../..

echo ""
echo "✅ Migration squash complete!"
echo ""
echo "📋 Next steps for ALL developers:"
echo "   1. git pull  # Get the squashed migration"
echo "   2. ./scripts/dev/reset-database.sh  # Reset database"
echo "   3. Restart dev servers"
echo ""
echo "🚀 To commit these changes:"
echo "   git add packages/database/migrations/"
echo "   git commit -m 'chore: squash migrations to single initial schema'"
echo ""
