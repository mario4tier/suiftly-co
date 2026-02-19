#!/usr/bin/env python3
"""
Standardized Test Runner for Suiftly-co Repository

This is the main entry point for running all tests in the repository.
It orchestrates TypeScript and Playwright tests and writes progress to a
standardized summary file that can be monitored by external tools.

Summary File Protocol:
  Location: /tmp/{repo}-test-summary.json
  Format: JSON with status, phases, and summary fields

Usage:
  ./scripts/run-all-tests.py           # Run all tests
  python3 scripts/run-all-tests.py     # Alternative

Exit Codes:
  0 - All tests passed
  1 - One or more tests failed
  2 - Skipped (e.g., production environment)

See: ~/mhaxbe/scripts/tests/README.md for full documentation
"""

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

# Summary file location - standardized across all repos
REPO_NAME = "suiftly-co"
SUMMARY_FILE = f"/tmp/{REPO_NAME}-test-summary.json"


def get_repo_root() -> Path:
    """Get the repository root directory."""
    return Path(__file__).parent.parent


def is_production_environment() -> tuple[bool, str]:
    """
    Check if this is a production environment.

    Checks two locations:
    1. ~/mhaxbe/system.conf - ENVIRONMENT variable
    2. /etc/mhaxbe/system.conf - DEPLOYMENT_TYPE variable

    Returns:
        tuple[bool, str]: (is_production, reason)
    """
    home = os.path.expanduser("~")
    mhaxbe_config = os.path.join(home, "mhaxbe", "system.conf")

    if os.path.exists(mhaxbe_config):
        try:
            with open(mhaxbe_config, 'r') as f:
                for line in f:
                    line = line.strip()
                    if line.startswith('#') or not line:
                        continue
                    if line.startswith('ENVIRONMENT='):
                        value = line.split('=', 1)[1].strip('"\'').lower()
                        if value == 'production':
                            return True, f"ENVIRONMENT=production in {mhaxbe_config}"
                        elif value == 'development':
                            return False, f"ENVIRONMENT=development in {mhaxbe_config}"
        except Exception as e:
            print(f"Warning: Could not read {mhaxbe_config}: {e}")

    etc_config = "/etc/mhaxbe/system.conf"
    if os.path.exists(etc_config):
        try:
            with open(etc_config, 'r') as f:
                for line in f:
                    line = line.strip()
                    if line.startswith('#') or not line:
                        continue
                    if line.startswith('DEPLOYMENT_TYPE='):
                        value = line.split('=', 1)[1].strip('"\'').lower()
                        if value == 'production':
                            return True, f"DEPLOYMENT_TYPE=production in {etc_config}"
        except Exception as e:
            print(f"Warning: Could not read {etc_config}: {e}")

    return False, "No production markers found"


def write_summary(data: dict[str, Any]) -> None:
    """Write the summary JSON file atomically."""
    tmp_file = f"{SUMMARY_FILE}.tmp"
    with open(tmp_file, 'w') as f:
        json.dump(data, f, indent=2, default=str)
    os.rename(tmp_file, SUMMARY_FILE)


def init_summary(phases: list[str]) -> dict[str, Any]:
    """Initialize the summary data structure."""
    return {
        "repo": REPO_NAME,
        "started": datetime.now(timezone.utc).isoformat(),
        "status": "running",
        "current_phase": None,
        "phases": [{"name": p, "status": "pending", "duration": None} for p in phases],
        "summary": {"passed": 0, "failed": 0, "skipped": 0, "total": len(phases)},
        "ended": None,
        "duration": None,
    }


def update_phase(summary: dict, phase_name: str, status: str, duration: Optional[float] = None) -> None:
    """Update a phase's status in the summary."""
    for phase in summary["phases"]:
        if phase["name"] == phase_name:
            phase["status"] = status
            if duration is not None:
                phase["duration"] = round(duration, 2)
            break

    if status == "running":
        summary["current_phase"] = phase_name
    elif status in ("passed", "failed", "skipped"):
        summary["summary"][status] = summary["summary"].get(status, 0) + 1
        if status == "failed":
            summary["current_phase"] = f"{phase_name} (failed)"

    write_summary(summary)


def finalize_summary(summary: dict, overall_status: str) -> None:
    """Finalize the summary with end time and duration."""
    started = datetime.fromisoformat(summary["started"])
    ended = datetime.now(timezone.utc)

    summary["status"] = overall_status
    summary["ended"] = ended.isoformat()
    summary["duration"] = round((ended - started).total_seconds(), 2)
    summary["current_phase"] = None

    write_summary(summary)


def run_command(cmd: list[str], cwd: Path, env: Optional[dict] = None) -> tuple[int, float]:
    """
    Run a command and return (exit_code, duration_seconds).

    Output is streamed to stdout/stderr in real-time.
    """
    start = datetime.now()

    run_env = os.environ.copy()
    if env:
        run_env.update(env)

    try:
        result = subprocess.run(
            cmd,
            cwd=cwd,
            env=run_env,
            timeout=3600,  # 60 minute timeout (Playwright can be slow)
        )
        exit_code = result.returncode
    except subprocess.TimeoutExpired:
        print(f"ERROR: Command timed out after 60 minutes")
        exit_code = -1
    except Exception as e:
        print(f"ERROR: Command failed with exception: {e}")
        exit_code = -1

    duration = (datetime.now() - start).total_seconds()
    return exit_code, duration


def print_header(text: str) -> None:
    """Print a styled header."""
    print()
    print("=" * 70)
    print(f"  {text}")
    print("=" * 70)


def print_phase(text: str) -> None:
    """Print a phase indicator."""
    print()
    print(f">>> {text}")
    print("-" * 70)


def main() -> int:
    repo_root = get_repo_root()

    print_header(f"SUIFTLY-CO TEST RUNNER")
    print(f"  Repository: {repo_root}")
    print(f"  Summary file: {SUMMARY_FILE}")

    # Production environment check
    is_prod, reason = is_production_environment()
    if is_prod:
        print()
        print("!" * 70)
        print("  FATAL: Cannot run tests in production environment!")
        print("!" * 70)
        print(f"  Detected: {reason}")
        print()
        print("  Tests are ONLY allowed in development environments.")
        print("  To run tests, ensure ~/mhaxbe/system.conf has:")
        print("    ENVIRONMENT=development")
        print("!" * 70)
        return 2

    print(f"  Environment: {reason}")

    # Define test phases
    # Suiftly-co uses the TypeScript runner which handles:
    # - Vitest API tests
    # - Playwright E2E tests (normal-expiry, short-expiry, chromium)
    phases = [
        "typescript-e2e",  # TypeScript + Playwright tests via npm run test:all
    ]

    # Initialize summary
    summary = init_summary(phases)
    write_summary(summary)

    all_passed = True

    # Phase 1: TypeScript + E2E tests
    print_phase("Phase 1: TypeScript + E2E Tests")
    update_phase(summary, "typescript-e2e", "running")

    # Check if npm is available and package.json exists
    if not (repo_root / "package.json").exists():
        print("  SKIP: No package.json found")
        update_phase(summary, "typescript-e2e", "skipped")
    else:
        exit_code, duration = run_command(
            ["npm", "run", "test:all"],
            cwd=repo_root,
        )

        if exit_code == 0:
            print(f"  PASS: All tests passed ({duration:.1f}s)")
            update_phase(summary, "typescript-e2e", "passed", duration)
        else:
            print(f"  FAIL: Tests failed (exit code {exit_code}, {duration:.1f}s)")
            update_phase(summary, "typescript-e2e", "failed", duration)
            all_passed = False

    # Finalize
    overall_status = "passed" if all_passed else "failed"
    finalize_summary(summary, overall_status)

    # Print final summary
    print_header("TEST SUMMARY")

    for phase in summary["phases"]:
        status_icon = {"passed": "PASS", "failed": "FAIL", "skipped": "SKIP", "pending": "----"}.get(phase["status"], "????")
        duration_str = f"{phase['duration']:.1f}s" if phase["duration"] else "---"
        print(f"  [{status_icon}] {phase['name']:<20} {duration_str}")

    print()
    print(f"  Total duration: {summary['duration']:.1f}s")
    print(f"  Passed: {summary['summary']['passed']}, Failed: {summary['summary']['failed']}, Skipped: {summary['summary']['skipped']}")
    print()

    if all_passed:
        print("  All tests passed!")
        return 0
    else:
        print("  Some tests failed.")
        return 1


if __name__ == "__main__":
    sys.exit(main())