# Configuration Management

This document describes how Suiftly manages configuration values in the database and how to add new configuration keys.

## Overview

Suiftly uses a database-driven configuration system where configuration values are stored in the `config_global` table and loaded by the frontend at startup. This allows configuration changes without code deployments.

**Key principles:**
- Configuration is stored in PostgreSQL (`config_global` table)
- Frontend configuration keys start with `f` prefix
- Backend configuration keys start with `b` prefix
- API server automatically initializes missing keys on startup
- Frontend loads config once at startup for zero-cost access

## Architecture

### Backend: Configuration Initialization

The API server automatically ensures all required configuration keys exist in the database on startup.

**Location:** [apps/api/src/lib/init-config.ts](../apps/api/src/lib/init-config.ts)

**How it works:**
1. On server startup, `initializeFrontendConfig()` is called before listening for connections
2. Queries database for all existing frontend config keys (keys starting with `f`)
3. Compares against `DEFAULT_FRONTEND_CONFIG` object
4. Inserts any missing keys with default values
5. Logs which keys were added (if any)

**Key features:**
- Idempotent: Safe to run multiple times
- Zero-downtime: Works on existing production databases
- Automatic: No manual intervention required
- Visible: Logs clearly show what's happening

### Frontend: Configuration Loading

The frontend loads configuration once at startup before rendering the app.

**Location:** [apps/webapp/src/lib/config.ts](../apps/webapp/src/lib/config.ts)

**How it works:**
1. `loadFrontendConfig()` is called in `main.tsx` before rendering
2. Fetches all frontend config from backend via tRPC
3. Validates all required keys are present
4. Populates global variables for zero-cost access
5. Retries indefinitely if backend is unavailable

**Usage in frontend:**
```typescript
import { fsubs_usd_pro, mockAuth } from '@/lib/config';

// Direct variable access - fastest possible
const price = fsubs_usd_pro; // No function call overhead
const showMockWallet = mockAuth;
```

## Adding New Configuration Keys

Follow these steps to add a new configuration key to the system:

### Step 1: Add to Backend Initialization

Edit [apps/api/src/lib/init-config.ts](../apps/api/src/lib/init-config.ts):

```typescript
const DEFAULT_FRONTEND_CONFIG: Record<string, string> = {
  // ... existing keys ...

  // Your new key (use 'f' prefix for frontend, 'b' for backend)
  fnew_feature_enabled: 'true',
  fnew_feature_limit: '100',
};
```

### Step 2: Add to Frontend Config Interface

Edit [apps/webapp/src/lib/config.ts](../apps/webapp/src/lib/config.ts):

**A. Add export variable with default value:**
```typescript
// Frontend configuration variables (loaded once at startup)
export let fnew_feature_enabled = false;
export let fnew_feature_limit = 100;
```

**B. Add validation check:**
```typescript
// Validate that all required keys are present (mockAuth is optional)
if (!config.fver || !config.freg_count || /* ... existing checks ... */ ||
    !config.fnew_feature_enabled || !config.fnew_feature_limit) {
  throw new Error('Missing required configuration keys from database');
}
```

**C. Add loading logic:**
```typescript
// Populate global variables with values from backend (NO DEFAULTS)
fver = parseInt(config.fver);
// ... existing assignments ...
fnew_feature_enabled = config.fnew_feature_enabled === 'true';
fnew_feature_limit = parseInt(config.fnew_feature_limit);
```

### Step 3: Add to Migration (Optional)

If you want fresh databases to have the new keys from the start, add them to the initial migration:

Edit [packages/database/migrations/0000_fair_raza.sql](../packages/database/migrations/0000_fair_raza.sql):

```sql
-- Insert initial configuration values
INSERT INTO "config_global" ("key", "value") VALUES
  -- ... existing keys ...
  ('fnew_feature_enabled', 'true'),
  ('fnew_feature_limit', '100')
ON CONFLICT ("key") DO NOTHING;
```

**Note:** This step is optional because the API server initialization will add missing keys automatically. However, it's good practice to keep the migration file up-to-date.

### Step 4: Use in Your Code

**Backend:**
```typescript
// In API routes
import { db } from '@suiftly/database';
import { configGlobal } from '@suiftly/database/schema';

const config = await db.select()
  .from(configGlobal)
  .where(eq(configGlobal.key, 'fnew_feature_enabled'))
  .limit(1);
```

**Frontend:**
```typescript
import { fnew_feature_enabled, fnew_feature_limit } from '@/lib/config';

// Direct access - no function calls
if (fnew_feature_enabled) {
  console.log(`Feature limit: ${fnew_feature_limit}`);
}
```

### Step 5: Deploy

**Development:**
1. Restart API server - it will automatically insert the new keys
2. Refresh frontend - it will load the new values

**Production:**
1. Deploy code changes
2. Restart API server - initialization will add missing keys automatically
3. No manual database changes required!

## Configuration Types

### Frontend Configuration (f* keys)

These are public values loaded by the frontend at startup.

**Common use cases:**
- Feature flags (`f` prefix + boolean)
- Pricing values (`fsubs_*`, `fadd_*`)
- Resource limits (`fmax_*`, `fbw_*`)
- UI configuration

**Example keys:**
- `fver` - Configuration version (triggers frontend reload on mismatch)
- `fsubs_usd_pro` - Pro tier monthly price in USD
- `fmax_skey` - Maximum service keys allowed
- `mockAuth` - Show mock wallet for development (backend-controlled)

### Backend Configuration (b* keys)

These are private values used only by backend services.

**Common use cases:**
- API credentials
- Internal service URLs
- Background job settings
- Admin thresholds

## Modifying Configuration Values

### Development
Update directly in database:
```sql
UPDATE config_global
SET value = '50'
WHERE key = 'fsubs_usd_pro';
```

Then increment `fver` to trigger frontend reload:
```sql
UPDATE config_global
SET value = (value::int + 1)::text
WHERE key = 'fver';
```

### Production
Use admin interface or SQL migration to update values safely.

**Important:** Always increment `fver` after changing frontend config to force users to reload with new values.

## Special Configuration Keys

### mockAuth
- Type: Backend-controlled feature flag
- Source: `MOCK_AUTH` environment variable on API server
- Purpose: Controls Mock Wallet visibility in login page
- Note: Not stored in database, added by API at runtime

### fver
- Type: Version number
- Purpose: Frontend checks this on background polling
- Behavior: If server version differs, frontend reloads automatically
- Usage: Increment after any frontend config change

## Troubleshooting

### Missing Configuration Keys Error
**Symptom:** Frontend shows "Missing configuration key at database" and won't load

**Solution:** Restart API server - it will automatically insert missing keys from `DEFAULT_FRONTEND_CONFIG`

### Configuration Not Updating
**Symptom:** Changed database value but frontend still shows old value

**Solutions:**
1. Hard refresh browser (Ctrl+Shift+R)
2. Increment `fver` to force reload
3. Check browser console for config loading errors

### Production Database Missing Keys
**Symptom:** Production server fails to start or frontend won't load

**Solution:** The API server initialization handles this automatically. On startup it will:
1. Check which keys are missing
2. Insert defaults for missing keys
3. Log what was added
4. Continue normal startup

No manual intervention required!

## Files Reference

| File | Purpose |
|------|---------|
| [apps/api/src/lib/init-config.ts](../apps/api/src/lib/init-config.ts) | Backend initialization - adds missing keys on startup |
| [apps/webapp/src/lib/config.ts](../apps/webapp/src/lib/config.ts) | Frontend config loader - validates and loads from backend |
| [apps/api/src/routes/config.ts](../apps/api/src/routes/config.ts) | tRPC endpoint - serves config to frontend |
| [packages/database/migrations/0000_fair_raza.sql](../packages/database/migrations/0000_fair_raza.sql) | Initial migration - creates table with default values |
| [apps/webapp/src/main.tsx](../apps/webapp/src/main.tsx) | App entry point - loads config before rendering |

## Best Practices

1. **Always add defaults** - Every new key must have a default value in `init-config.ts`
2. **Validate in frontend** - Add validation check to ensure key exists
3. **Use appropriate types** - Parse to correct type (parseInt, parseFloat, === 'true')
4. **Increment fver** - After changing frontend config in production
5. **Document keys** - Add comments explaining what each key controls
6. **Test locally first** - Verify initialization works in development
7. **Use semantic names** - `fmax_skey` is better than `f_limit_1`

## Migration from Old System

If you previously added configuration keys manually:
1. Add them to `DEFAULT_FRONTEND_CONFIG` in `init-config.ts`
2. Restart API server - it will recognize they already exist
3. No data loss - existing keys are preserved

The initialization is idempotent and safe to run on databases with existing config data.
