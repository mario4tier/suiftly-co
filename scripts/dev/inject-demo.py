#!/usr/bin/env python3
"""
Inject demo traffic data for UI testing.

This is a wrapper that calls the TypeScript implementation.

Usage:
    ./scripts/dev/inject-demo.py                     # Default: mock wallet, seal, 48 hours
    ./scripts/dev/inject-demo.py --hours 24          # 24 hours of data
    ./scripts/dev/inject-demo.py --service grpc      # gRPC service
    ./scripts/dev/inject-demo.py 0x1234...           # Specific wallet

Examples:
    python3 scripts/dev/inject-demo.py
    python3 scripts/dev/inject-demo.py --hours 24 --service seal
"""

import os
import subprocess
import sys
from pathlib import Path


def main():
    # Defense in depth: block production even before calling TS script
    if os.environ.get("NODE_ENV") == "production":
        print("Error: Cannot inject demo data in production", file=sys.stderr)
        sys.exit(1)

    script_dir = Path(__file__).parent
    ts_script = script_dir / "inject-demo.ts"

    if not ts_script.exists():
        print(f"Error: TypeScript script not found: {ts_script}", file=sys.stderr)
        sys.exit(1)

    cmd = ["npx", "tsx", "--no-warnings", str(ts_script)] + sys.argv[1:]

    try:
        result = subprocess.run(cmd, cwd=script_dir.parent.parent)
        if result.returncode != 0:
            print(f"Error: Script exited with code {result.returncode}", file=sys.stderr)
        sys.exit(result.returncode)
    except FileNotFoundError:
        print("Error: 'npx' not found. Is Node.js installed?", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\nInterrupted", file=sys.stderr)
        sys.exit(130)


if __name__ == "__main__":
    main()
