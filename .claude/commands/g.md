---
argument-hint: <feature description>
description: Start feature development with optimal MCP usage
---

Before implementing: $ARGUMENTS

**Always use:**
- **serena** for semantic code retrieval and editing (find symbols, references, definitions)
- **context7** for up-to-date documentation on third-party packages (React 19, Vite 7, tRPC v11, Drizzle, Fastify 5, @mysten/sui.js, TimescaleDB, etc.)

**Process:**
1. Read CLAUDE.md and ARCHITECTURE.md to understand project conventions
2. Use serena to find relevant code patterns in the existing codebase
3. Use context7 to fetch current documentation for any third-party APIs
4. Break down the task using TodoWrite if it has multiple steps
5. Implement following the project's architecture and coding standards

Now implement: $ARGUMENTS
