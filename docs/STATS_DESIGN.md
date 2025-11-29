# Stats Design

## Overview

Stats system for Suiftly services serving three purposes:
1. **Billing** - Aggregated usage data for monthly charging
2. **Dashboard** - Service status, alarms, and 24h summary stats
3. **Service Stats Page** - Detailed time-series graphs per service

**Related:** [BILLING_DESIGN.md](./BILLING_DESIGN.md)

**Data Source:** HAProxy logs defined in `~/walrus/docs/HAPROXY_LOGS.md` (source of truth for schema).

**Pipeline:** HAProxy → rsyslog → Fluentd → TimescaleDB

---

## Requirements

### R1: Data Sources

**Source:** HAProxy logs ingested via Fluentd into TimescaleDB `haproxy_raw_logs` table.

**Available fields from HAProxy logs (per HAPROXY_LOGS.md):**

| Field | Description | Use |
|-------|-------------|-----|
| `customer_id` | Customer identifier (from API key) | Billing, stats grouping |
| `service_type` | 1=Seal, 2=SSFN, 3=Sealo | Per-service stats |
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
| **Metrics (MVP)** | Request count (usage), avg response time (rt) |
| **Per-service** | Separate stats page per service instance |
| **Real-time** | < 5 minute delay acceptable |

**Post-MVP:**
- Client errors (4xx), server errors (5xx) breakdown
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
| Write throughput | 10,000 events/sec per service type (Seal/SSFN/Sealo) |
| Query rt (Service Stats Page) | < 500ms for 30-day range |
| Billing aggregation | < 10s for all customers |
| Dashboard staleness | MVP accepts ~1h (hourly aggregate refresh) |

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
| **Idempotency** | Track `last_billed_timestamp` per customer to avoid double-counting |

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
| **Aggregation refresh** | `stats_per_hour`: hourly, `stats_per_min`: 1 min |
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

## Design (TODO)

Design section to be added after requirements are finalized.

---

**Version:** 1.4
**Last Updated:** 2025-01-29
**Status:** Requirements Draft
