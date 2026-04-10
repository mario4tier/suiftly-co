# gRPC Behind HAProxy: Feasibility Analysis

> **Working document** -- being refined over multiple sessions. Last updated: 2026-04-08.

## Context

Suiftly currently serves Seal (and SSFN) via HAProxy in **HTTP/1.1 mode** with a rich Layer 7 pipeline: Lua-based API key validation, per-customer/per-IP rate limiting via stick-tables, three-tier failover (local -> regional -> external), and Cloudflare tunnel integration. The question is whether adding **Sui gRPC services** is compatible with this architecture.

**Assumption:** One or more Sui gRPC fullnode processes run on each server, with inter-region fallback following the same HA pattern already implemented for other services.

### Sui API Landscape (as of 2026-04-08)

Sui is migrating away from JSON-RPC (sunset **July 31, 2026**) to two complementary APIs:

- **gRPC** -- High-performance, type-safe, binary protocol. Recommended for indexers, explorers, power users. Supports server-streaming (`SubscribeCheckpoints`). This is the focus of this document.
- **GraphQL RPC** -- Flexible queries, reduces overfetching, UI-ready JSON. Good for complex data fetches. GraphQL subscriptions (real-time) are planned but not yet available.

**Neither is replacing the other.** Both are part of the new Sui data stack. Suiftly may need to proxy both. GraphQL is plain HTTP POST (unary-like), so it works through existing HAProxy HTTP mode with zero changes -- same pattern as Seal's REST endpoints. GraphQL subscriptions (when they arrive) would follow the same streaming architecture designed here for gRPC.

---

## Sui gRPC API: What We're Proxying

Source: [MystenLabs/sui-apis](https://github.com/MystenLabs/sui-apis) (`proto/sui/rpc/v2/`)

### Method Inventory (22 methods across 7 services)

| Service | Methods | Type |
|---------|---------|------|
| **LedgerService** | GetServiceInfo, GetObject, BatchGetObjects, GetTransaction, BatchGetTransactions, GetCheckpoint, GetEpoch | Unary (7) |
| **StateService** | ListDynamicFields, ListOwnedObjects, GetCoinInfo, GetBalance, ListBalances | Unary (5) |
| **TransactionExecutionService** | ExecuteTransaction, SimulateTransaction | Unary (2) |
| **MovePackageService** | GetPackage, GetDatatype, GetFunction, ListPackageVersions | Unary (4) |
| **NameService** | LookupName, ReverseLookupName | Unary (2) |
| **SignatureVerificationService** | VerifySignature | Unary (1) |
| **SubscriptionService** | SubscribeCheckpoints | **Server-streaming (1)** |

**Summary: 21 unary, 1 server-streaming, zero client-streaming, zero bidirectional.**

This is highly favorable -- no bidi streaming eliminates the hardest Cloudflare constraint.

### SDK Behavior

- **TypeScript SDK** (`@mysten/sui`): Uses **gRPC-Web** (not native gRPC) via `@protobuf-ts/grpcweb-transport`. Single `baseUrl` per client instance. gRPC-Web works over HTTP/1.1.
- **Rust SDK** (`sui-rpc`): Native gRPC via **Tonic**. Single URI per `Client`. HTTP/2 keep-alive pings every 5s. Zstd compression on responses.
- **Both SDKs use a single URL per client.** No built-in per-service URL routing. To split unary vs streaming to different endpoints, create two client instances and use low-level service clients directly.
- **Third-party clients are NOT under our control** -- we must support standard gRPC protocol, cannot mandate gRPC-Web.

### Key Path for Routing Detection

HAProxy can distinguish streaming from unary via the gRPC path header:
```
# Streaming:
:path = /sui.rpc.v2.SubscriptionService/SubscribeCheckpoints

# Unary (examples):
:path = /sui.rpc.v2.LedgerService/GetObject
:path = /sui.rpc.v2.StateService/GetBalance
:path = /sui.rpc.v2.TransactionExecutionService/ExecuteTransaction
```

HAProxy ACL:
```
acl is_streaming path_beg /sui.rpc.v2.SubscriptionService/
```

---

## TL;DR

**Unary (21 methods) works with minimal changes through Cloudflare.** HAProxy 3.0.14 in `mode http` with `proto h2` preserves the entire Layer 7 pipeline (Lua auth, rate limiting, failover).

**Server-streaming (`SubscribeCheckpoints`) cannot go through Cloudflare** due to a hard 10-minute (600s) connection duration limit (Cloudflare sends `RST_STREAM` regardless of activity). It needs a separate path through OVH DDoS protection, served by the **Suiftly gRPC Aggregator** that aggregates multiple upstream sources for HA and lowest latency.

**Proposed split-routing architecture:**
```
Unary RPCs:     Client -> Cloudflare -> HAProxy (auth+LB, proto h2) -> Suiftly gRPC Aggregator -> fullnodes
Streaming RPCs: Client -> OVH DDoS  -> HAProxy (auth+LB, proto h2) -> Suiftly gRPC Aggregator -> fullnodes
```
HAProxy never talks directly to Sui fullnode code. The **Suiftly gRPC Aggregator** is our Rust process that handles both unary (with caching) and streaming (with multiplexing).

---

## What Fundamentally Works

### 1. HAProxy HTTP/2 in `mode http` -- No TCP mode needed
- HAProxy 3.0 normalizes HTTP/2 frames into the same internal representation as HTTP/1.1
- `bind :PORT proto h2` on frontend, `server ... proto h2` on backend
- **All Layer 7 features are preserved:** Lua scripts, header inspection, ACLs, stick-tables, logging
- No need for `mode tcp` (which would lose everything)

### 2. Lua API key validation -- Works unchanged
- gRPC metadata maps to HTTP/2 headers
- `txn.sf:req_hdr("X-API-Key")` reads gRPC metadata identically to HTTP/1.1 headers
- HTTP/2 requires lowercase headers, HAProxy matching is case-insensitive -- no conflict
- CF-Connecting-IP header injected by Cloudflare at edge level, survives protocol translation (unary path)

### 3. Per-RPC load balancing -- Works naturally
- In `mode http`, HAProxy demuxes HTTP/2 streams and distributes individual RPCs via round-robin
- Even if a client holds one TCP connection to HAProxy, each RPC is independently routed to backends
- This is the same per-request distribution used today for Seal
- `option redispatch` works for failed unary RPCs

### 4. Rate limiting for unary RPCs -- No changes needed
- Each gRPC unary RPC = one HTTP/2 stream = one `http_req_rate(1s)` increment
- The existing three-level model (GLIM/ILIM/BLIM via sc0/sc1/sc2) applies directly
- Customer config maps, IP allowlists, extra key maps -- all work unchanged

### 5. Three-tier failover -- Works as-is
- `nbsrv()` check + `default_backend` logic is protocol-agnostic
- Local -> regional backup -> external fallback applies to gRPC backends identically
- Health checks: Sui gRPC server exposes both `grpc.health.v1.Health/Check` and `GET /health` (returns `"up"`/`"down"`) on the same port -- no sidecar needed

### 6. Config generation -- Extensible
- `cfg_mgr_haservice.py` already has a clean service-type pattern (Seal, SSFN, SEALO)
- Adding a gRPC service type follows the same template with `proto h2` directives added

---

## Split-Routing Architecture

### Why Split?

| | Unary (21 methods) | Streaming (SubscribeCheckpoints) |
|---|---|---|
| Request pattern | Short-lived request/response | Long-lived server-stream (hours/days) |
| Cloudflare compatible | Yes | No (600s hard timeout) |
| DDoS protection | Cloudflare | OVH L3/L4 (transparent scrubbing) |
| Rate limiting | Per-request (existing model) | Bandwidth-based (stick-table `bytes_out_rate`) |
| Client IP detection | CF-Connecting-IP header | TCP source IP (OVH is transparent, real IPs preserved) |

### Proposed Traffic Flow

```
                          ┌──────────────┐
Unary RPCs ──────────────>│  Cloudflare  │──── tunnel ────> HAProxy FE (metered)
(21 methods)              │  (DDoS+CDN)  │                  ├─> Aggregator 1
                          └──────────────┘                  ├─> Aggregator 2
                                                            └─> regional backup

                          ┌──────────────┐
Streaming RPC ───────────>│  OVH DDoS    │── direct ──> HAProxy FE (streaming)
(SubscribeCheckpoints)    │              │                  ├─> Aggregator 1
                          └──────────────┘                  ├─> Aggregator 2

                                    Suiftly gRPC Aggregator
                                    (single Rust process per instance)
                                    ┌─────────────────────────────┐
                                    │ gRPC-Web + native gRPC in   │
                                    │ RAM/NVMe cache (recent data) │
                                    │ Streaming multiplexer        │
                                    └──────────┬──────────────────┘
                                      ├─> local fullnode(s)     [full fields, LAN]
                                      ├─> remote fullnode(s)    [light fields, WAN]
                                      └─> Triton One fallback   [light fields, external]
```

### Suiftly gRPC Aggregator

A single Rust process (tonic + tokio) that sits between HAProxy and Sui fullnodes, handling **both** unary requests (with caching) and streaming (with multiplexing). HAProxy never talks directly to Sui fullnode code.

**Why a dedicated layer:**
- **gRPC-Web guarantee:** Enables `tonic_web::GrpcWebLayer`, ensuring TypeScript SDK (gRPC-Web) and Rust SDK (native gRPC) both work regardless of upstream Sui fullnode configuration.
- **Caching:** The streaming side continuously receives checkpoint data from upstream. This same data pre-populates a RAM + NVMe cache that serves unary requests (`GetCheckpoint`, `GetTransaction`, `GetObject`, etc.) — data is cached **before** a customer even asks for it.
- **Streaming HA:** Aggregates `SubscribeCheckpoints` from multiple upstreams, deduplicates, and fans out to clients.
- **Decoupling:** Upstream Sui releases cannot break customer-facing behavior.

#### Caching (unary acceleration)

The aggregator's streaming side is a continuous feed of the latest blockchain state. This creates a natural **write-ahead cache**:

- **RAM cache:** Last N checkpoints with full contents (transactions, objects, effects). Hot data served with sub-millisecond latency — no fullnode round-trip.
- **NVMe cache:** Larger window of recent data (hours/days). Still much faster than querying the fullnode, which must read from its own RocksDB.
- **Cache-before-ask:** Because the streaming multiplexer already receives every checkpoint, the cache is populated proactively. A `GetCheckpoint` for a recent checkpoint hits RAM, not the fullnode. Same for `GetTransaction` and `GetObject` for objects touched in recent checkpoints.
- **Cache miss:** Falls through to upstream fullnode via native gRPC. Transparent to the client.

This is a significant performance advantage over competitors who simply proxy to fullnodes — recent data (the most commonly requested) is served from memory.

#### Streaming multiplexer

Aggregates `SubscribeCheckpoints` from multiple upstream gRPC fullnodes and serves a merged, deduplicated stream to clients.

**Why:** Direct proxying of `SubscribeCheckpoints` to a single backend provides no HA. If that backend stalls or restarts, the client stream dies. The multiplexer connects to N upstreams simultaneously and forwards the **first** checkpoint at each sequence number -- providing both lowest latency and transparent failover.

**How it works:**

1. **Upstream tier (internal):** Maintains persistent `SubscribeCheckpoints` connections to all configured sources. Multiple streams per remote source, tiered by weight (see below). Local fullnodes request all fields (cheap, LAN). If a local source fails, promotes a remote source to full fields (requires reconnect since `read_mask` is set once at stream open).

2. **Deduplication:** Tracks highest forwarded sequence number. First checkpoint at each sequence number wins; duplicates from slower sources are dropped. Trivial because checkpoints have monotonic sequence numbers and are guaranteed gapless per source.

3. **Client tier (fan-out):** Groups connected clients by their requested `read_mask`. Each unique mask combination gets one shared filtered stream derived from the full internal stream. At worst this degrades to one "shared stream" per connection (if every client requests a unique mask). In practice, most clients will use one of a few common patterns.

**Tiered upstream streams for lowest latency:**

A lighter `read_mask` means fewer bytes, which means the checkpoint notification arrives sooner over WAN. On a 1 Gbps link with 17ms ping, transmitting a full ~500 KB checkpoint takes ~12-20 ms, while a 75-byte sentinel arrives in ~8.5 ms (just propagation). This 10+ ms difference matters.

The multiplexer opens multiple streams per remote source, tiered by weight:

| Stream | `read_mask` | Size/checkpoint | Delivery (17ms ping) | Purpose |
|---|---|---|---|---|
| **Sentinel** | `sequence_number,digest` | ~75 B | ~8.5 ms | Fastest "checkpoint N exists" signal |
| **Summary** | + `summary` | ~1.5 KB | ~9 ms | Enough for dashboards |
| **Full** | all fields | ~500 KB | ~12-20 ms | Complete data for indexers |

For local sources (LAN, <1ms), the full stream arrives in <1ms, so it beats the remote sentinel in normal operation. But when local sources go down, the remote sentinel immediately tells the multiplexer "checkpoint N exists" and:
- Clients requesting only `sequence_number,digest` get served **instantly** from the sentinel stream
- Clients requesting `summary` get served as soon as the summary stream arrives (~0.5 ms later)
- Clients requesting full data wait for the full stream (~10 ms more)

Each client gets the fastest possible delivery for their specific mask, even during failover.

**Upstream bandwidth cost (at $0.08/GB, per remote source):**

| Stream tier | Daily bandwidth | Monthly cost |
|---|---|---|
| Sentinel only | ~26 MB | ~$0.06 |
| + Summary | ~500 MB | ~$1.20 |
| + Full | ~100-350 GB | ~$240-840 |

Maintaining 2-3 lightweight streams to each remote source for fast failover detection costs ~$1-2/month total. The full stream is only needed on local sources (free, LAN) or temporarily during failover.

**`read_mask` details (Sui-specific):**
- Set once in `SubscribeCheckpointsRequest`, cannot change mid-stream (server-streaming, not bidirectional)
- Controls which `Checkpoint` fields are included: `sequence_number`, `digest`, `summary`, `signature`, `contents`, `transactions`, `objects`
- When omitted, server returns a minimal default (not all fields) -- clients must explicitly request heavy fields like `transactions` and `objects`
- Bandwidth impact varies dramatically: `sequence_number`+`digest` is tiny; `transactions`+`objects` is the full firehose

**No existing open-source aggregator does this.** Triton One's [Fumarole](https://blog.triton.one/introducing-yellowstone-fumarole/) is the closest prior art (multi-source aggregation for Solana Yellowstone) but the server code is proprietary. The Sui protocol is simpler than Yellowstone.

#### Server-side catch-up (Suiftly extension)

Sui's `SubscribeCheckpoints` only streams from the current tip — no `start_from` field. If a client disconnects and reconnects, it must manually backfill missed checkpoints via unary `GetCheckpoint` calls, then switch to streaming, handling the seam carefully to avoid gaps. Every Sui client must build this logic themselves.

**The Aggregator solves this.** Both streaming and batch unary support a `start_from` sequence number:

- **Streaming:** `SubscribeCheckpoints` with `start_from` — serves historical checkpoints first, then seamlessly transitions to live. One connection, no gap, no client-side backfill logic.
- **Batch unary:** `GetCheckpoints(from, to)` — returns a range of checkpoints in one call.

**Same addressable range for both.** The Aggregator resolves the data source transparently:

| Data age | Source | Latency |
|---|---|---|
| Recent (in RAM cache) | RAM | Sub-millisecond |
| Older (in NVMe cache) | NVMe | ~1 ms |
| Older than cache | Backfill from upstream fullnode via unary `GetCheckpoint` | Fullnode-dependent |

The client doesn't know or care where data comes from. If a client requests `start_from` at a very old checkpoint, the Aggregator resolves older data by issuing unary requests to the backend internally, then streams everything to the client uniformly. The oldest reachable checkpoint is whatever the upstream fullnode has available (`GetServiceInfo.lowest_available_checkpoint`).

**This is a Suiftly-specific protocol extension** — the `start_from` field does not exist in the standard Sui proto. It's a value-add that justifies using a managed service: clients get server-side catch-up without building their own backfill logic. No other Sui gRPC provider offers this today.

**HA and upgrades:** Multiple aggregator instances run behind HAProxy, same as any other HA service in our architecture. HAProxy handles auth, rate limiting, load balancing, and drain/upgrade orchestration.

### Two HAProxy Frontends Per gRPC Service

**Metered Frontend (unary, via Cloudflare):**
```
frontend grpc_metered
    bind localhost:{port} proto h2
    mode http
    timeout client 30s
    # Standard Lua auth + rate limiting pipeline (same as Seal)
    acl has_cf_header hdr_cnt(CF-Connecting-IP) gt 0
    http-request deny unless has_cf_header or is_internal_health
    http-request lua.validate_api_key unless is_internal_health
    # Block streaming on this frontend
    acl is_streaming path_beg /sui.rpc.v2.SubscriptionService/
    http-request deny if is_streaming
    use_backend BE_grpc_aggregator if { nbsrv(BE_grpc_aggregator) gt 0 }
```

**Streaming Frontend (via OVH):**
```
frontend grpc_streaming
    bind {ip}:{port} proto h2
    mode http
    timeout client 3600s
    timeout tunnel 86400s
    # Auth via API key (same Lua pipeline)
    http-request lua.validate_api_key
    # Client IP: real source IP preserved (OVH DDoS is transparent L3/L4)
    # Only allow streaming methods
    acl is_streaming path_beg /sui.rpc.v2.SubscriptionService/
    http-request deny unless is_streaming
    use_backend BE_grpc_aggregator if { nbsrv(BE_grpc_aggregator) gt 0 }

backend BE_grpc_aggregator
    mode http
    balance roundrobin
    timeout server 3600s
    timeout tunnel 86400s
    option httpchk GET /health
    http-check expect string "up"
    server agg1 localhost:{port1} check proto h2
    server agg2 localhost:{port2} check proto h2
```

### Client Configuration

Customers configure two endpoints (SDKs use single URL per client, so two instances needed):
```
grpc-unary.suiftly.io:443   -> Cloudflare (proxied)
grpc-stream.suiftly.io:443  -> OVH DDoS (direct)
```

```typescript
const unaryClient = new SuiGrpcClient({ baseUrl: 'https://grpc-unary.suiftly.io' });
const streamClient = new SuiGrpcClient({ baseUrl: 'https://grpc-stream.suiftly.io' });
```

---

## What Breaks or Needs Attention

### 1. POST retry rule kills gRPC retries
**Current:** `http-request disable-l7-retry if METH_POST` (all gRPC uses POST)
**Impact:** No L7 retries for any gRPC call, even idempotent ones like GetObject
**Fix:** Path-based ACLs for the gRPC frontend:
```
# Allow retries for read-only methods
acl is_read_only path_beg /sui.rpc.v2.LedgerService/
acl is_read_only path_beg /sui.rpc.v2.StateService/
acl is_read_only path_beg /sui.rpc.v2.MovePackageService/
acl is_read_only path_beg /sui.rpc.v2.NameService/
acl is_read_only path_beg /sui.rpc.v2.SignatureVerificationService/
http-request disable-l7-retry unless is_read_only
```
Note: `ExecuteTransaction` and `SimulateTransaction` should NOT be retried by the proxy.

### 2. Cloudflared HTTP/2 origin config
**Current:** `service: http://localhost:{port}` -- HTTP/1.1 to HAProxy
**Fix:** For the gRPC tunnel entry:
```yaml
- hostname: grpc-unary.suiftly.io
  service: h2://localhost:{grpc_metered_port}
  originRequest:
    http2Origin: true
```

### 3. Bandwidth metering (unary and streaming)
- **Both unary and streaming are metered by bandwidth** (per-GB), plus a small per-request fee for unary
- Same rate for all tiers — tiers differ by included allowances, not unit price
- HAProxy logs include `%B` (bytes to client) and `%U` (bytes from client) -- can capture per-stream and per-request
- Stick-table `bytes_out_rate(1s)` tracks bandwidth in real-time for rate limiting
- **Rate limiting for streaming:** Bandwidth caps via stick-tables. No artificial stream-count limits — each stream generates revenue via per-GB billing, so more streams = more revenue
- Billing: bytes transferred per month, single rate across tiers

### 4. Client IP detection on streaming path (no Cloudflare)
- OVH Anti-DDoS is transparent L3/L4 scrubbing (not a reverse proxy) — **real client IPs are preserved** in TCP source address
- No PROXY protocol or X-Forwarded-For needed on the streaming frontend
- The Lua rate limiting pipeline reads client IP from different sources depending on frontend:
  - Metered frontend: `CF-Connecting-IP` (injected by Cloudflare)
  - Streaming frontend: TCP source IP directly (`src` in HAProxy)
- Both frontends can normalize to a common variable early in the pipeline

### 5. Stream interruption handled by aggregator
- Upstream backend failures are transparent to clients -- the aggregator continues serving from remaining sources
- If the aggregator itself restarts (upgrade, crash), the client stream terminates and client must reconnect
- This is expected gRPC behavior -- Sui docs explicitly document client-side reconnection as the recovery pattern
- Client reconnects with `start_from` set to last received `cursor` (checkpoint sequence number) -- the Aggregator handles backfill transparently

### 6. Rust SDK 5-second keep-alive pings
- Rust SDK sends HTTP/2 PING frames every 5 seconds
- HAProxy handles HTTP/2 PING at the protocol level (responds automatically)
- Not a problem, but the `timeout client` must be longer than the ping interval (it is: 30s >> 5s)
- On the streaming frontend, the keep-alive actually helps: it prevents the connection from appearing idle

---

## Industry Pricing Models for gRPC

How blockchain infra providers charge for gRPC (researched 2026-04-08):

| Provider | Model | Streaming Gate | Price Point |
|----------|-------|----------------|-------------|
| **Triton One** | Bandwidth | $/GB | $0.08/GB streaming + $10/M queries (unary) |
| **Alchemy** | Bandwidth | $/GB | ~$0.08/GB (Yellowstone gRPC) |
| **Helius** | Credits per MB | Credit burn | ~$0.15/GB via credits, ~$0.06-0.08/GB with bulk add-ons |
| **QuickNode** | Credits per MB | Credits + stream count | 10 credits/0.1MB; 1-100 active streams by tier |
| **Chainstack** | Per-stream flat fee | Stream count | $49/mo (1 stream) to $449/mo (25 streams) |
| **Shyft** | Flat rate unlimited | Connection count | $199-$649/mo; 10-50 connections; $100/10 extra |

**Industry convergence:** Bandwidth at **$0.08-$0.15/GB** is the dominant streaming model. Connection/stream count limits are the secondary gate.

**Suiftly pricing approach (proposed):**

Design principles:
- **Single rate for all tiers.** Same \$/request and \$/GB whether Starter or Pro. Rates reflect real cost + fair margin. Tiers differ by included allowances and features, never by unit price — we don't overcharge smaller customers for the same cost.
- **Hybrid metering:** Small per-request fee (covers compute baseline) + per-GB bandwidth fee (covers data transfer). Applies to both unary and streaming.
- **Below-market bandwidth rate.** Industry converges at $0.08/GB. Pricing at **~$0.06/GB** undercuts competitors and delays the self-hosting breakeven point (estimated at ~$300-500/mo, where a customer would consider running their own fullnode at €150-400/mo server + DevOps costs).

Proposed rates (all tiers, all protocols — gRPC, GraphQL, REST):
- **Per request:** ~$0.50/M requests (does not apply to streaming)
- **Per GB:** ~$0.06/GB bandwidth (requests and streaming)

Tier differentiation (features, not rates or allowances):
- **No free allowances.** Pay-as-you-go from the first request/byte. Allowances invite multi-account abuse.
- **Starter ($2/mo):** Single region. Basic rate limits. Full access to all APIs including streaming.
- **Pro ($39/mo):** Multi-region, reserved rate + burstable, advanced metrics, priority support.

Revenue examples at $0.06/GB (realistic customer range):

| Customer profile | Monthly bandwidth | Revenue |
|---|---|---|
| Dashboard/app (1 req/s) | ~5 GB | ~$1.60 (requests + BW) |
| Bot/trader (100 req/s) | ~1.3 TB | ~$208 (requests + BW) |
| Checkpoint listener (summary stream) | ~15 GB | ~$0.90 (BW only) |
| Checkpoint indexer (full firehose) | ~5.2 TB | ~$310 (BW only) |

Most customers land in $2-210/mo. Full firehose customers hit ~$310/mo — still below the self-hosting breakeven, keeping them on the platform. Above ~$300-500/mo, customers with DevOps capability will evaluate self-hosting, which is expected and healthy.

---

## Why HAProxy (Not Envoy/NGINX/Kong)

We evaluated alternatives. HAProxy remains the right choice for Suiftly's gRPC needs.

| Feature | HAProxy 3.x | Envoy | NGINX | Kong | Traefik |
|---------|-------------|-------|-------|------|---------|
| Per-stream/RPC LB | **Yes** | **Yes** | **No** | **No** | **No** |
| Lua scripting | **Yes** (5.3+) | Yes (LuaJIT, limited) | Via OpenResty | Yes | No |
| Request rate limit | **Stick tables** | External svc (Redis) | limit_req | Plugin | Middleware |
| Bandwidth rate limit | **bytes_out_rate** | No built-in | No | No | No |
| gRPC health check | No (use HTTP) | **Yes** (native) | No | No | No |
| Runtime reconfig | Map files/socket | **xDS** (superior) | Reload | Admin API | Auto-discovery |
| Performance | **50K+ RPS, ~50MB** | 35K+, ~150MB | 40K+, ~80MB | 25-35K | Lower |

**Key reasons to stay with HAProxy:**
1. **Per-stream LB** -- NGINX, Kong, and Traefik route all HTTP/2 streams on a connection to the same backend. Dealbreaker for gRPC load distribution. Only HAProxy and Envoy demux individual RPCs.
2. **Stick tables with `bytes_out_rate`** -- No other proxy has built-in per-key bandwidth rate limiting. Envoy requires an external Redis-backed rate limit service. HAProxy does it in-process with ~0 latency.
3. **Existing infrastructure** -- Migrating Lua auth, map files, stick-table configs, and the entire `cfg_mgr_haservice.py` generator to Envoy would be significant work for marginal benefit.
4. **What HAProxy lacks vs Envoy:** Native gRPC health checks (workaround: HTTP `/health` endpoint on backends -- standard practice) and xDS dynamic config (workaround: map file reloading via admin socket -- already implemented).

---

## Architecture Options Comparison (Updated)

| | Option A: HAProxy HTTP/2 (split-route) | Option B: HAProxy TCP | Option C: Envoy alongside |
|---|---|---|---|
| Auth/rate-limiting | **Preserved** | Lost (rebuild in app) | Must replicate |
| Unary (21 methods) | Works via Cloudflare | Works | Works |
| Server-streaming (1 method) | Works via OVH proxy | Works | Works |
| Per-RPC LB | **Works** | Lost | Works |
| Operational cost | **Low-moderate** (2 frontends) | Low + major app work | High (two proxy systems) |
| Metering/logging | **Preserved** + bandwidth for streams | Lost | Must replicate |
| DDoS protection | Cloudflare (unary) + OVH (streaming) | Must handle separately | Depends on setup |

**Option A (split-route) is recommended.** It preserves all existing infrastructure, cleanly separates concerns, and uses the right DDoS protection for each traffic pattern.

---

## Decisions Made

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-08 | Document created | Initial feasibility analysis |
| 2026-04-08 | Confirmed: Sui has 21 unary + 1 server-streaming, no bidi | Eliminates hardest Cloudflare constraint |
| 2026-04-08 | Split-route: unary via Cloudflare, streaming via OVH proxy | Cloudflare 100s timeout kills long-lived streams; OVH provides DDoS protection for streaming path |
| 2026-04-08 | gRPC clients not under our control | Must support standard gRPC protocol, not just gRPC-Web |
| 2026-04-08 | Streaming metering: bandwidth-based | Per-request counting meaningless for `SubscribeCheckpoints`; track bytes transferred per customer |
| 2026-04-08 | GraphQL NOT deprecated | Both gRPC and GraphQL RPC are complementary replacements for JSON-RPC; GraphQL is unary (HTTP POST) and needs no special proxy handling |
| 2026-04-08 | Cloudflare has hard 10-min limit on gRPC streams | `RST_STREAM` after 600s regardless of activity; streaming must bypass Cloudflare |
| 2026-04-08 | Native Sui `SubscribeCheckpoints` is a pure firehose | No start-from in Sui proto (Aggregator adds `start_from` extension); `read_mask` set once at open; ~4 checkpoints/sec |
| 2026-04-09 | Suiftly gRPC Aggregator between HAProxy and fullnodes | Single Rust process handles gRPC-Web, caching, and streaming multiplexing; HAProxy never talks directly to Sui code |
| 2026-04-09 | RAM/NVMe cache fed by streaming data | Checkpoint stream pre-populates cache for unary requests before customers ask; significant latency advantage |
| 2026-04-09 | Aggregator instances behind HAProxy | Same HA pattern as other services; HAProxy handles auth, LB, drain/upgrade |
| 2026-04-09 | Server-side catch-up via `start_from` extension | Both streaming and batch unary; same addressable range; backfills from fullnode for data older than cache |
| 2026-04-09 | Customer docs: URL + API key only, no wrapper SDK | Both Sui SDKs (TS and Rust) natively support custom headers for API key auth |
| 2026-04-09 | OVH: no connection timeouts, L3/L4 DDoS only | Confirmed by observation of multi-day TCP connections; real client IPs preserved |
| 2026-04-09 | Sui fullnode has built-in health endpoints | Both gRPC Health Check and HTTP `GET /health` on same port; no sidecar needed |

