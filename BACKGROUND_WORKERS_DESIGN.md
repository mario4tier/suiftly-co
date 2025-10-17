# Background Workers Design

## Overview

This document describes all background processes in the Suiftly platform:

1. **Global Manager** - Centralized worker (co-located with PostgreSQL) that:
   - Aggregates HAProxy logs for metering
   - Calculates customer billing
   - Generates MA_VAULT (customer API keys and rate limits)
   - Generates MM_VAULT (imported encryption keys - see separate section)

2. **Local Managers** - Distributed workers (co-located with API Gateways) that:
   - Read MA_VAULT and update HAProxy sticky tables
   - Apply rate limits and access controls
   - Run every 30 seconds for near real-time updates

**Terminology:**
- **API Gateway** - Servers running HAProxy that process customer API requests
- **MA_VAULT** - Critical customer configuration vault (API keys, rate limits, status)
- **MM_VAULT** - Encryption keys vault for Seal service (less critical, see appendix)

**Implementation:** TypeScript with systemd timers for maximum reliability.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     PostgreSQL Server                       │
│  ┌─────────────────────────────────────────────────────┐    │
│  │            Global Manager (systemd timer)           │    │
│  │  - Aggregate HAProxy logs                           │    │
│  │  - Calculate billing                                │    │
│  │  - Generate MA_VAULT                                │    │
│  │  - Cleanup old data                                 │    │
│  └─────────────────────────────────────────────────────┘    │
│                           ↓                                 │
│                    MA_VAULT file                            │
└─────────────────────────────────────────────────────────────┘
                           ↓
                    (secure distribution)
                           ↓
┌────────────────────────────────────────────────────────────┐
│                    HAProxy Servers                         │
│  ┌─────────────────────────────────────────────────────┐   │
│  │           Local Manager (systemd timer)             │   │
│  │  - Process MA_VAULT                                 │   │
│  │  - Update HAProxy sticky tables                     │   │
│  │  - Apply rate limits                                │   │
│  │  - Monitor health                                   │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                            │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                  HAProxy Process                    │   │
│  │  - Enforce rate limits from sticky tables           │   │
│  │  - Generate access logs → Fluentd → PostgreSQL      │   │
│  └─────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────┘
```

## Data Flow

```
Customer Request → HAProxy (logs + rate limit) → Backend
                      ↓
                  Syslog (514/udp)
                      ↓
                  Fluentd (1s batch)
                      ↓
                PostgreSQL/TimescaleDB
                      ↓
              Global Manager (5 min)
                      ↓
            Aggregates + Bills + MA_VAULT
                      ↓
            Local Managers (30s)
                      ↓
            HAProxy Sticky Tables
```

---

## 1. Global Manager (Centralized)

Runs on the primary database server, handles all centralized operations.

### Implementation

```typescript
// services/global-manager/src/index.ts

import { db, sql } from '@suiftly/database'
import { acquireLock, releaseLock } from './lib/lock'
import { aggregateLogs } from './tasks/aggregate-logs'
import { calculateBills } from './tasks/calculate-bills'
import { generateVault } from './tasks/generate-vault'
import { cleanup } from './tasks/cleanup'
import pino from 'pino'

const logger = pino({ name: 'global-manager' })

const CONFIG = {
  LOCK_ID: 1001,  // PostgreSQL advisory lock
  RUN_INTERVAL: '5m',
  DRY_RUN: process.env.DRY_RUN === 'true'
}

async function main() {
  const startTime = Date.now()
  logger.info({ config: CONFIG }, 'Global Manager started')

  try {
    // Acquire exclusive lock (prevent concurrent runs)
    const lockAcquired = await acquireLock(CONFIG.LOCK_ID)
    if (!lockAcquired) {
      logger.warn('Another instance is running, exiting')
      process.exit(0)
    }

    // Run tasks in sequence (each is idempotent)
    await runWithMetrics('aggregate-logs', aggregateLogs)
    await runWithMetrics('calculate-bills', calculateBills)
    await runWithMetrics('generate-ma-vault', generateMAVault)
    await runWithMetrics('generate-mm-vault', generateMMVault)  // Optional: only if customers have imported keys
    await runWithMetrics('cleanup', cleanup)

    const duration = Date.now() - startTime
    logger.info({ duration }, 'Global Manager completed')

  } catch (error) {
    logger.error({ error }, 'Global Manager failed')
    process.exit(1)
  } finally {
    await releaseLock(CONFIG.LOCK_ID)
  }
}

// Helper to track task metrics
async function runWithMetrics(taskName: string, task: () => Promise<void>) {
  const startTime = Date.now()
  logger.info({ task: taskName }, 'Starting task')

  try {
    await task()
    const duration = Date.now() - startTime

    await db.insert(worker_runs).values({
      worker_type: 'global-manager',
      task_name: taskName,
      status: 'success',
      duration_ms: duration,
      executed_at: new Date()
    })

    logger.info({ task: taskName, duration }, 'Task completed')
  } catch (error) {
    logger.error({ task: taskName, error }, 'Task failed')

    await db.insert(worker_runs).values({
      worker_type: 'global-manager',
      task_name: taskName,
      status: 'failed',
      error_message: error.message,
      executed_at: new Date()
    })

    throw error
  }
}

main().catch(err => {
  logger.fatal({ error: err }, 'Fatal error')
  process.exit(1)
})
```

### Task: Aggregate Logs

```typescript
// services/global-manager/src/tasks/aggregate-logs.ts

export async function aggregateLogs() {
  // Get last processed timestamp
  const lastProcessed = await db.query.processing_state.findFirst({
    where: eq(processing_state.key, 'last_aggregated_log_timestamp')
  })

  const fromTimestamp = lastProcessed?.value || '2025-01-01T00:00:00Z'
  const toTimestamp = new Date().toISOString()

  // Aggregate into hourly buckets (idempotent via UPSERT)
  await db.execute(sql`
    INSERT INTO usage_hourly (hour, customer_id, service_type, request_count, bytes_in, bytes_out)
    SELECT
      date_trunc('hour', timestamp) as hour,
      customer_id,
      service_type,
      COUNT(*) as request_count,
      SUM(bytes_in) as bytes_in,
      SUM(bytes_out) as bytes_out
    FROM haproxy_logs
    WHERE timestamp > ${fromTimestamp}
      AND timestamp <= ${toTimestamp}
    GROUP BY hour, customer_id, service_type
    ON CONFLICT (hour, customer_id, service_type)
    DO UPDATE SET
      request_count = usage_hourly.request_count + EXCLUDED.request_count,
      bytes_in = usage_hourly.bytes_in + EXCLUDED.bytes_in,
      bytes_out = usage_hourly.bytes_out + EXCLUDED.bytes_out
  `)

  // Update last processed timestamp
  await db.insert(processing_state)
    .values({
      key: 'last_aggregated_log_timestamp',
      value: toTimestamp
    })
    .onConflictDoUpdate({
      target: processing_state.key,
      set: { value: toTimestamp, updated_at: new Date() }
    })
}
```

### Task: Calculate Bills

```typescript
// services/global-manager/src/tasks/calculate-bills.ts

export async function calculateBills() {
  // Get unbilled usage
  const unbilledUsage = await db.query.usage_hourly.findMany({
    where: eq(usage_hourly.billed, false),
    with: {
      customer: {
        columns: {
          id: true,
          subscription_tier: true,
          billing_rate: true
        }
      }
    }
  })

  // Group by customer and calculate charges
  const chargesByCustomer = groupAndCalculate(unbilledUsage)

  // Insert billing records (idempotent)
  for (const [customerId, charges] of chargesByCustomer) {
    await db.transaction(async (tx) => {
      // Insert billing record
      await tx.insert(billing_records)
        .values({
          customer_id: customerId,
          period_start: charges.periodStart,
          period_end: charges.periodEnd,
          total_requests: charges.totalRequests,
          total_bandwidth_gb: charges.totalBandwidthGB,
          amount_usd: charges.amountUSD,
          status: 'pending'
        })
        .onConflictDoNothing()

      // Mark usage as billed
      await tx.update(usage_hourly)
        .set({ billed: true, billed_at: new Date() })
        .where(
          and(
            eq(usage_hourly.customer_id, customerId),
            gte(usage_hourly.hour, charges.periodStart),
            lte(usage_hourly.hour, charges.periodEnd)
          )
        )
    })
  }
}
```

### Task: Generate MA_VAULT (Primary - Customer Configurations)

```typescript
// services/global-manager/src/tasks/generate-ma-vault.ts
import { execSync } from 'child_process'

export async function generateMAVault() {
  // Get all active customers with limits
  const customers = await db.query.customers.findMany({
    where: eq(customers.status, 'active'),
    with: {
      api_keys: true,
      limits: true
    }
  })

  // Build MA_VAULT data structure (key-value format for kvcrypt)
  const vaultData: Record<string, string> = {}

  for (const customer of customers) {
    // Store customer config as JSON string value
    // See SEAL_SERVICE_CONFIG.md for tier structure and rate limit definitions
    const customerConfig = {
      api_keys: customer.api_keys.map(k => k.key_hash),
      tier: customer.tier || 'starter',
      limits: {
        guaranteed_rps: customer.limits?.guaranteed_rps || 100,  // Starter tier default
        burst_rps: customer.limits?.burst_rps || 0,  // 0 for starter tier (no burst)
        burst_duration_sec: customer.limits?.burst_duration_sec || 0
      },
      status: customer.limits?.status || 'active'
    }

    // Key format: "customer:{customer_id}"
    vaultData[`customer:${customer.id}`] = JSON.stringify(customerConfig)
  }

  // Generate content hash for change detection
  const vaultContent = JSON.stringify(vaultData, null, 2)
  const vaultHash = crypto.createHash('sha256').update(vaultContent).digest('hex')

  // Check if this version already exists
  const existing = await db.query.vault_versions.findFirst({
    where: eq(vault_versions.content_hash, vaultHash)
  })

  if (!existing) {
    // New version - write to MA_VAULT using kvcrypt
    for (const [key, value] of Object.entries(vaultData)) {
      try {
        // Use kvcrypt to store encrypted key-value pairs
        // This creates ma-{timestamp}-{hashes}.enc files in /opt/syncf/data_tx/ma/
        execSync(`/home/olet/walrus/scripts/sync/kvcrypt.py put ma "${key}" '${value}'`, {
          stdio: 'pipe'
        })
      } catch (error) {
        logger.error({ key, error }, 'Failed to write to MA_VAULT')
        throw error
      }
    }

    // Record version in database
    await db.insert(vault_versions).values({
      version: Date.now(),
      content_hash: vaultHash,
      customer_count: customers.length,
      created_at: new Date()
    })

    logger.info({ hash: vaultHash, count: customers.length }, 'New MA_VAULT version generated')

    // Note: sync-files.py (systemd timer) will automatically distribute
    // the ma-*.enc files to API Gateway servers via rsync
  } else {
    logger.info({ hash: vaultHash }, 'MA_VAULT unchanged, skipping generation')
  }
}
```

### Systemd Configuration

```ini
# /etc/systemd/system/suiftly-global-manager.service
[Unit]
Description=Suiftly Global Manager (Metering, Billing, Vault)
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=oneshot
User=deploy
Group=deploy
WorkingDirectory=/var/www/global-manager

Environment="NODE_ENV=production"
Environment="DATABASE_URL=postgresql://suiftly@localhost/suiftly_prod"

ExecStart=/usr/bin/node dist/index.js

Restart=on-failure
RestartSec=30s

# Resource limits
MemoryMax=512M
CPUQuota=50%

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=suiftly-global

# Security
PrivateTmp=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/suiftly/ma_vault
```

```ini
# /etc/systemd/system/suiftly-global-manager.timer
[Unit]
Description=Run Suiftly Global Manager every 5 minutes
Requires=suiftly-global-manager.service

[Timer]
# Run every 5 minutes
OnCalendar=*:00/5
OnBootSec=30s
Persistent=true
RandomizedDelaySec=10s

[Install]
WantedBy=timers.target
```

---

## 2. Local Manager (Distributed)

Runs on each API Gateway server, applies configuration and rate limits locally.

### Implementation

```typescript
// services/local-manager/src/index.ts

import { execSync } from 'child_process'
import { updateHAProxyConfig } from './lib/haproxy'
import { checkHealth } from './lib/health'
import pino from 'pino'

const logger = pino({ name: 'local-manager' })

const CONFIG = {
  HAPROXY_CONFIG_DIR: '/etc/haproxy',
  MA_VAULT_PATH: '/opt/syncf/data/ma',  // Where sync-files installs MA_VAULT
  RUN_INTERVAL: '30s'
}

async function main() {
  logger.info({ config: CONFIG }, 'Local Manager started')

  try {
    // 1. Read all customer configs from MA_VAULT using kvcrypt
    let vaultData: Record<string, any> = {}

    try {
      // Get all key-value pairs from MA_VAULT
      const result = execSync('/home/olet/walrus/scripts/sync/kvcrypt.py get-all ma --show-value', {
        encoding: 'utf-8'
      })

      const response = JSON.parse(result)
      if (response.status === 'success') {
        // Parse customer configurations
        for (const [key, value] of Object.entries(response.data)) {
          if (key.startsWith('customer:')) {
            const customerId = key.replace('customer:', '')
            vaultData[customerId] = JSON.parse(value as string)
          }
        }
      }
    } catch (error) {
      logger.error({ error }, 'Failed to read MA_VAULT')
      // Continue with last known config if vault read fails
    }

    if (Object.keys(vaultData).length === 0) {
      logger.warn('No customer data in MA_VAULT, skipping update')
      return
    }

    // 2. Check if configuration changed
    const vaultHash = crypto.createHash('sha256')
      .update(JSON.stringify(vaultData))
      .digest('hex')

    const currentHash = await fs.readFile('/var/cache/local-manager/current.hash', 'utf-8').catch(() => '')

    if (currentHash === vaultHash) {
      logger.info('Customer configuration unchanged, skipping update')
      return
    }

    // 3. Generate HAProxy map files
    const mapContent = generateHAProxyMap(vaultData)
    await fs.writeFile(`${CONFIG.HAPROXY_CONFIG_DIR}/api_limits.map`, mapContent)

    // 4. Update sticky table entries via HAProxy socket
    await updateStickyTables(vaultData)

    // 5. Reload HAProxy (graceful)
    await exec('systemctl reload haproxy')

    // 6. Verify health
    const healthy = await checkHealth()
    if (!healthy) {
      throw new Error('HAProxy health check failed after reload')
    }

    // 7. Save current hash
    await fs.writeFile('/var/cache/local-manager/current.hash', vaultHash)

    logger.info({ customerCount: Object.keys(vaultData).length }, 'Local Manager completed successfully')

  } catch (error) {
    logger.error({ error }, 'Local Manager failed')

    // Report failure to monitoring
    await reportFailure(error)

    process.exit(1)
  }
}

// Generate HAProxy map file from vault
function generateHAProxyMap(vaultData: Record<string, any>): string {
  const lines = []

  for (const [customerId, config] of Object.entries(vaultData)) {
    for (const apiKey of config.api_keys || []) {
      // Format: api_key customer_id,tier,guaranteed_rps,burst_rps
      // See SEAL_SERVICE_CONFIG.md for tier definitions
      lines.push(`${apiKey} ${customerId},${config.tier},${config.limits.guaranteed_rps},${config.limits.burst_rps}`)
    }
  }

  return lines.join('\n')
}

// Update HAProxy sticky tables via socket
async function updateStickyTables(vaultData: Record<string, any>) {
  const socket = net.createConnection('/var/run/haproxy/admin.sock')

  for (const [customerId, config] of Object.entries(vaultData)) {
    if (config.status === 'suspended') {
      // Add to block list
      socket.write(`add table api_backend blocked_customers ${customerId}\n`)
    } else if (config.status === 'throttled') {
      // Set reduced limits (50% of guaranteed rate)
      socket.write(`set table api_backend customer_limits ${customerId} data.int(0) ${config.limits.guaranteed_rps / 2}\n`)
    }
  }

  socket.end()
}

main().catch(err => {
  logger.fatal({ error: err }, 'Fatal error')
  process.exit(1)
})
```

### Systemd Configuration

```ini
# /etc/systemd/system/suiftly-local-manager.service
[Unit]
Description=Suiftly Local Manager (HAProxy Config Updates)
After=network.target haproxy.service
Requires=haproxy.service

[Service]
Type=oneshot
User=haproxy
Group=haproxy
WorkingDirectory=/var/lib/suiftly/local-manager

Environment="NODE_ENV=production"
Environment="VAULT_URL=https://internal.suiftly.io/ma-vault"

ExecStart=/usr/bin/node dist/index.js

Restart=on-failure
RestartSec=10s

# Security
PrivateTmp=yes
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/etc/haproxy /var/cache/ma_vault
```

```ini
# /etc/systemd/system/suiftly-local-manager.timer
[Unit]
Description=Run Suiftly Local Manager every 30 seconds
Requires=suiftly-local-manager.service

[Timer]
# Run every 30 seconds
OnCalendar=*:*:00,30
OnBootSec=10s
Persistent=false

[Install]
WantedBy=timers.target
```

---

## 3. HAProxy Configuration

### Sticky Tables and Rate Limiting

```haproxy
# /etc/haproxy/haproxy.cfg

global
    stats socket /var/run/haproxy/admin.sock mode 660 level admin

defaults
    log global
    option httplog

frontend api_frontend
    bind *:443 ssl crt /etc/ssl/certs/suiftly.pem

    # Extract API key
    http-request set-var(txn.api_key) hdr(X-API-Key)

    # Map API key to customer limits
    http-request set-var(txn.customer_limits) map(/etc/haproxy/api_limits.map,txn.api_key)

    # Parse limits (customer_id,tier,guaranteed_rps,burst_rps)
    # See SEAL_SERVICE_CONFIG.md for tier definitions
    http-request set-var(txn.customer_id) field(1,txn.customer_limits,',')
    http-request set-var(txn.tier) field(2,txn.customer_limits,',')
    http-request set-var(txn.guaranteed_rps) field(3,txn.customer_limits,',')
    http-request set-var(txn.burst_rps) field(4,txn.customer_limits,',')

    use_backend api_backend

backend api_backend
    # Stick table for rate limiting (100k entries, 60s expiry)
    stick-table type string len 64 size 100k expire 60s \
                store http_req_rate(1s),http_req_rate(60s),conn_cur

    # Track by customer ID
    http-request track-sc0 var(txn.customer_id) if { var(txn.customer_id) -m found }

    # Apply guaranteed rate limits
    http-request deny if { sc_http_req_rate(0) gt var(txn.guaranteed_rps) }

    # Blocked customers table
    stick-table type string len 64 size 10k expire 5m \
                store gpc0
    http-request deny if { var(txn.customer_id) table_lookup(blocked_customers) }

    # Custom log format for metering
    log-format "%t %{+Q}[var(txn.customer_id)] %{+Q}[var(txn.api_key)] %HM %HU %ST %B %TR %Tt"

    server api1 10.0.0.1:3000 check
    server api2 10.0.0.2:3000 check
```

---

## 4. Fluentd Configuration

```ruby
# /etc/fluentd/fluent.conf

# Receive HAProxy syslog
<source>
  @type syslog
  port 514
  bind 0.0.0.0
  tag haproxy
  <parse>
    @type regexp
    expression /^(?<timestamp>[^ ]+) (?<customer_id>[^ ]+) (?<api_key>[^ ]+) (?<method>[^ ]+) (?<path>[^ ]+) (?<status>\d+) (?<bytes_out>\d+) (?<backend_time>\d+) (?<total_time>\d+)/
  </parse>
</source>

# Buffer and batch to PostgreSQL
<match haproxy.**>
  @type postgres_bulk
  host db1.suiftly.io
  port 5432
  database suiftly_prod
  username fluentd
  password ${FLUENTD_DB_PASSWORD}

  table haproxy_logs
  column_names timestamp,customer_id,service_type,endpoint,method,status_code,bytes_out,request_time_ms

  <buffer>
    @type memory
    flush_interval 1s
    chunk_limit_size 1MB
    total_limit_size 10MB
    retry_max_interval 30s
    overflow_action drop_oldest_chunk
  </buffer>
</match>
```

---

## 5. Database Schema

```sql
-- Processing state tracking
CREATE TABLE processing_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Worker run history
CREATE TABLE worker_runs (
  id SERIAL PRIMARY KEY,
  worker_type TEXT NOT NULL, -- 'global-manager', 'local-manager'
  server_name TEXT,
  task_name TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INT,
  error_message TEXT,
  executed_at TIMESTAMPTZ DEFAULT NOW()
);

-- HAProxy logs (TimescaleDB) - see CUSTOMER_SERVICE_SCHEMA.md for complete schema
CREATE TABLE haproxy_logs (
  timestamp TIMESTAMPTZ NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
  api_key_id VARCHAR(100),
  service_type TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  status_code INT,
  bytes_in BIGINT,
  bytes_out BIGINT,
  request_time_ms INT,
  backend_time_ms INT,
  haproxy_server TEXT,
  region TEXT
);

SELECT create_hypertable('haproxy_logs', 'timestamp', chunk_time_interval => INTERVAL '7 days');
SELECT add_compression_policy('haproxy_logs', INTERVAL '7 days');
SELECT add_retention_policy('haproxy_logs', INTERVAL '90 days');

-- Usage aggregates
CREATE TABLE usage_hourly (
  hour TIMESTAMPTZ NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
  service_type TEXT NOT NULL,
  request_count BIGINT,
  bytes_in BIGINT,
  bytes_out BIGINT,
  error_count INT,
  billed BOOLEAN DEFAULT FALSE,
  billed_at TIMESTAMPTZ,
  PRIMARY KEY (hour, customer_id, service_type)
);

-- Billing records
CREATE TABLE billing_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  total_requests BIGINT,
  total_bandwidth_gb NUMERIC(10,2),
  amount_usd NUMERIC(10,2),
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(customer_id, period_start, period_end)
);

-- NOTE: For complete database schema, see CUSTOMER_SERVICE_SCHEMA.md
-- This section shows only the tables specific to background workers

-- Customer limits (see SEAL_SERVICE_CONFIG.md for tier definitions)
CREATE TABLE customer_limits (
  customer_id INTEGER PRIMARY KEY REFERENCES customers(customer_id),
  tier TEXT NOT NULL DEFAULT 'starter',  -- starter, pro, business, enterprise
  rate_limits JSONB DEFAULT '{}',      -- {guaranteed_rps, burst_rps, burst_duration_sec}
  quotas JSONB DEFAULT '{}',
  status TEXT DEFAULT 'active',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- MA_VAULT versions
CREATE TABLE vault_versions (
  id SERIAL PRIMARY KEY,
  version BIGINT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE,
  encrypted_content BYTEA,
  customer_count INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## Deployment

### Install Global Manager (on DB server)

```bash
# Build
cd services/global-manager
npm run build

# Deploy
scp -r dist/ db1.suiftly.io:/var/www/global-manager/
scp systemd/* db1.suiftly.io:/tmp/

# Install systemd
ssh db1.suiftly.io '
  sudo cp /tmp/suiftly-global-manager.* /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now suiftly-global-manager.timer
'
```

### Install Local Manager (on each API Gateway)

```bash
# Build
cd services/local-manager
npm run build

# Deploy to each API Gateway server
for server in api-gateway1 api-gateway2 api-gateway3; do
  scp -r dist/ $server.suiftly.io:/var/lib/suiftly/local-manager/
  scp systemd/* $server.suiftly.io:/tmp/

  ssh $server.suiftly.io '
    sudo cp /tmp/suiftly-local-manager.* /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now suiftly-local-manager.timer
  '
done
```

---

## Monitoring & Health Checks

### API Endpoints

```typescript
// apps/api/src/routes/health.ts

// Check global manager health
router.get('/health/global-manager', async (req, res) => {
  const lastRun = await db.query.worker_runs.findFirst({
    where: and(
      eq(worker_runs.worker_type, 'global-manager'),
      eq(worker_runs.status, 'success')
    ),
    orderBy: desc(worker_runs.executed_at)
  })

  const minutesSinceRun = (Date.now() - lastRun.executed_at.getTime()) / 60000

  if (minutesSinceRun > 15) {
    return res.status(503).send({
      status: 'unhealthy',
      message: `Global manager hasn't run in ${minutesSinceRun} minutes`
    })
  }

  return res.send({ status: 'healthy', last_run: lastRun.executed_at })
})

// Check local managers health
router.get('/health/local-managers', async (req, res) => {
  const servers = ['api-gateway1', 'api-gateway2', 'api-gateway3']
  const health = {}

  for (const server of servers) {
    const lastRun = await db.query.worker_runs.findFirst({
      where: and(
        eq(worker_runs.worker_type, 'local-manager'),
        eq(worker_runs.server_name, server)
      ),
      orderBy: desc(worker_runs.executed_at)
    })

    const minutesSinceRun = (Date.now() - lastRun?.executed_at.getTime() || 0) / 60000
    health[server] = minutesSinceRun < 5 ? 'healthy' : 'unhealthy'
  }

  const allHealthy = Object.values(health).every(s => s === 'healthy')
  return res.status(allHealthy ? 200 : 503).send({ health })
})
```

### Monitoring Commands

```bash
# Check global manager status
systemctl status suiftly-global-manager.timer
journalctl -u suiftly-global-manager -f

# Check local manager status (on API Gateway servers)
systemctl status suiftly-local-manager.timer
journalctl -u suiftly-local-manager -f

# View next run times
systemctl list-timers suiftly-*

# Manual run for testing
systemctl start suiftly-global-manager.service
systemctl start suiftly-local-manager.service
```

---

## Testing Strategy

### Unit Tests

```typescript
// services/global-manager/tests/tasks.test.ts
test('aggregateLogs is idempotent', async () => {
  await aggregateLogs()
  await aggregateLogs()

  const usage = await db.query.usage_hourly.findMany()
  expect(new Set(usage.map(u => u.id)).size).toBe(usage.length)
})

test('vault generation produces deterministic output', async () => {
  const vault1 = await generateVault()
  const vault2 = await generateVault()

  expect(vault1.hash).toBe(vault2.hash)
})
```

### Integration Tests

```typescript
// tests/integration/workers.test.ts
test('end-to-end metering flow', async () => {
  // 1. Insert test logs
  await insertTestLogs()

  // 2. Run global manager
  await runGlobalManager()

  // 3. Verify aggregates created
  const aggregates = await db.query.usage_hourly.findMany()
  expect(aggregates).toHaveLength(10)

  // 4. Verify billing records
  const bills = await db.query.billing_records.findMany()
  expect(bills).toHaveLength(3)

  // 5. Verify vault generated
  const vault = await fs.readFile('/var/lib/suiftly/ma_vault/latest.enc')
  expect(vault).toBeDefined()
})
```

---

## Security Considerations

1. **MA_VAULT Encryption** - AES-256-GCM with rotating keys
2. **PostgreSQL Advisory Locks** - Prevent concurrent execution
3. **Systemd Security** - ProtectSystem, PrivateTmp, limited permissions
4. **API Key Hashing** - Only store hashed keys in logs
5. **Rate Limit Bypass** - Internal services use separate backend
6. **Audit Trail** - All configuration changes logged

---

## Performance Optimizations

1. **Continuous Aggregates** - Pre-computed usage metrics
2. **Batch Processing** - Process logs in chunks
3. **Connection Pooling** - Reuse database connections
4. **Incremental Updates** - Only process new data
5. **Content Hashing** - Skip unchanged vault updates

---

## Disaster Recovery

### Backup Strategy

```bash
# Backup worker state and configs
pg_dump -t processing_state -t worker_runs -t vault_versions > worker_state.sql

# Restore on new server
psql suiftly_prod < worker_state.sql

# Restart workers
systemctl restart suiftly-global-manager.timer
```

### Failure Recovery

- **Global Manager Failure** - Advisory lock expires, next run continues
- **Local Manager Failure** - HAProxy continues with last known config
- **Database Failure** - Workers retry with exponential backoff
- **Network Partition** - Local managers use cached vault

---

## Future Enhancements

1. **Real-time Updates** - WebSocket push for instant rate limit changes
2. **Multi-region** - Regional aggregation before global billing
3. **Machine Learning** - Anomaly detection for usage patterns
4. **GraphQL Subscriptions** - Live usage updates in dashboard
5. **Kubernetes Operators** - Cloud-native deployment option

---

## Appendix: MM_VAULT (Encryption Keys Management)

### Overview

MM_VAULT (Mainnet-Master vault) contains encryption keys that customers have imported for use with the Seal service. This vault is:
- **Significantly smaller** than MA_VAULT (only customers with imported keys)
- **Less frequently updated** (only when customers import/update keys)
- **Read by key-servers on restart** (not by HAProxy/Local Managers)
- **Not critical for initial MVP** (key import feature can be added later)

### MM_VAULT Generation

The Global Manager also generates MM_VAULT alongside MA_VAULT:

```typescript
// services/global-manager/src/tasks/generate-mm-vault.ts

export async function generateMMVault() {
  // Get customers with imported encryption keys
  const importedKeys = await db.query.customer_encryption_keys.findMany({
    where: eq(customer_encryption_keys.status, 'active'),
    with: {
      customer: true
    }
  })

  // Build MM_VAULT data structure
  const mmVaultData: Record<string, string> = {}

  for (const keyRecord of importedKeys) {
    // Store encryption key config
    const keyConfig = {
      customer_id: keyRecord.customer_id,
      key_id: keyRecord.key_id,
      key_type: keyRecord.key_type,
      encrypted_key: keyRecord.encrypted_key_material,
      metadata: keyRecord.metadata,
      created_at: keyRecord.created_at
    }

    // Key format: "key:{customer_id}:{key_id}"
    mmVaultData[`key:${keyRecord.customer_id}:${keyRecord.key_id}`] = JSON.stringify(keyConfig)
  }

  // Only write if there are keys to store
  if (Object.keys(mmVaultData).length > 0) {
    // Write to MM_VAULT using kvcrypt
    for (const [key, value] of Object.entries(mmVaultData)) {
      execSync(`/home/olet/walrus/scripts/sync/kvcrypt.py put mm "${key}" '${value}'`, {
        stdio: 'pipe'
      })
    }

    logger.info({ keyCount: Object.keys(mmVaultData).length }, 'MM_VAULT updated with imported keys')
  }
}
```

### MM_VAULT Distribution and Usage

1. **Distribution**: Same as MA_VAULT - sync-files.py distributes to all servers
2. **Consumption**: Key-servers read MM_VAULT on startup to load customer encryption keys
3. **Security**: Even more restricted access than MA_VAULT (mm-readers group)

### Database Schema for Key Management

```sql
-- Customer encryption keys (for MM_VAULT)
CREATE TABLE customer_encryption_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id),
  key_id TEXT NOT NULL,
  key_type TEXT NOT NULL, -- 'aes256', 'rsa4096', etc
  encrypted_key_material TEXT NOT NULL, -- The actual encrypted key
  metadata JSONB DEFAULT '{}',
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(customer_id, key_id)
);
```

### Timeline

- **Phase 1 (MVP)**: Focus on MA_VAULT only, no key import support
- **Phase 2**: Add key import UI and MM_VAULT generation
- **Phase 3**: Full key lifecycle management (rotation, revocation)