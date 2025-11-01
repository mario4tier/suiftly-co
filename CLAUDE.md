# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

**suiftly-co** - Customer-facing platform for Suiftly services (Sui blockchain infrastructure).

Repository: https://github.com/mario4tier/suiftly-co

## What This Project Does

Self-service dashboard where customers configure and manage Suiftly infrastructure services:
- Web dashboard (SPA) for service configuration
- Wallet-based authentication (sign-in with Sui)
- Usage-based billing with Web3 wallet integration
- API backend with tRPC (type-safe)

Infrastructure (HAProxy, Seal servers) lives in separate **walrus** project.

## Architecture

**Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for complete details.**

**System diagram:** [docs/Suiftly - Seal Ops.png](docs/Suiftly - Seal Ops.png) shows the complete infrastructure (this repo builds the red NetOps components: SPA, API servers, PostgreSQL, Global Manager).

Key points:
- **Monorepo:** Turborepo + npm workspaces
- **Stack:** TypeScript everywhere (Vite + React, Fastify, PostgreSQL)
- **Auth:** Wallet signature verification (no passwords)
- **Self-hosted:** No cloud dependencies

## Current Status

Initial setup phase - no code scaffolded yet.

## Development Guidelines

- Follow architecture decisions in docs/ARCHITECTURE.md
- Keep it simple (rapid development principle)
- TypeScript strict mode
- Update this file only when adding commands or major patterns

## CRITICAL: Process Management

**NEVER use `killall -9 node` or similar commands!** This kills the AI agent process itself.

When you need to stop development servers:
- Use `lsof -ti:PORT | xargs kill` to kill specific port processes
- Use project scripts in `scripts/dev/` if available
- Use `pkill -f "specific-server-name"` to target specific processes
- In Playwright tests, set `reuseExistingServer: false` to force fresh server starts