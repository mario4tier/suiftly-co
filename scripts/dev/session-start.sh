#!/bin/bash
# session-start.sh - Claude Code session initialization for suiftly-co
# Called by ~/.claude/settings.json SessionStart hook

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Update reference repositories (seal-reference-main)
if [[ -x "$SCRIPT_DIR/manage-local-repos.sh" ]]; then
    "$SCRIPT_DIR/manage-local-repos.sh"
fi
