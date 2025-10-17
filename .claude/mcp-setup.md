# MCP Server Setup Guide

This guide walks you through setting up Model Context Protocol (MCP) servers for optimal Claude Code development with the Suiftly stack.

## What are MCP Servers?

MCP servers extend Claude Code's capabilities by providing:
- **Context7**: Live documentation for bleeding-edge packages (React 19, Vite 7, tRPC v11, etc.)
- **Serena**: Semantic code search (find symbols, not just text)
- **Postgres**: Direct database schema inspection
- **Git/GitHub**: Version control integration
- **Drizzle**: ORM-specific tooling

## Prerequisites

- Claude Code installed
- Node.js 18+ installed
- Git configured
- PostgreSQL running locally (for postgres MCP)

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

### 2. Serena (Essential - Semantic Code Search)

**What it does**: Understands code structure via Language Server Protocol (LSP)

**Install:**
```bash
claude mcp add serena -- uvx --from git+https://github.com/oraios/serena serena start-mcp-server
```

**Requires**: Python 3.10+ (for uvx)

**What it enables:**
- Find all references to a tRPC route
- Locate where a Drizzle schema column is used
- Track React component prop flows
- Semantic search (not just grep)

**Example query:**
- "Where is the `customer_id` column used?" → Finds semantic references, not just text matches

---

### 3. PostgreSQL MCP

**What it does**: Inspect database schema and run read-only queries

**Install:**
```bash
claude mcp add postgres -- npx -y @modelcontextprotocol/server-postgres postgresql://postgres@localhost/suiftly_dev
```

**Prerequisites:**
- PostgreSQL 17 running locally
- `suiftly_dev` database created (see ARCHITECTURE.md)

**Verification:**
```bash
# Test connection
psql postgresql://postgres@localhost/suiftly_dev -c "SELECT version();"
```

---

### 4. Filesystem MCP

**What it does**: Secure file operations within allowed directories

**Install:**
```bash
claude mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem /home/olet/suiftly-co
```

**Note**: Replace `/home/olet/suiftly-co` with your actual project path

---

### 5. Git MCP

**What it does**: Local Git operations (status, diff, log, commit)

**Install:**
```bash
claude mcp add git -- npx -y @modelcontextprotocol/server-git --repository /home/olet/suiftly-co
```

**Note**: Replace path with your project directory

---

### 6. GitHub MCP

**What it does**: GitHub API operations (create PRs, manage issues, check CI)

**Setup GitHub Token:**

1. Go to https://github.com/settings/tokens
2. Click "Generate new token (classic)"
3. Select scopes:
   - ✅ `repo` (full control of private repositories)
   - ✅ `workflow` (if you want to trigger GitHub Actions)
4. Copy the token

**Set environment variable:**
```bash
# Add to ~/.bashrc or ~/.zshrc
export GITHUB_PERSONAL_ACCESS_TOKEN="ghp_your_token_here"

# Reload shell
source ~/.bashrc
```

**Install:**
```bash
claude mcp add github -- npx -y @modelcontextprotocol/server-github
```

**Verification:**
```bash
# Test (should show your GitHub username)
echo $GITHUB_PERSONAL_ACCESS_TOKEN | head -c 10
```

---

### 7. Drizzle MCP

**What it does**: Drizzle ORM integration (migrations, schema introspection)

**Install:**
```bash
claude mcp add drizzle -- npx github:defrex/drizzle-mcp ./packages/database/drizzle.config.ts
```

**Prerequisites:**
- `packages/database/drizzle.config.ts` must exist
- Will be available after scaffolding project structure

**Note**: This will error until you create the Turborepo structure. Skip for now, add after scaffolding.

---

## Verification

**Check installed MCPs:**
```bash
claude mcp list
```

**Expected output:**
```
context7 (sse)
serena (stdio)
postgres (stdio)
filesystem (stdio)
git (stdio)
github (stdio)
drizzle (stdio) [may not appear until drizzle.config.ts exists]
```

---

## Usage Workflow

### Recommended: Use `/g` Command

The `/g` custom command automatically enables Context7 + Serena for every feature:

```
/g add tRPC route for fetching usage metrics
```

This expands to:
- ✅ Use serena for semantic code search
- ✅ Use context7 for live documentation
- ✅ Read CLAUDE.md and ARCHITECTURE.md first
- ✅ Break down task with TodoWrite

See `.claude/commands/g.md` for details.

### Manual Usage

You can also invoke MCPs directly in prompts:

```
use context7 to check the latest tRPC v11 syntax for subscriptions
use serena to find all tRPC routes in the codebase
```

---

## Troubleshooting

### Context7: "Connection failed"
- Check internet connection (Context7 is remote SSE server)
- Verify: `curl https://mcp.context7.com/sse`

### Serena: "uvx command not found"
- Install uv: `curl -LsSf https://astral.sh/uv/install.sh | sh`
- Requires Python 3.10+

### Postgres MCP: "Connection refused"
- Verify PostgreSQL is running: `sudo service postgresql status`
- Check connection string: `psql postgresql://postgres@localhost/suiftly_dev`

### Drizzle MCP: "Config not found"
- This is expected before scaffolding
- Create project structure first (see ARCHITECTURE.md "Next Steps")

### GitHub MCP: "Authentication failed"
- Check token: `echo $GITHUB_PERSONAL_ACCESS_TOKEN`
- Verify scopes: Token needs `repo` access
- Test with: `gh auth status` (if GitHub CLI installed)

---

## Optional: Add Later

### Playwright MCP (E2E Testing Phase)

**When**: During E2E testing implementation

**Install:**
```bash
claude mcp add playwright -- npx -y @playwright/mcp
```

**Use for**: Writing browser automation tests for wallet authentication flows

---

## MCP Configuration Files

MCPs are configured in:
- **Linux/WSL**: `~/.config/claude/config.json`
- **Verify location**: `claude mcp list` shows config path

**Manual editing** (if needed):
```json
{
  "mcpServers": {
    "context7": {
      "transport": "sse",
      "url": "https://mcp.context7.com/sse"
    },
    "serena": {
      "command": "uvx",
      "args": ["--from", "git+https://github.com/oraios/serena", "serena", "start-mcp-server"]
    }
    // ... other servers
  }
}
```

---

## Next Steps

1. ✅ Complete this MCP setup
2. ✅ Test `/g` command: `/g show me the project structure`
3. ✅ Verify all MCPs work: `claude mcp list`
4. 🚀 Ready to scaffold project (see ARCHITECTURE.md "Next Steps")

---

## Resources

- [Context7 GitHub](https://github.com/upstash/context7)
- [Serena GitHub](https://github.com/oraios/serena)
- [MCP Official Docs](https://modelcontextprotocol.io)
- [Claude Code MCP Guide](https://docs.claude.com/en/docs/claude-code)
