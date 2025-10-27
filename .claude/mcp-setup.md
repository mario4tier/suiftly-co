# MCP Server Setup Guide

This guide walks you through setting up Model Context Protocol (MCP) servers for optimal Claude Code development with the Suiftly stack.

## Philosophy: Minimal, High-Value MCPs Only

**We only install MCPs that add UNIQUE value over built-in tools.**

**Installed:**
- ✅ **Context7** - Live documentation (irreplaceable - prevents API hallucinations)

**Not Installed (Built-in tools work fine):**
- ❌ Filesystem MCP - Use Read/Write/Edit/Bash tools instead
- ❌ Git MCP - Use Bash + git commands instead
- ❌ GitHub MCP - Use Bash + gh CLI instead

**Add Later (When Needed):**
- ⏳ Postgres MCP - When database exists
- ⏳ Drizzle MCP - When drizzle.config.ts exists

## Prerequisites

- Claude Code installed

## Installation Steps

### 1. Context7 (Essential - Prevents API Hallucinations)

**What it does**: Fetches current documentation for third-party libraries

**Install:**
```bash
claude mcp add --transport sse context7 https://mcp.context7.com/sse
```

**Usage in prompts:**
- Say "use context7" to fetch live docs
- Or use the `/g` command (auto-enables context7)

**Why critical for Suiftly:**
- React 19 (Dec 2024) - bleeding edge
- Vite 7 (Sep 2024) - recent release
- tRPC v11 - actively evolving API
- Drizzle ORM - syntax changes frequently
- @mysten/sui.js - Sui blockchain SDK updates

---

## Optional MCPs (Add Later When Needed)

### 2. PostgreSQL MCP (When Database Exists)

**What it does**: Inspect database schema and run read-only queries

**Install:**
```bash
claude mcp add postgres -- npx -y @modelcontextprotocol/server-postgres postgresql://postgres@localhost/suiftly_dev
```

**Prerequisites:**
- PostgreSQL 17 running locally
- `suiftly_dev` database created (see ../docs/ARCHITECTURE.md)

**Verification:**
```bash
# Test connection
psql postgresql://postgres@localhost/suiftly_dev -c "SELECT version();"
```

---

### 3. Drizzle MCP (After Scaffolding Project)

**What it does**: Drizzle ORM integration (migrations, schema introspection)

**Install:**
```bash
claude mcp add drizzle -- npx github:defrex/drizzle-mcp ./packages/database/drizzle.config.ts
```

**Prerequisites:**
- `packages/database/drizzle.config.ts` must exist
- Will be available after scaffolding project structure

**Note**: This will error until you create the Turborepo structure. Add after scaffolding.

---

## Verification

**Check installed MCPs:**
```bash
claude mcp list
```

**Expected output (minimal setup):**
```
context7 (sse) - ✓ Connected
```

**If you added optional MCPs:**
```
postgres (stdio) - ✓ Connected
drizzle (stdio) - ✓ Connected
```

---

## Usage Workflow

### Recommended: Use `/g` Command

The `/g` custom command automatically enables Context7 for every feature:

```
/g add tRPC route for fetching usage metrics
```

This expands to:
- ✅ Use context7 for live documentation
- ✅ Read ../CLAUDE.md and ../docs/ARCHITECTURE.md first
- ✅ Break down task with TodoWrite

See [.claude/commands/g.md](.claude/commands/g.md) for details.

### Manual Usage

You can also invoke MCPs directly in prompts:

```
use context7 to check the latest tRPC v11 syntax for subscriptions
```

### Built-in Tools (No MCP Needed)

For file operations, Git, and GitHub, use built-in tools:

```
# File operations
Read, Write, Edit, Glob, Grep tools

# Git operations
Bash: git status, git commit, git diff, etc.

# GitHub operations
Bash: gh pr create, gh issue list, etc.
```

---

## Troubleshooting

### Context7: "Connection failed"
- Check internet connection (Context7 is remote SSE server)
- Verify: `curl https://mcp.context7.com/sse`

### Postgres MCP: "Connection refused" (Optional)
- Verify PostgreSQL is running: `sudo service postgresql status`
- Check connection string: `psql postgresql://postgres@localhost/suiftly_dev`

### Drizzle MCP: "Config not found" (Optional)
- This is expected before scaffolding
- Create project structure first (see ../docs/ARCHITECTURE.md "Next Steps")

---

## MCP Configuration Files

MCPs are configured in:
- **Linux/WSL**: `~/.config/claude/config.json`
- **Verify location**: `claude mcp list` shows config path

**Minimal setup configuration:**
```json
{
  "mcpServers": {
    "context7": {
      "transport": "sse",
      "url": "https://mcp.context7.com/sse"
    }
  }
}
```

---

## Next Steps

1. ✅ Complete this MCP setup
2. ✅ Test `/g` command: `/g show me the project structure`
3. ✅ Verify all MCPs work: `claude mcp list`
4. 🚀 Ready to scaffold project (see ../docs/ARCHITECTURE.md "Next Steps")

---

## Resources

- [Context7 GitHub](https://github.com/upstash/context7)
- [MCP Official Docs](https://modelcontextprotocol.io)
- [Claude Code MCP Guide](https://docs.claude.com/en/docs/claude-code)
