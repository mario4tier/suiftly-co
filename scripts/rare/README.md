# Rare Scripts

This directory contains scripts that are **rarely executed** - typically only during initial server setup or disaster recovery.

## Philosophy

These scripts are run **before** the application code exists on the server. They install system-level dependencies and create the environment where the application will run.

**Key principle:** These scripts install tools, NOT application code.

## Scripts

### setup-netops-server.py

**Purpose:** Idempotent server setup script that installs ALL dependencies for suiftly-co NetOps services.

**When to use:**
- Setting up a new development machine
- Initial production server setup
- Disaster recovery / rebuilding a server
- After cloning the repository to a fresh system

**What it installs:**
- System packages: git, curl, build-essential, python3-pip, etc.
- Node.js v22.x (from NodeSource)
- PM2 process manager
- PostgreSQL 17
- TimescaleDB 2.17+
- Nginx (unconfigured)
- Certbot (unconfigured, production only)
- Python packages: psycopg2-binary, python-dotenv, click
- System user: deploy
- Directories: /var/www/{api,webapp,global-manager}, /var/log/suiftly
- Databases (environment-aware):
  - **Dev machines**: suiftly_dev, suiftly_test
  - **Production machines**: suiftly_prod only

**Prerequisites:**
Before running this script, you **MUST** configure the system deployment type.

**Option 1: Use walrus configure-deployment.py (Recommended)**
```bash
# Interactive setup - creates /etc/walrus/system.conf
sudo ~/walrus/scripts/configure-deployment.py
```

**Option 2: Manual configuration**
```bash
# Create the config file manually
sudo mkdir -p /etc/walrus
sudo vim /etc/walrus/system.conf

# Add ONE of these lines:
DEPLOYMENT_TYPE=development   # For dev machines
DEPLOYMENT_TYPE=production    # For production machines
SERVER_TYPE=bare              # Server type (bare, ovh, hetzner, aws, gcp, azure)
```

**Usage:**
```bash
# Run the setup script
sudo python3 scripts/rare/setup-netops-server.py

# Run again to verify all checks pass (idempotent)
sudo python3 scripts/rare/setup-netops-server.py
```

**Environment Detection (Single Source of Truth):**
The script reads `DEPLOYMENT_TYPE` from `/etc/walrus/system.conf`:
- **DEPLOYMENT_TYPE=production**: Creates `suiftly_prod` only
- **DEPLOYMENT_TYPE=development**: Creates `suiftly_dev` and `suiftly_test`
- **File not found or DEPLOYMENT_TYPE not set**: Script fails with error

This ensures:
1. **Explicit configuration**: No assumptions, no guessing, no defaults
2. **Single source of truth**: One config file, no overrides
3. **Consistent with walrus**: Uses same config file as walrus infrastructure
4. **Security**: Dev and prod databases never coexist on same machine

**Idempotent:** Can be run multiple times safely. Checks if each component is already installed before attempting installation.

**Requirements:**
- Ubuntu 22.04 or 24.04
- Root privileges (must run with sudo)
- Internet connection

**Exit codes:**
- 0: Success (all dependencies installed)
- 1: Failure (check error message for details)

## Relationship to walrus/scripts/utilities

The walrus repository contains general-purpose utilities (`~/walrus/scripts/utilities/common.py`). This `setup-netops-server.py` script is **standalone** and doesn't depend on walrus utilities because it runs during initial setup when walrus may not be available.

## Next Steps After Running Setup

After Phase 0 (this script) completes successfully:

1. Verify setup: `sudo python3 scripts/rare/setup-netops-server.py`
2. Continue to Phase 1: Project scaffolding and npm setup
3. See [IMPLEMENTATION_PLAN.md](../../IMPLEMENTATION_PLAN.md) for full development sequence

## Working with Multiple Repos (suiftly-co + walrus)

**VSCode Multi-root Workspace:**
To work efficiently with both repos:

1. **Option 1:** File → Add Folder to Workspace (add both repos)
2. **Option 2:** Create `.code-workspace` file:
   ```json
   {
     "folders": [
       {"path": "/home/olet/suiftly-co"},
       {"path": "/home/olet/walrus"}
     ]
   }
   ```

This gives unified search, navigation, and Git operations across both repositories.
