# Stats Design

## Overview

Stats system for Suiftly services serving three purposes:
1. **Billing** - Aggregated usage data for monthly charging
2. **Dashboard** - Service status, alarms, and 24h summary stats
3. **Service Stats Page** - Detailed time-series graphs per service

**Related:** [BILLING_DESIGN.md](./BILLING_DESIGN.md)

**Data Source:** HAProxy logs defined in `~/mhaxbe/docs/HAPROXY_LOGS.md` (source of truth for schema).

**Pipeline:** HAProxy → rsyslog → Fluentd → TimescaleDB

---

## Requirements

### R1: Data Sources

**Source:** HAProxy logs ingested via Fluentd into TimescaleDB `haproxy_raw_logs` table.

**Available fields from HAProxy logs (per HAPROXY_LOGS.md):**

| Field | Description | Use |
|-------|-------------|-----|
| `customer_id` | Customer identifier (from API key) | Billing, stats grouping |
| `service_type` | 1=Seal, 2=gRPC, 3=GraphQL | Per-service stats |
| `network` | 0=testnet, 1=mainnet | Network filtering |
| `traffic_type` | 1=guaranteed, 2=burst, 3-6=denied/dropped | Billable vs non-billable |
| `bytes_sent` | Response body size | Ops monitoring (infra only) |
| `time_total` | Total response time (ms) | Response time (rt) stats |
| `status_code` | HTTP status | Success/error rates |
| `timestamp` | Request time | Time-series aggregation |

**Billable requests:** `traffic_type IN (1, 2)` (guaranteed + burst)

**Non-billable:** `traffic_type IN (3, 4, 5, 6)` (denied, dropped, unavailable)

### R2: Billing Aggregation

| Requirement | Details |
|-------------|---------|
| **Model** | Per-request billing for Seal (per BILLING_DESIGN.md) |
| **Frequency** | Aggregated on 1st of month when DRAFT → PENDING |
| **Granularity** | Per-customer, per-service (each service = line item) |
| **Output** | Line items added to customer's DRAFT invoice |
| **No threshold charging** | MVP charges monthly only, not mid-cycle |

**Note:** Bandwidth billing reserved for future services (e.g. GraphQL). `total_bytes` tracked in aggregates for ops monitoring only.

### R3: Dashboard Summary

Simple 24h stats shown on the main dashboard alongside service status.

| Metric | Description |
|--------|-------------|
| **Successful requests** | Count of 2xx responses (last 24h) |
| **Client errors** | Count of 4xx responses (last 24h) |
| **Server errors** | Count of 5xx responses (last 24h) |

**Per-service:** Each service instance shows its own 24h summary.

**Service status:** OK, Updating, Failed (separate from stats, based on health checks).

### R3b: Service Stats Page

Detailed stats accessible via dedicated route per service.

| Requirement | Details |
|-------------|---------|
| **Time ranges** | Last 24h, 7d, 30d |
| **Granularity** | Hourly (24h), daily (7d/30d) |
| **Metrics (MVP)** | Traffic breakdown (stacked), avg response time (rt) |
| **Per-service** | Separate stats page per service instance |
| **Real-time** | < 5 minute delay acceptable |

**Traffic Chart (stacked bar):**

| Category | Source | Color | Description |
|----------|--------|-------|-------------|
| **Guaranteed** | traffic_type=1, status 2xx | Green | Successfully served guaranteed traffic |
| **Burst** | traffic_type=2, status 2xx | Blue | Successfully served burst traffic |
| **Rejected** | traffic_type IN (3-6) | Yellow | Blocked at the edge — rate limit, IP block, API key issue, or service disabled |
| **Invalid Request** | status 4xx, traffic_type NOT IN (3-6) | Orange | Reached the backend but failed validation (malformed payload, unknown endpoint, etc.) |
| **Server Error** | status 5xx, traffic_type NOT IN (3-6) | Red | Backend responded with a 5xx — typically a transient issue on our side |

**Naming rationale:** "Rejected" and "Invalid Request" are split by *who* refused the request, not by HTTP class. Edge-level refusals (auth, quota, IP, disabled) go into Rejected because the customer's remediation is different (top up balance, check API key, upgrade tier) from a backend 4xx (fix their payload). "Rejected" also includes traffic-type 4–6 which aren't strictly rate-limits — hence the rename from the older "Rate Limited" label.

**Post-MVP:**
- p95 rt (available in `stats_per_hour` if needed)
- 1h debugging view (`stats_per_min`)
- Enterprise grouping: per Seal-Key, per API-Key, per Region

### R4: Data Retention

| Data Type | Retention | Purpose | MVP |
|-----------|-----------|---------|-----|
| `haproxy_raw_logs` | 7d | Raw logs (safety buffer) | ✓ |
| `stats_per_hour` | 90d | Dashboard + stats page + billing | ✓ |
| `stats_per_min` | 24h | Customer debugging (1-min) | - |
| `infra_per_min` | 24h | Ops debugging (1-min) | - |
| `infra_per_hour` | 30d | Ops short-term trends | - |
| `infra_per_day` | 2y | Ops long-term trends | - |
| Billing records | Forever | PostgreSQL (suiftly-co) | ✓ |

**Note:** For debugging aggregates, only the last 1h is shown to users despite 24h retention.

### R5: Performance

| Requirement | Target |
|-------------|--------|
| Write throughput | 10,000 events/sec per service type (Seal/gRPC/GraphQL) |
| Query rt (Service Stats Page) | < 500ms for 30-day range |
| Billing aggregation | < 10s for all customers |
| Dashboard staleness | ~1–2 min (hybrid query: `stats_per_hour` + `stats_per_min` tail) |

### R6: Data Flow

```
HAProxy → rsyslog → Fluentd → haproxy_raw_logs (7d)
                                      ↓
                         TimescaleDB Continuous Aggregates
                                      ↓
                              ┌───────┴───────┐
                              ↓               ↓
                          stats_*         infra_per_min (24h)
                              ↓                   ↓ cascades
                      ┌───────┴───────┐   infra_per_hour (30d)
                      ↓               ↓           ↓ cascades
              stats_per_hour   stats_per_min  infra_per_day (2y)
                  (90d)           (24h)
```

**Customer aggregates:**
- `stats_per_hour`: Dashboard summary + Service Stats Page + billing
- `stats_per_min`: Customer debugging (1-min buckets)

**Ops aggregates (cascading):**
- `infra_per_min`: Debugging current issues
- `infra_per_hour`: Short-term trend analysis (cascades from infra_per_min)
- `infra_per_day`: Long-term trend analysis (cascades from infra_per_hour)

### R7: Billing Integration

| Requirement | Details |
|-------------|---------|
| **Input to billing** | Query `stats_per_hour` for customer usage |
| **Charging trigger** | 1st of month: periodic job processes DRAFT invoices |
| **Line items** | Usage charges added per-service to DRAFT invoice |
| **Idempotency** | Delete-then-insert usage line items per DRAFT invoice (bounded by invoice's billing period — no per-service timestamp needed) |

### R8: Stats API

**MVP:**

| Endpoint | Purpose |
|----------|---------|
| `GET /stats/summary` | Dashboard: 24h totals (success, client errors, server errors) |
| `GET /stats/usage` | Service Stats Page: Request counts over time |
| `GET /stats/rt` | Service Stats Page: Response time over time |

### R9: Accuracy

| Aspect | Decision |
|--------|----------|
| **Billing accuracy** | Exact (no sampling) |
| **Stats accuracy** | Exact (no sampling) |
| **High-volume (future)** | Pre-aggregation at serving node if needed |
| **Aggregation refresh** | `stats_per_hour`: every 5 min (10 min lag), `stats_per_min`: every 1 min (1 min lag) |
| **Timezone** | All timestamps UTC |

### R10: Failure Handling

| Scenario | Behavior |
|----------|----------|
| Stats ingestion down | Queue events, replay on recovery |
| Aggregation job fails | Retry with idempotency, alert ops |
| Missing data | Never charge for missing periods (customer-favorable) |

---

## Open Questions

1. ~~**Storage engine**~~ → **TimescaleDB** (decided)
2. ~~**Event format**~~ → HAProxy log format per `HAPROXY_LOGS.md` (decided)
3. ~~**Ingestion path**~~ → Fluentd direct DB writes (decided)
4. ~~**Pricing model**~~ → **Per-request** for Seal (decided). Bandwidth billing for future services (e.g. GraphQL).

---

## Design

### D1: TimescaleDB + DBClock Compatibility

**Key insight:** Continuous aggregates operate on *data timestamps* (the `timestamp` column in `haproxy_raw_logs`), not query time. DBClock controls *when* the billing job runs, not *which data* is aggregated.

| Concern | Solution |
|---------|----------|
| Aggregate refresh | Real-time (TimescaleDB background worker) |
| Billing period boundaries | Computed using DBClock at query time |
| Test data | Insert with mock `timestamp` values, force refresh |

**Implication:** No special DBClock integration needed in continuous aggregates. The existing periodic job pattern works unchanged.

### D2: Schema (MVP)

**Continuous Aggregate:** `stats_per_hour`

```sql
CREATE MATERIALIZED VIEW stats_per_hour
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', timestamp) AS bucket,
  customer_id,
  service_type,
  network,
  -- Traffic breakdown (for stacked Traffic chart)
  COUNT(*) FILTER (WHERE traffic_type = 1 AND status_code >= 200 AND status_code < 300) AS guaranteed_success_count,
  COUNT(*) FILTER (WHERE traffic_type = 2 AND status_code >= 200 AND status_code < 300) AS burst_success_count,
  COUNT(*) FILTER (WHERE traffic_type IN (3, 4, 5, 6)) AS dropped_count,
  -- Error breakdown (shared across traffic types)
  COUNT(*) FILTER (WHERE status_code >= 400 AND status_code < 500) AS client_error_count,
  COUNT(*) FILTER (WHERE status_code >= 500) AS server_error_count,
  -- Billing (guaranteed + burst, regardless of status)
  COUNT(*) FILTER (WHERE traffic_type IN (1, 2)) AS billable_requests,
  -- Legacy/summary (all 2xx)
  COUNT(*) FILTER (WHERE status_code >= 200 AND status_code < 300) AS success_count,
  -- Performance
  AVG(time_total) AS avg_response_time_ms,
  SUM(bytes_sent) AS total_bytes
FROM haproxy_raw_logs
WHERE customer_id IS NOT NULL
GROUP BY bucket, customer_id, service_type, network;
```

**Traffic chart uses:** `guaranteed_success_count`, `burst_success_count`, `dropped_count`, `client_error_count`, `server_error_count`

**Dashboard summary uses:** `success_count`, `client_error_count`, `server_error_count`

**Billing uses:** `billable_requests`

**Refresh policy:** Every 5 minutes, lag 10 minutes.

**Retention:** 90 days (TimescaleDB policy).

**Freshness note:** The dashboard and stats charts read `stats_per_hour` for
completed hours and append a tail from `stats_per_min` (1-min refresh, 1-min
lag, 24h retention) for the current hour. End-to-end freshness is therefore
~1–2 minutes, not 10 minutes. See `queries.ts::hourCutoff` and
`getStatsSummary`/`getBillableRequestCount` for the hybrid query pattern.

### D3: Periodic Job Integration

**Two concerns:**
1. **Stats aggregation** - Automatic (TimescaleDB continuous aggregate refresh)
2. **Usage billing** - Part of existing `runPeriodicBillingJob()`

**Updated Periodic Job Phases (1st of month):**
```
1. Apply scheduled tier changes
2. Process scheduled cancellations
3. ADD USAGE CHARGES ← NEW: Query stats, add line items to DRAFT
4. DRAFT → PENDING
5. Attempt payment
```

**Functions:** `syncUsageToDraft()` and `finalizeUsageChargesForBilling()` in `packages/database/src/billing/usage-charges.ts`

**Flow (draft sync, during the month):**
1. Compute `currentMonthStart = Date.UTC(yyyy, mm, 1)` and `now` from the clock.
2. For each service: query `getBillableRequestCount` and `getBillableBandwidth` over `[currentMonthStart, now)` (helpers' contract: hour-aligned).
3. Delete-then-insert `invoice_line_items` of type `requests` + `bandwidth` on the customer's DRAFT invoice (idempotent by construction).

**Flow (month-end finalize):**
1. Derive `usagePeriodStart` / `usagePeriodEnd` from the invoice's `billingPeriodStart` (calendar-month boundaries).
2. Query the same helpers over that window; write line items on the DRAFT.

**Idempotency:** Delete-then-insert usage line items (bounded by invoice id + the
`requests`/`bandwidth` item types). Calendar-aligned windows plus bounded deletes
make the operation naturally idempotent — no per-service cursor state is kept on
`service_instances`.

**Housekeeping (existing phase 5):** Add `stats_per_hour` retention cleanup if needed (TimescaleDB policy handles this, but verify).

### D4: Stats API

Read queries are hybrid: completed hours come from `stats_per_hour`, the
current hour is appended from `stats_per_min`. See the Freshness note above.

| Endpoint | Query |
|----------|-------|
| `GET /stats/summary` | hybrid: `stats_per_hour` for completed hours + `stats_per_min` tail |
| `GET /stats/traffic` | hybrid (same) — returns traffic breakdown per bucket |
| `GET /stats/rt` | hybrid (same) — returns avg/min/max response time per bucket |

**Traffic endpoint returns per bucket:**
- `guaranteed` - guaranteed_success_count
- `burst` - burst_success_count
- `dropped` - dropped_count
- `clientError` - client_error_count
- `serverError` - server_error_count

**Time range:** Query param `range`: `24h`, `7d`, `30d`. Uses DBClock for "now".

**File:** `packages/database/src/stats/queries.ts`

### D5: Test Strategy (3 Levels)

**Pattern:** Same as billing tests.

| Level | Location | Purpose |
|-------|----------|---------|
| **Unit (ut-)** | `packages/database/src/stats/ut-*.test.ts` | Query logic, aggregation math |
| **API** | `apps/api/tests/api-stats.test.ts` | Endpoint contracts, auth |
| **E2E** | `apps/webapp/tests/e2e/stats-*.spec.ts` | Dashboard display, graphs |

### D6: Mock Data Strategy

**Test helper:** `insertMockHAProxyLogs()`

```typescript
// packages/database/src/stats/test-helpers.ts
export async function insertMockHAProxyLogs(
  db: NodePgDatabase,
  customerId: number,
  options: {
    serviceType: 1 | 2 | 3;
    network: 0 | 1;
    count: number;
    timestamp: Date;       // Mock timestamp (from DBClock)
    statusCode?: number;   // Default: 200
    trafficType?: number;  // Default: 1 (guaranteed)
    responseTimeMs?: number; // Default: 50
  }
): Promise<void>;

export async function refreshStatsAggregate(db: NodePgDatabase): Promise<void> {
  await db.execute(sql`CALL refresh_continuous_aggregate('stats_per_hour', NULL, NULL)`);
}
```

**Test API endpoint:** `POST /test/stats/mock-logs` (insert logs + refresh aggregate)

**Usage in tests:**
```typescript
// 1. Set mock clock to billing period
await setMockClock(request, '2024-01-15T00:00:00Z');

// 2. Insert mock HAProxy logs with timestamps in the billing period
await request.post('/test/stats/mock-logs', {
  customerId: 1,
  serviceType: 1,
  count: 1000,
  timestamp: '2024-01-10T12:00:00Z'
});

// 3. Advance to 1st of next month, run billing job
await setMockClock(request, '2024-02-01T00:00:00Z');
await request.post('/test/billing/run-periodic-job');

// 4. Verify usage line item on invoice
```

### D7: Implementation Order

1. ✅ **Schema:** Add continuous aggregates (`stats_per_hour`, `stats_per_min`)
2. ✅ **Test helpers:** `insertMockHAProxyLogs()`, `refreshStatsAggregate()`
3. ✅ **Unit tests:** Write tests for query functions (TDD)
4. ✅ **Query functions:** `packages/database/src/stats/queries.ts`
5. ✅ **Billing integration:** Add `processUsageCharges()` to periodic job
6. ✅ **API tests:** Write tests for stats endpoints
7. ✅ **Stats API:** tRPC routes in `apps/api/src/routes/stats.ts`
8. ⏳ **E2E tests:** Dashboard summary, stats page (deferred)
9. ✅ **UI components:** Dashboard stats, stats page graphs

### D8: Implementation Status

| File | Status | Notes |
|------|--------|-------|
| `packages/database/src/stats/queries.ts` | ✅ Done | 5 query functions |
| `packages/database/src/stats/test-helpers.ts` | ✅ Done | 6 helper functions incl. demo data |
| `packages/database/src/stats/ut-stats-queries.test.ts` | ✅ Done | Comprehensive unit tests |
| `packages/database/src/billing/usage-charges.ts` | ✅ Done | `updateUsageChargesToDraft()`, `syncUsageToDraft()`, `getUsageChargePreview()` |
| `packages/database/src/billing/processor.ts` | ✅ Done | Hourly sync + monthly billing integration |
| `apps/api/src/routes/stats.ts` | ✅ Done | 8 tRPC endpoints |
| `apps/api/src/server.ts` | ✅ Done | 5 REST test endpoints |
| `apps/api/tests/api-stats.test.ts` | ✅ Done | 350+ lines of tests |
| `apps/webapp/src/routes/services/seal.stats.lazy.tsx` | ✅ Done | ~1010 lines, full stats page |
| `apps/webapp/src/routes/dashboard.tsx` | ✅ Done | 24h summary integration |
| `packages/database/src/timescale-setup.ts` | ✅ Done | Continuous aggregate setup |
| `packages/database/migrations/0000_initial_schema.sql` | ✅ Done | `haproxy_raw_logs` hypertable |
| `apps/webapp/tests/e2e/stats-*.spec.ts` | ⏳ Deferred | E2E tests not yet created |

### D9: Additional Implementation Details

**Test helpers provide:**
- `insertMockHAProxyLogs()` - Insert individual/batched logs with spread-across-hours support
- `insertMockMixedLogs()` - Realistic traffic mix with hourly variation (±30%)
- `refreshStatsAggregate()` - Force immediate refresh
- `clearCustomerLogs()` / `clearAllLogs()` - Cleanup helpers

**API endpoints implemented:**
- `stats.getSummary` - 24h dashboard summary
- `stats.getUsage` - Time-series billable requests (24h/7d/30d)
- `stats.getResponseTime` - Avg response time over time
- `stats.getTraffic` - Stacked traffic breakdown
- `stats.getUsagePreview` - Preview pending charges
- `stats.injectTestData` - Inject random traffic (dev/test)
- `stats.injectDemoData` - Inject realistic 24h pattern (dev/test)
- `stats.clearStats` - Clear customer stats (dev/test)

**Stats page UI features:**
- Time range selector (24h, 7d, 30d)
- Summary cards (total, success, rate limited, client errors, server errors)
- Stacked area chart for traffic breakdown
- Response time chart with 1-second threshold indicator
- Interactive tooltips and legends
- Dev-only test menu for data injection

---

**Version:** 2.0
**Last Updated:** 2025-12-05
**Status:** MVP Implemented
