#!/bin/bash
# Idempotent build script for suiftly-co workspace
# Builds mhaxbe dependencies first, then suiftly-co packages/services
#
# Usage: ./scripts/update-all.sh
#   - Do NOT run with sudo (builds should use your regular user)
#   - Safe to run multiple times (only rebuilds when source is newer than dist)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUIFTLY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MHAXBE_DIR="$(cd "$SUIFTLY_DIR/../mhaxbe" && pwd 2>/dev/null)" || true

# ============================================================================
# PREVENT RUNNING AS ROOT
# ============================================================================
if [ "$EUID" -eq 0 ]; then
  echo "ERROR: Do not run this script with sudo"
  echo "  Builds should run as your regular user to avoid root-owned files."
  echo "  Usage: ./scripts/update-all.sh"
  exit 1
fi

# ============================================================================
# Helper: check if a package needs building
# Returns 0 (true) if build is needed, 1 (false) if up to date
# ============================================================================
needs_build() {
  local pkg_dir="$1"

  # No dist/ at all -> needs build
  local dist_entry=""
  for name in dist/index.js dist/server.js; do
    if [ -f "$pkg_dir/$name" ]; then
      dist_entry="$pkg_dir/$name"
      break
    fi
  done
  if [ -z "$dist_entry" ]; then
    return 0
  fi

  # Check if any .ts file in src/ is newer than dist entry
  local dist_mtime
  dist_mtime=$(stat -c %Y "$dist_entry" 2>/dev/null) || return 0
  local newer
  newer=$(find "$pkg_dir/src" -name '*.ts' -newer "$dist_entry" -print -quit 2>/dev/null)
  if [ -n "$newer" ]; then
    return 0
  fi

  return 1
}

# ============================================================================
# Step 1: Build mhaxbe workspace packages (cross-repo dependencies)
# ============================================================================
if [ -z "$MHAXBE_DIR" ] || [ ! -d "$MHAXBE_DIR" ]; then
  echo "WARNING: mhaxbe directory not found at $SUIFTLY_DIR/../mhaxbe"
  echo "  GM depends on @mhaxbe packages - builds may fail without them."
  echo ""
else
  MHAXBE_NEEDS_BUILD=""
  for pkg_dir in "$MHAXBE_DIR"/packages/*/; do
    [ -d "$pkg_dir" ] || continue
    pkg_name=$(basename "$pkg_dir")
    # Only check packages that export from dist/
    if grep -q '"./dist/' "$pkg_dir/package.json" 2>/dev/null && needs_build "$pkg_dir"; then
      MHAXBE_NEEDS_BUILD="$MHAXBE_NEEDS_BUILD $pkg_name"
    fi
  done

  if [ -n "$MHAXBE_NEEDS_BUILD" ]; then
    echo "Building mhaxbe packages (stale:$MHAXBE_NEEDS_BUILD)..."
    (cd "$MHAXBE_DIR" && npm run build)
    echo "  mhaxbe packages built"
    echo ""
  else
    echo "mhaxbe packages: up to date"
  fi
fi

# ============================================================================
# Step 2: Install suiftly-co dependencies (if needed)
# ============================================================================
NODE_MODULES="$SUIFTLY_DIR/node_modules"
NEEDS_INSTALL=false

if [ ! -d "$NODE_MODULES" ]; then
  NEEDS_INSTALL=true
else
  # Check if package.json or package-lock.json is newer than node_modules
  for lock_file in "$SUIFTLY_DIR/package.json" "$SUIFTLY_DIR/package-lock.json"; do
    if [ -f "$lock_file" ] && [ "$lock_file" -nt "$NODE_MODULES" ]; then
      NEEDS_INSTALL=true
      break
    fi
  done
fi

if [ "$NEEDS_INSTALL" = true ]; then
  echo "Installing suiftly-co dependencies..."
  (cd "$SUIFTLY_DIR" && npm install)
  echo ""
else
  echo "suiftly-co dependencies: up to date"
fi

# ============================================================================
# Step 3: Build suiftly-co packages and services (turbo handles dependency order)
# ============================================================================
SUIFTLY_NEEDS_BUILD=""
for pkg_dir in "$SUIFTLY_DIR"/packages/*/ "$SUIFTLY_DIR"/services/*/; do
  [ -d "$pkg_dir" ] || continue
  [ -f "$pkg_dir/package.json" ] || continue
  pkg_name=$(basename "$pkg_dir")
  # Only check packages that have a build script and export from dist/
  if grep -q '"build"' "$pkg_dir/package.json" 2>/dev/null; then
    if grep -q '"./dist/' "$pkg_dir/package.json" 2>/dev/null && needs_build "$pkg_dir"; then
      SUIFTLY_NEEDS_BUILD="$SUIFTLY_NEEDS_BUILD $pkg_name"
    fi
  fi
done

if [ -n "$SUIFTLY_NEEDS_BUILD" ]; then
  echo "Building suiftly-co (stale:$SUIFTLY_NEEDS_BUILD)..."
  (cd "$SUIFTLY_DIR" && npm run build)
  echo ""
  echo "suiftly-co build complete"
else
  echo "suiftly-co build: up to date"
fi

echo ""
echo "All up to date."
