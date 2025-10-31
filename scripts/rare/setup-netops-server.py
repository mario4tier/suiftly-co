#!/usr/bin/env python3
"""
Idempotent NetOps server setup for suiftly-co.

This script installs ALL dependencies needed for development and production.
Run repeatedly until all checks pass.

Philosophy: Only installs tools. Does NOT create application code. Idempotent.

Usage:
    sudo python3 scripts/rare/setup-netops-server.py

Requirements:
    - Must be run with sudo (needs root privileges for apt, user creation, etc.)
    - Ubuntu 24.04 or higher
    - nvm installed for the user (with Node.js v22)
    - Internet connection for package downloads

Note: Similar utilities exist in ~/walrus/scripts/utilities/common.py
      (get_current_user, etc.) but this script is standalone for initial setup.
"""

import os
import pwd
import re
import subprocess
import sys
from typing import Tuple


class Colors:
    """ANSI color codes for terminal output."""
    GREEN = '\033[92m'
    RED = '\033[91m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    RESET = '\033[0m'
    BOLD = '\033[1m'


class SetupContext:
    """Global context for setup script."""
    def __init__(self):
        self.failed_steps = []
        self.warnings = []


def print_step(msg: str):
    """Print a step message."""
    print(f"{Colors.BLUE}→{Colors.RESET} {msg}")


def print_success(msg: str):
    """Print success message with checkmark."""
    print(f"{Colors.GREEN}✓{Colors.RESET} {msg}")


def print_error(msg: str):
    """Print error message with X mark."""
    print(f"{Colors.RED}✗{Colors.RESET} {msg}")


def print_warning(msg: str):
    """Print warning message."""
    print(f"{Colors.YELLOW}⚠{Colors.RESET} {msg}")


def run_command(cmd: list[str], check: bool = True) -> Tuple[int, str, str]:
    """
    Run a shell command.

    Args:
        cmd: Command as list of strings
        check: Whether to raise exception on failure

    Returns:
        Tuple of (returncode, stdout, stderr)
    """
    try:
        result = subprocess.run(
            cmd,
            check=check,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        return (result.returncode, result.stdout, result.stderr)
    except subprocess.CalledProcessError as e:
        return (e.returncode, e.stdout, e.stderr)
    except FileNotFoundError:
        # Command doesn't exist
        return (127, "", f"Command not found: {cmd[0]}")


def check_ubuntu_version(context: SetupContext):
    """Check that we're running Ubuntu 24.04 or higher."""
    print_step("Checking Ubuntu version...")

    try:
        with open('/etc/os-release', 'r') as f:
            lines = f.readlines()

        os_info = {}
        for line in lines:
            if '=' in line:
                key, value = line.strip().split('=', 1)
                os_info[key] = value.strip('"')

        if os_info.get('ID') != 'ubuntu':
            raise Exception(f"Requires Ubuntu. Current OS: {os_info.get('ID', 'unknown')}")

        version = os_info.get('VERSION_ID', '')

        # Parse version as float (e.g., "24.04" -> 24.04, "25.04" -> 25.04)
        try:
            version_float = float(version)
        except ValueError:
            raise Exception(f"Could not parse Ubuntu version: {version}")

        if version_float < 24.04:
            raise Exception(f"Requires Ubuntu 24.04 or higher. Current: {version}")

        print_success(f"check_ubuntu_version (Ubuntu {version})")

    except Exception as e:
        print_error(f"check_ubuntu_version: {e}")
        sys.exit(1)


def check_nvm_installed(context: SetupContext):
    """Check that nvm is installed for the real user."""
    print_step("Checking nvm installation...")

    # Get the real user (not root, even when running with sudo)
    real_user = os.environ.get('SUDO_USER')
    if not real_user:
        # Not running with sudo, check current user
        real_user = os.environ.get('USER')

    if not real_user:
        print_error("Could not determine real user")
        sys.exit(1)

    try:
        user_info = pwd.getpwnam(real_user)
        home_dir = user_info[5]  # pw_dir is at index 5
    except KeyError:
        print_error(f"User not found: {real_user}")
        sys.exit(1)

    # Check if nvm is installed
    nvm_dir = os.path.join(home_dir, '.nvm')
    if not os.path.isdir(nvm_dir):
        print_error(f"nvm not found in {nvm_dir}")
        print_error("nvm is required for development.")
        print_error(f"\nInstall nvm for user '{real_user}':")
        print_error("  1. Exit sudo and run as your regular user:")
        print_error("     curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash")
        print_error("  2. Restart your shell or run:")
        print_error("     source ~/.bashrc")
        print_error("  3. Install Node.js v22:")
        print_error("     nvm install 22")
        print_error("     nvm use 22")
        print_error("  4. Then re-run this script")
        sys.exit(1)

    print_success(f"check_nvm_installed ({nvm_dir})")


def check_nvm_node_version(context: SetupContext):
    """Check that nvm has Node.js v22 installed."""
    print_step("Checking nvm Node.js version...")

    # Get the real user (not root)
    real_user = os.environ.get('SUDO_USER') or os.environ.get('USER')
    if not real_user:
        print_error("Could not determine real user")
        sys.exit(1)

    try:
        user_info = pwd.getpwnam(real_user)
        home_dir = user_info[5]  # pw_dir is at index 5
    except KeyError:
        print_error(f"User not found: {real_user}")
        sys.exit(1)

    nvm_dir = os.path.join(home_dir, '.nvm')

    # Check for Node v22 in nvm versions directory
    versions_dir = os.path.join(nvm_dir, 'versions', 'node')
    if not os.path.isdir(versions_dir):
        print_error("nvm versions directory not found")
        print_error(f"Run as user '{real_user}': nvm install 22")
        sys.exit(1)

    # Look for v22.x.x directories
    found_v22 = False
    latest_v22 = None
    try:
        for version_dir in os.listdir(versions_dir):
            if version_dir.startswith('v22.'):
                found_v22 = True
                latest_v22 = version_dir
                break
    except OSError:
        pass

    if not found_v22:
        print_error("Node.js v22 not found in nvm")
        print_error(f"Run as user '{real_user}':")
        print_error("  nvm install 22")
        print_error("  nvm use 22")
        sys.exit(1)

    print_success(f"check_nvm_node_version ({latest_v22})")


def install_system_packages(context: SetupContext):
    """Install base system packages."""
    print_step("Checking system packages...")

    # Base system packages
    base_packages = [
        'git',
        'curl',
        'build-essential',
        'python3-pip',
        'software-properties-common',
        'apt-transport-https',
        'ca-certificates',
        'gnupg',
        'lsb-release',
    ]

    # Playwright E2E testing dependencies
    # Required for headless browser testing
    playwright_packages = [
        'libnspr4',
        'libnss3',
    ]

    # Audio library (different package name between Ubuntu versions)
    # Ubuntu 24.04 uses libasound2t64, Ubuntu 22.04 uses libasound2
    # Try both, one will install
    audio_packages = ['libasound2t64', 'libasound2']

    # Combine all packages
    packages = base_packages + playwright_packages

    # Check which packages are missing
    missing = []
    for pkg in packages:
        returncode, stdout, stderr = run_command(['dpkg', '-s', pkg], check=False)
        if returncode != 0:
            missing.append(pkg)

    # Try to install the correct audio package for this Ubuntu version
    audio_installed = False
    for audio_pkg in audio_packages:
        returncode, stdout, stderr = run_command(['dpkg', '-s', audio_pkg], check=False)
        if returncode == 0:
            audio_installed = True
            break

    if not audio_installed:
        # Try installing the first audio package (will work on the right Ubuntu version)
        for audio_pkg in audio_packages:
            returncode, stdout, stderr = run_command(['apt', 'install', '-y', audio_pkg], check=False)
            if returncode == 0:
                audio_installed = True
                break

    if not missing and audio_installed:
        print_success("install_system_packages (all present)")
        return

    # Update package list
    print_step(f"Installing {len(missing)} system packages...")
    returncode, stdout, stderr = run_command(['apt', 'update'], check=False)
    if returncode != 0:
        print_error(f"apt update failed: {stderr}")
        print_error("Fix: sudo apt update && sudo apt --fix-broken install")
        sys.exit(1)

    # Install missing packages
    returncode, stdout, stderr = run_command(['apt', 'install', '-y'] + missing, check=False)
    if returncode != 0:
        print_error(f"Package installation failed: {stderr}")
        print_error("Fix: sudo apt --fix-broken install")
        sys.exit(1)

    print_success("install_system_packages")


def install_nodejs(context: SetupContext):
    """Install Node.js v22.x from NodeSource (system-wide)."""
    print_step("Checking Node.js installation...")

    # Check if node is installed system-wide (in root's PATH)
    returncode, stdout, stderr = run_command(['node', '--version'], check=False)

    if returncode == 0 and stdout.startswith('v22.'):
        print_success(f"install_nodejs ({stdout.strip()})")
        return

    if returncode == 0:
        # Wrong version installed - check if it's from nvm
        which_returncode, which_stdout, _ = run_command(['which', 'node'], check=False)
        node_path = which_stdout.strip() if which_returncode == 0 else "unknown"

        print_warning(f"Node.js {stdout.strip()} found at {node_path}, but v22.x required")

        if '.nvm' in node_path:
            print_error("Found nvm-managed Node.js in system PATH")
            print_error("This script requires system-wide Node.js v22 (not nvm)")
            print_error("\nFix: The node command should NOT resolve to nvm's version when running with sudo")
            print_error("Your nvm installation is fine for development, but PM2 needs system Node.js")
        else:
            print_error("Fix: Remove the wrong Node.js version:")
            print_error("  sudo apt purge nodejs npm")
            print_error("  Then re-run this script to install Node.js v22")
        sys.exit(1)

    if returncode == 127:
        # Command not found - check if user has nvm installation
        print_warning("Node.js not found in system PATH (required for system-wide use)")
        print_step("Note: If you have nvm installed, it's only available to your user")
        print_step("This script installs system-wide Node.js for PM2 and deployment")

    # Install Node.js 22.x
    print_step("Installing Node.js v22.x...")

    # Download and run NodeSource setup script
    returncode, stdout, stderr = run_command(
        ['curl', '-fsSL', 'https://deb.nodesource.com/setup_22.x'],
        check=False
    )
    if returncode != 0:
        print_error(f"Failed to download NodeSource setup: {stderr}")
        sys.exit(1)

    # Run setup script
    process = subprocess.Popen(
        ['bash', '-'],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )
    stdout_data, stderr_data = process.communicate(input=stdout)

    if process.returncode != 0:
        print_error(f"NodeSource setup failed: {stderr_data}")
        sys.exit(1)

    # Install nodejs
    returncode, stdout, stderr = run_command(['apt', 'install', '-y', 'nodejs'], check=False)
    if returncode != 0:
        print_error(f"Node.js installation failed: {stderr}")
        sys.exit(1)

    print_success("install_nodejs")


def install_npm_global_packages(context: SetupContext):
    """Install PM2 process manager."""
    print_step("Checking npm global packages...")

    # Check if PM2 is installed
    returncode, stdout, stderr = run_command(['pm2', '--version'], check=False)

    if returncode == 0:
        print_success(f"install_npm_global_packages (PM2 {stdout.strip()})")
        return

    # Install PM2
    print_step("Installing PM2...")
    returncode, stdout, stderr = run_command(['npm', 'install', '-g', 'pm2'], check=False)
    if returncode != 0:
        print_error(f"PM2 installation failed: {stderr}")
        sys.exit(1)

    print_success("install_npm_global_packages")


def install_postgresql(context: SetupContext):
    """Install PostgreSQL 17."""
    print_step("Checking PostgreSQL installation...")

    # Check if PostgreSQL 17 is installed
    returncode, stdout, stderr = run_command(['psql', '--version'], check=False)

    if returncode == 0:
        # Parse version - handles formats like "psql (PostgreSQL) 17.6 ..."
        version_match = re.search(r'PostgreSQL\)\s+(\d+)\.', stdout)
        if version_match:
            major_version = int(version_match.group(1))
            if major_version == 17:
                print_success(f"install_postgresql ({stdout.strip()})")
                return
            else:
                print_warning(f"PostgreSQL {major_version}.x found, but version 17.x required")
                print_error("Fix: Check PostgreSQL APT repository configuration")
                sys.exit(1)
        else:
            # Couldn't parse version
            print_warning(f"PostgreSQL found but couldn't parse version: {stdout.strip()}")
            print_error("Fix: Check PostgreSQL installation")
            sys.exit(1)

    # Add PostgreSQL APT repository
    print_step("Adding PostgreSQL APT repository...")

    # Create keyrings directory
    os.makedirs('/etc/apt/keyrings', exist_ok=True)

    # Download PostgreSQL GPG key
    returncode, stdout, stderr = run_command(
        ['curl', '-fsSL', 'https://www.postgresql.org/media/keys/ACCC4CF8.asc'],
        check=False
    )
    if returncode != 0:
        print_error(f"Failed to download PostgreSQL GPG key: {stderr}")
        sys.exit(1)

    # Save GPG key
    with open('/etc/apt/keyrings/postgresql.asc', 'w') as f:
        f.write(stdout)

    # Get Ubuntu codename
    returncode, stdout, stderr = run_command(['lsb_release', '-cs'], check=False)
    ubuntu_codename = stdout.strip()

    # Add repository
    with open('/etc/apt/sources.list.d/postgresql.list', 'w') as f:
        f.write(f"deb [signed-by=/etc/apt/keyrings/postgresql.asc] "
                f"https://apt.postgresql.org/pub/repos/apt "
                f"{ubuntu_codename}-pgdg main\n")

    # Update package list
    run_command(['apt', 'update'])

    # Install PostgreSQL 17
    print_step("Installing PostgreSQL 17...")
    returncode, stdout, stderr = run_command(
        ['apt', 'install', '-y', 'postgresql-17', 'postgresql-contrib-17'],
        check=False
    )
    if returncode != 0:
        print_error(f"PostgreSQL installation failed: {stderr}")
        print_error("Fix: Check PostgreSQL APT repo configuration")
        sys.exit(1)

    print_success("install_postgresql")


def install_timescaledb(context: SetupContext):
    """Install TimescaleDB extension for PostgreSQL 17."""
    print_step("Checking TimescaleDB installation...")

    # Check if TimescaleDB is already installed
    returncode, stdout, stderr = run_command(
        ['sudo', '-u', 'postgres', 'psql', '-t', '-c',
         "SELECT * FROM pg_available_extensions WHERE name='timescaledb';"],
        check=False
    )

    if returncode == 0 and stdout.strip():
        print_success("install_timescaledb (already installed)")
        return

    # Add Timescale APT repository
    print_step("Adding TimescaleDB APT repository...")

    # Create keyrings directory
    os.makedirs('/etc/apt/keyrings', exist_ok=True)

    # Download Timescale GPG key
    returncode, stdout, stderr = run_command(
        ['curl', '-fsSL', 'https://packagecloud.io/timescale/timescaledb/gpgkey'],
        check=False
    )
    if returncode != 0:
        print_error(f"Failed to download TimescaleDB GPG key: {stderr}")
        sys.exit(1)

    # Save GPG key
    with open('/etc/apt/keyrings/timescaledb.asc', 'w') as f:
        f.write(stdout)

    # Get Ubuntu codename
    returncode, stdout, stderr = run_command(['lsb_release', '-cs'], check=False)
    ubuntu_codename = stdout.strip()

    # TimescaleDB may not have packages for very new Ubuntu versions
    # Fall back to noble (24.04) for Ubuntu 25.04+
    supported_codenames = ['noble', 'jammy']  # 24.04, 22.04
    if ubuntu_codename not in supported_codenames:
        print_warning(f"Ubuntu {ubuntu_codename} not directly supported by TimescaleDB")
        print_step("Using Ubuntu 24.04 (noble) packages as fallback...")
        ubuntu_codename = 'noble'

    # Add repository
    with open('/etc/apt/sources.list.d/timescaledb.list', 'w') as f:
        f.write(f"deb [signed-by=/etc/apt/keyrings/timescaledb.asc] "
                f"https://packagecloud.io/timescale/timescaledb/ubuntu/ "
                f"{ubuntu_codename} main\n")

    # Update package list
    run_command(['apt', 'update'])

    # Install TimescaleDB
    print_step("Installing TimescaleDB 2.17+...")
    returncode, stdout, stderr = run_command(
        ['apt', 'install', '-y', 'timescaledb-2-postgresql-17'],
        check=False
    )
    if returncode != 0:
        print_error(f"TimescaleDB installation failed: {stderr}")
        print_error("Fix: TimescaleDB may not have packages for your Ubuntu version")
        print_error(f"     Tried repository for: {ubuntu_codename}")
        sys.exit(1)

    # Run timescaledb-tune
    print_step("Running timescaledb-tune...")
    returncode, stdout, stderr = run_command(['timescaledb-tune', '--quiet', '--yes'], check=False)
    if returncode != 0:
        print_warning(f"timescaledb-tune failed: {stderr}")
        context.warnings.append("TimescaleDB tune failed - may need manual configuration")

    # Restart PostgreSQL
    print_step("Restarting PostgreSQL...")
    run_command(['systemctl', 'restart', 'postgresql'])

    print_success("install_timescaledb")


def setup_postgresql_databases(context: SetupContext):
    """Create databases and enable TimescaleDB extension."""
    print_step("Setting up PostgreSQL databases...")

    # Single source of truth: /etc/walrus/system.conf
    # MUST exist and MUST have DEPLOYMENT_TYPE set
    system_conf_path = "/etc/walrus/system.conf"
    deployment_type = None

    # Check if system.conf exists
    if not os.path.exists(system_conf_path):
        print_error(f"Configuration file not found: {system_conf_path}")
        print_error("You must create /etc/walrus/system.conf with DEPLOYMENT_TYPE set")
        print_error("\nExample content:")
        print_error("  # For development machines:")
        print_error("  DEPLOYMENT_TYPE=development")
        print_error("")
        print_error("  # For production machines:")
        print_error("  DEPLOYMENT_TYPE=production")
        print_error("\nCreate it with:")
        print_error("  sudo mkdir -p /etc/walrus")
        print_error("  sudo vim /etc/walrus/system.conf")
        sys.exit(1)

    # Read DEPLOYMENT_TYPE from system.conf
    try:
        with open(system_conf_path, 'r') as f:
            for line in f:
                line = line.strip()
                if line.startswith('#') or not line:
                    continue
                if line.startswith('DEPLOYMENT_TYPE='):
                    deployment_type = line.split('=', 1)[1].strip('"\'').lower()
                    print_step(f"Read DEPLOYMENT_TYPE={deployment_type} from {system_conf_path}")
                    break
    except (PermissionError, IOError) as e:
        print_error(f"Could not read {system_conf_path}: {e}")
        sys.exit(1)

    # DEPLOYMENT_TYPE must be set
    if not deployment_type:
        print_error(f"DEPLOYMENT_TYPE not found in {system_conf_path}")
        print_error("You must set DEPLOYMENT_TYPE in /etc/walrus/system.conf")
        print_error("\nAdd one of:")
        print_error("  DEPLOYMENT_TYPE=development")
        print_error("  DEPLOYMENT_TYPE=production")
        sys.exit(1)

    # Determine databases to create
    is_production = deployment_type == 'production'

    if is_production:
        databases = ['suiftly_prod']
        print_step("Production: creating suiftly_prod database")
    else:
        databases = ['suiftly_dev', 'suiftly_test']
        print_step(f"Development ({deployment_type}): creating suiftly_dev and suiftly_test databases")

    for db in databases:
        # Check if database exists
        returncode, stdout, stderr = run_command(
            ['sudo', '-u', 'postgres', 'psql', '-lqt'],
            check=False
        )

        if db in stdout:
            print_step(f"Database {db} already exists")
        else:
            print_step(f"Creating database {db}...")
            returncode, stdout, stderr = run_command(
                ['sudo', '-u', 'postgres', 'createdb', db],
                check=False
            )
            if returncode != 0:
                print_error(f"Failed to create database {db}: {stderr}")
                print_error("Fix: Check postgres user sudo access")
                sys.exit(1)

        # Enable TimescaleDB extension
        print_step(f"Enabling TimescaleDB on {db}...")
        returncode, stdout, stderr = run_command(
            ['sudo', '-u', 'postgres', 'psql', '-d', db, '-c',
             'CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;'],
            check=False
        )
        if returncode != 0:
            print_warning(f"Failed to enable TimescaleDB on {db}: {stderr}")
            context.warnings.append(f"TimescaleDB extension not enabled on {db}")

    # Create deploy user if not exists
    print_step("Creating deploy user in PostgreSQL...")
    returncode, stdout, stderr = run_command(
        ['sudo', '-u', 'postgres', 'psql', '-t', '-c',
         "SELECT 1 FROM pg_roles WHERE rolname='deploy';"],
        check=False
    )

    if stdout.strip():
        print_step("PostgreSQL user 'deploy' already exists")
    else:
        returncode, stdout, stderr = run_command(
            ['sudo', '-u', 'postgres', 'psql', '-c',
             "CREATE USER deploy WITH PASSWORD 'deploy_password_change_me';"],
            check=False
        )
        if returncode != 0:
            print_error(f"Failed to create deploy user: {stderr}")
            sys.exit(1)

    # Grant permissions
    for db in databases:
        run_command(
            ['sudo', '-u', 'postgres', 'psql', '-c',
             f"GRANT ALL PRIVILEGES ON DATABASE {db} TO deploy;"],
            check=False
        )

    print_success("setup_postgresql_databases")


def setup_database_permissions(context: SetupContext):
    """Grant permissions to deploy user and run migrations."""
    print_step("Setting up database permissions...")

    # Read deployment type to determine which databases to configure
    system_conf_path = "/etc/walrus/system.conf"
    deployment_type = None

    try:
        with open(system_conf_path, 'r') as f:
            for line in f:
                line = line.strip()
                if line.startswith('#') or not line:
                    continue
                if line.startswith('DEPLOYMENT_TYPE='):
                    deployment_type = line.split('=', 1)[1].strip('"\'').lower()
                    break
    except (PermissionError, IOError) as e:
        print_error(f"Could not read {system_conf_path}: {e}")
        sys.exit(1)

    # Determine databases
    is_production = deployment_type == 'production'
    if is_production:
        databases = ['suiftly_prod']
    else:
        databases = ['suiftly_dev', 'suiftly_test']

    # Grant permissions on each database
    for db in databases:
        print_step(f"Granting permissions on {db}...")

        # Grant schema permissions
        returncode, stdout, stderr = run_command(
            ['sudo', '-u', 'postgres', 'psql', '-d', db, '-c',
             'GRANT ALL ON SCHEMA public TO deploy;'],
            check=False
        )
        if returncode != 0:
            print_warning(f"Failed to grant schema permissions on {db}: {stderr}")

        # Grant table permissions
        returncode, stdout, stderr = run_command(
            ['sudo', '-u', 'postgres', 'psql', '-d', db, '-c',
             'GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO deploy;'],
            check=False
        )
        if returncode != 0:
            print_warning(f"Failed to grant table permissions on {db}: {stderr}")

        # Grant sequence permissions
        returncode, stdout, stderr = run_command(
            ['sudo', '-u', 'postgres', 'psql', '-d', db, '-c',
             'GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO deploy;'],
            check=False
        )
        if returncode != 0:
            print_warning(f"Failed to grant sequence permissions on {db}: {stderr}")

        # Alter default privileges for tables
        returncode, stdout, stderr = run_command(
            ['sudo', '-u', 'postgres', 'psql', '-d', db, '-c',
             'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO deploy;'],
            check=False
        )
        if returncode != 0:
            print_warning(f"Failed to alter default table privileges on {db}: {stderr}")

        # Alter default privileges for sequences
        returncode, stdout, stderr = run_command(
            ['sudo', '-u', 'postgres', 'psql', '-d', db, '-c',
             'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO deploy;'],
            check=False
        )
        if returncode != 0:
            print_warning(f"Failed to alter default sequence privileges on {db}: {stderr}")

    print_success("setup_database_permissions")


def run_database_migrations(context: SetupContext):
    """Run database migrations."""
    print_step("Running database migrations...")

    # Get the real user (not root)
    real_user = os.environ.get('SUDO_USER') or os.environ.get('USER')
    if not real_user:
        print_error("Could not determine real user")
        sys.exit(1)

    try:
        user_info = pwd.getpwnam(real_user)
        home_dir = user_info[5]  # pw_dir is at index 5
    except KeyError:
        print_error(f"User not found: {real_user}")
        sys.exit(1)

    # Determine the suiftly-co directory
    suiftly_dir = os.path.join(home_dir, 'suiftly-co')

    if not os.path.isdir(suiftly_dir):
        print_warning(f"suiftly-co directory not found at {suiftly_dir}")
        print_warning("Skipping migrations")
        return

    # Check if packages/database exists
    db_package_dir = os.path.join(suiftly_dir, 'packages/database')
    if not os.path.isdir(db_package_dir):
        print_warning(f"Database package not found at {db_package_dir}")
        print_warning("Skipping migrations")
        return

    print_step(f"Running db:push in {db_package_dir} as user {real_user}...")

    # Run database migration as the real user
    returncode, stdout, stderr = run_command(
        ['sudo', '-u', real_user, 'bash', '-c', f'cd {db_package_dir} && npm run db:push'],
        check=False
    )

    if returncode != 0:
        print_warning(f"Database migration failed: {stderr}")
        context.warnings.append("Database migration failed - run 'npm run db:push' manually in packages/database")
        return

    print_success("run_database_migrations")


def install_python_packages(context: SetupContext):
    """Install Python packages for database migration scripts (via apt)."""
    print_step("Checking Python packages...")

    # Map Python package names to apt package names and import names
    packages = {
        'python3-psycopg2': 'psycopg2',
        'python3-dotenv': 'dotenv',
        'python3-click': 'click'
    }

    missing_apt = []
    for apt_pkg, import_name in packages.items():
        returncode, stdout, stderr = run_command(
            ['python3', '-c', f'import {import_name}'],
            check=False
        )
        if returncode != 0:
            missing_apt.append(apt_pkg)

    if not missing_apt:
        print_success("install_python_packages (all present)")
        return

    # Install packages via apt (Ubuntu 24.04 requires this for system packages)
    print_step(f"Installing Python packages via apt: {', '.join(missing_apt)}...")
    returncode, stdout, stderr = run_command(['apt', 'install', '-y'] + missing_apt, check=False)
    if returncode != 0:
        print_error(f"Python package installation failed: {stderr}")
        sys.exit(1)

    print_success("install_python_packages")


def install_nginx(context: SetupContext):
    """Install Nginx (unconfigured)."""
    print_step("Checking Nginx installation...")

    returncode, stdout, stderr = run_command(['nginx', '-v'], check=False)

    if returncode == 0:
        version = stderr.strip() if stderr else stdout.strip()
        print_success(f"install_nginx ({version})")
        return

    # Install Nginx (without starting it)
    print_step("Installing Nginx...")

    # First, download the package without configuring
    returncode, stdout, stderr = run_command(
        ['apt', 'install', '-y', '--no-install-recommends', 'nginx-core', 'nginx-common'],
        check=False
    )
    if returncode != 0:
        print_error(f"Nginx download failed:")
        print_error(f"  stdout: {stdout}")
        print_error(f"  stderr: {stderr}")
        sys.exit(1)

    # Check if system has IPv6 support
    print_step("Checking IPv6 support...")
    ipv6_supported = os.path.exists('/proc/net/if_inet6')

    if not ipv6_supported:
        print_warning("IPv6 not supported on this system")
        print_step("Disabling IPv6 in nginx default config...")

        # Disable IPv6 in default site config
        default_site = '/etc/nginx/sites-available/default'
        if os.path.exists(default_site):
            try:
                with open(default_site, 'r') as f:
                    config = f.read()

                # Comment out IPv6 listen directives
                config = config.replace('listen [::]:80', '# listen [::]:80')
                config = config.replace('listen [::]:443', '# listen [::]:443')

                with open(default_site, 'w') as f:
                    f.write(config)

                print_step("Disabled IPv6 listeners in default site")
            except Exception as e:
                print_warning(f"Could not modify nginx config: {e}")

    # Now install nginx package (which will start the service)
    returncode, stdout, stderr = run_command(['apt', 'install', '-y', 'nginx'], check=False)
    if returncode != 0:
        print_error(f"Nginx installation failed:")
        print_error(f"  stdout: {stdout}")
        print_error(f"  stderr: {stderr}")
        print_error("\nFix: Try running these commands manually:")
        print_error("  sudo dpkg --configure -a")
        print_error("  sudo apt --fix-broken install")
        print_error("  sudo apt install -y nginx")
        sys.exit(1)

    print_success("install_nginx")


def install_certbot(context: SetupContext):
    """Install Certbot (production only, unconfigured)."""
    print_step("Checking Certbot installation...")

    returncode, stdout, stderr = run_command(['certbot', '--version'], check=False)

    if returncode == 0:
        print_success(f"install_certbot ({stdout.strip()})")
        return

    # Install Certbot
    print_step("Installing Certbot...")
    returncode, stdout, stderr = run_command(
        ['apt', 'install', '-y', 'certbot', 'python3-certbot-nginx'],
        check=False
    )
    if returncode != 0:
        print_error(f"Certbot installation failed: {stderr}")
        sys.exit(1)

    print_success("install_certbot")


def create_deploy_user(context: SetupContext):
    """Create deploy system user."""
    print_step("Checking deploy user...")

    # Check if user exists
    try:
        pwd.getpwnam('deploy')
        print_success("create_deploy_user (already exists)")
        return
    except KeyError:
        pass

    # Create user
    print_step("Creating deploy user...")
    returncode, stdout, stderr = run_command(
        ['useradd', '-m', '-s', '/bin/bash', 'deploy'],
        check=False
    )
    if returncode != 0:
        print_error(f"Failed to create deploy user: {stderr}")
        sys.exit(1)

    print_success("create_deploy_user")


def create_directory_structure(context: SetupContext):
    """Create application directories."""
    print_step("Creating directory structure...")

    directories = [
        '/var/www/api',
        '/var/www/webapp',
        '/var/www/global-manager',
        '/var/log/suiftly'
    ]

    # Create directories
    for directory in directories:
        os.makedirs(directory, exist_ok=True)

    # Set ownership
    try:
        deploy_user = pwd.getpwnam('deploy')
        uid = deploy_user[2]  # pw_uid is at index 2
        gid = deploy_user[3]  # pw_gid is at index 3
        for directory in ['/var/www', '/var/log/suiftly']:
            os.chown(directory, uid, gid)
            # Recursively chown
            for root, dirs, files in os.walk(directory):
                for d in dirs:
                    os.chown(os.path.join(root, d), uid, gid)
                for f in files:
                    os.chown(os.path.join(root, f), uid, gid)
    except Exception as e:
        print_warning(f"Failed to set ownership: {e}")
        context.warnings.append("Directory ownership may need manual adjustment")

    print_success("create_directory_structure")


def install_npm_dependencies(context: SetupContext):
    """Install npm dependencies for the monorepo."""
    print_step("Installing npm dependencies...")

    # Get the real user (not root)
    real_user = os.environ.get('SUDO_USER') or os.environ.get('USER')
    if not real_user:
        print_error("Could not determine real user")
        sys.exit(1)

    try:
        user_info = pwd.getpwnam(real_user)
        home_dir = user_info[5]  # pw_dir is at index 5
    except KeyError:
        print_error(f"User not found: {real_user}")
        sys.exit(1)

    # Determine the suiftly-co directory
    # Assume it's in the home directory
    suiftly_dir = os.path.join(home_dir, 'suiftly-co')

    if not os.path.isdir(suiftly_dir):
        print_warning(f"suiftly-co directory not found at {suiftly_dir}")
        print_warning("Skipping npm install - run 'npm install' manually in your project directory")
        return

    # Check if package.json exists
    package_json = os.path.join(suiftly_dir, 'package.json')
    if not os.path.isfile(package_json):
        print_warning(f"package.json not found at {package_json}")
        print_warning("Skipping npm install")
        return

    print_step(f"Running npm install in {suiftly_dir} as user {real_user}...")

    # Run npm install as the real user (not root) in the project directory
    # Use bash -c to handle cd and npm install together
    returncode, stdout, stderr = run_command(
        ['sudo', '-u', real_user, 'bash', '-c', f'cd {suiftly_dir} && npm install'],
        check=False
    )

    if returncode != 0:
        print_warning(f"npm install failed: {stderr}")
        context.warnings.append("npm install failed - run 'npm install' manually")
        return

    print_success("install_npm_dependencies")


def main():
    """Main setup routine."""
    context = SetupContext()

    # Print header
    print(f"\n{Colors.BOLD}Suiftly NetOps Server Setup{Colors.RESET}")
    print("=" * 50)
    print()

    # Check if running as root
    if os.geteuid() != 0:
        print_error("This script must be run with sudo")
        print("Usage: sudo python3 scripts/rare/setup-netops-server.py")
        sys.exit(1)

    steps = [
        check_ubuntu_version,
        check_nvm_installed,
        check_nvm_node_version,
        install_system_packages,
        install_nodejs,
        install_npm_global_packages,
        install_postgresql,
        install_timescaledb,
        setup_postgresql_databases,
        setup_database_permissions,
        install_python_packages,
        install_nginx,
        install_certbot,
        create_deploy_user,
        create_directory_structure,
        install_npm_dependencies,
        run_database_migrations
    ]

    for step in steps:
        try:
            step(context)
        except Exception as e:
            print_error(f"{step.__name__}: {e}")
            context.failed_steps.append(step.__name__)
            sys.exit(1)

    # Print summary
    print("\n" + "=" * 50)
    if context.failed_steps:
        print_error("Setup incomplete. Failed steps:")
        for step in context.failed_steps:
            print(f"  - {step}")
        sys.exit(1)

    if context.warnings:
        print_warning("Setup complete with warnings:")
        for warning in context.warnings:
            print(f"  - {warning}")

    print(f"\n{Colors.GREEN}✅ Server setup complete!{Colors.RESET}")
    print("\nNext steps:")
    print("  1. Continue with Phase 1: Project scaffolding")
    print("  2. See IMPLEMENTATION_PLAN.md for full phase sequence")
    print("\nNote: This script is idempotent - safe to re-run if needed")
    print()


if __name__ == '__main__':
    main()
