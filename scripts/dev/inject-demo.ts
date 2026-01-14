#!/usr/bin/env tsx
/**
 * Inject demo traffic data for UI testing
 *
 * Creates two types of data:
 *
 * 1. Customer Traffic (configurable hours, default 48h):
 *    - Day/night traffic variation
 *    - Occasional burst periods (exceeding guaranteed limit)
 *    - Response times 50-200ms (correlating with load)
 *    - Response time spread for whisker chart visualization
 *    - Server errors (5xx) and client errors (4xx)
 *
 * 2. Infrastructure Stats (100 days, all services):
 *    - Days 1-30:   RED zone (server errors present)
 *    - Days 31-60:  YELLOW zone (slow >150ms, no server errors)
 *    - Days 61-100: GREEN zone (healthy, fast responses)
 *    Uses repeat field for efficient bulk inserts.
 *
 * Usage:
 *   tsx scripts/dev/inject-demo.ts [wallet-address] [--service seal|grpc|graphql] [--hours N]
 *
 * Examples:
 *   tsx scripts/dev/inject-demo.ts                     # Default: mock wallet, seal, 48 hours
 *   tsx scripts/dev/inject-demo.ts --hours 24          # 24 hours of customer data
 *   tsx scripts/dev/inject-demo.ts --service grpc      # gRPC service for customer data
 *   tsx scripts/dev/inject-demo.ts 0x1234...           # Specific wallet
 */

import { db } from '@suiftly/database';
import { customers } from '@suiftly/database/schema';
import {
  insertMockHAProxyLogs,
  refreshStatsAggregate,
  clearCustomerLogs,
  insertInfraLogs,
  refreshInfraAggregates,
} from '@suiftly/database/stats';
import { forceSyncUsageToDraft } from '@suiftly/database/billing';
import { dbClock } from '@suiftly/shared/db-clock';
import { eq } from 'drizzle-orm';

// Default mock wallet (same as other dev scripts)
const MOCK_WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

// Constants
const MS_PER_HOUR = 60 * 60 * 1000;
const SECONDS_PER_HOUR = 60 * 60;
const GUARANTEED_REQ_PER_SEC = 45; // Pro tier limit
const GUARANTEED_CAP_PER_HOUR = GUARANTEED_REQ_PER_SEC * SECONDS_PER_HOUR; // 162,000

// Service type mapping
const SERVICE_TYPES = {
  seal: 1 as const,
  grpc: 2 as const,
  graphql: 3 as const,
} as const;

// Limits
const DEFAULT_HOURS = 48;
const MIN_HOURS = 1;
const MAX_HOURS = 2400; // 100 days max

// Parse command line arguments
function parseArgs(): {
  walletAddress: string;
  serviceType: 1 | 2 | 3;
  hours: number;
} {
  const args = process.argv.slice(2);
  let walletAddress = MOCK_WALLET;
  let serviceType: 1 | 2 | 3 = 1; // default: seal
  let hours = DEFAULT_HOURS;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--service' && args[i + 1]) {
      const svc = args[i + 1].toLowerCase() as keyof typeof SERVICE_TYPES;
      if (SERVICE_TYPES[svc]) {
        serviceType = SERVICE_TYPES[svc];
      }
      i++;
    } else if (arg === '--hours' && args[i + 1]) {
      const parsed = parseInt(args[i + 1], 10);
      if (isNaN(parsed) || parsed < MIN_HOURS) {
        console.error(`Error: --hours must be at least ${MIN_HOURS}`);
        process.exit(1);
      }
      if (parsed > MAX_HOURS) {
        console.error(`Error: --hours cannot exceed ${MAX_HOURS} (100 days)`);
        process.exit(1);
      }
      hours = parsed;
      i++;
    } else if (arg.startsWith('0x')) {
      walletAddress = arg;
    }
  }

  return { walletAddress, serviceType, hours };
}

interface HourPattern {
  hour: number;
  reqPerSec: number;
  responseTimeMs: number;
  spread: number;  // Response time spread for whisker chart (min = rt - spread, max = rt + spread)
  clientErrors: number;
  serverErrors: number;
}

/** Generate realistic traffic pattern for a 24-hour period */
function generateDayPattern(dayOffset: number): HourPattern[] {
  // Base pattern for each hour (0-23)
  // Traffic is lower at night, peaks during business hours
  // spread: response time variation for whisker chart (tighter at night, wider during peaks)
  const basePattern = [
    // Night (0-6): Low traffic, tight response times
    { hour: 0, base: 25, rt: 55, spread: 20 },
    { hour: 1, base: 20, rt: 50, spread: 15 },
    { hour: 2, base: 15, rt: 50, spread: 12 },
    { hour: 3, base: 12, rt: 50, spread: 10 },
    { hour: 4, base: 15, rt: 52, spread: 12 },
    { hour: 5, base: 22, rt: 58, spread: 18 },
    { hour: 6, base: 32, rt: 75, spread: 30 },
    // Morning ramp-up (7-11): Widening spread
    { hour: 7, base: 40, rt: 95, spread: 45 },
    { hour: 8, base: 48, rt: 120, spread: 60 },
    { hour: 9, base: 55, rt: 145, spread: 80 },
    { hour: 10, base: 58, rt: 165, spread: 100 },
    { hour: 11, base: 52, rt: 155, spread: 90 },
    // Midday peak (12-16): High variance
    { hour: 12, base: 60, rt: 180, spread: 120 },
    { hour: 13, base: 58, rt: 175, spread: 110 },
    { hour: 14, base: 62, rt: 195, spread: 150 },
    { hour: 15, base: 56, rt: 165, spread: 100 },
    { hour: 16, base: 50, rt: 145, spread: 80 },
    // Evening decline (17-20)
    { hour: 17, base: 45, rt: 125, spread: 60 },
    { hour: 18, base: 40, rt: 105, spread: 45 },
    { hour: 19, base: 36, rt: 90, spread: 35 },
    { hour: 20, base: 32, rt: 80, spread: 30 },
    // Late night (21-23)
    { hour: 21, base: 28, rt: 70, spread: 25 },
    { hour: 22, base: 26, rt: 65, spread: 22 },
    { hour: 23, base: 24, rt: 60, spread: 20 },
  ];

  // Jitter function: ±10% variation
  const jitter = (value: number, pct = 0.1) => {
    const variation = 1 - pct + Math.random() * pct * 2;
    return Math.round(value * variation);
  };

  // Day 1 vs Day 2 variation (slightly different patterns)
  const dayMultiplier = dayOffset === 0 ? 1.0 : 0.92 + Math.random() * 0.16; // Day 2: ±8% variation

  // Burst periods: simulate traffic spikes at specific hours
  // Day 1: burst at hours 10 and 14
  // Day 2: burst at hour 12
  const burstHours = dayOffset === 0 ? [10, 14] : [12];

  return basePattern.map((p) => {
    const isBurstPeriod = burstHours.includes(p.hour);
    const burstMultiplier = isBurstPeriod ? 1.4 + Math.random() * 0.3 : 1.0; // 40-70% spike

    const reqPerSec = jitter(Math.round(p.base * dayMultiplier * burstMultiplier));
    const responseTimeMs = jitter(
      Math.round(p.rt * (isBurstPeriod ? 1.15 : 1.0)), // Burst periods are 15% slower
      0.08
    );
    // Spread is wider during burst periods
    const spread = jitter(Math.round(p.spread * (isBurstPeriod ? 1.5 : 1.0)), 0.1);

    // Client errors: scattered throughout, more during peak hours
    let clientErrors = 0;
    if (p.hour >= 8 && p.hour <= 18) {
      // Business hours: 20% chance of 1-2 client errors
      if (Math.random() < 0.2) {
        clientErrors = Math.random() < 0.5 ? 1 : 2;
      }
    }

    // Server errors: rare, but we need at least 1 total
    // Place one on day 1 hour 14 (peak hour)
    let serverErrors = 0;
    if (dayOffset === 0 && p.hour === 14) {
      serverErrors = 1;
    }

    return {
      hour: p.hour,
      reqPerSec,
      responseTimeMs: Math.min(200, Math.max(50, responseTimeMs)), // Clamp to 50-200ms
      spread: Math.max(10, spread), // Minimum spread of 10ms
      clientErrors,
      serverErrors,
    };
  });
}

async function injectDemoData() {
  const { walletAddress, serviceType, hours } = parseArgs();

  console.log('');
  console.log('='.repeat(60));
  console.log('  Demo Data Injection');
  console.log('='.repeat(60));
  console.log(`  Wallet:      ${walletAddress}`);
  console.log(`  Service:     ${Object.entries(SERVICE_TYPES).find(([, v]) => v === serviceType)?.[0]}`);
  console.log(`  Duration:    ${hours} hours`);
  console.log('='.repeat(60));
  console.log('');

  // Safety check: don't run in production
  if (process.env.NODE_ENV === 'production') {
    console.error('ERROR: Cannot inject demo data in production');
    process.exit(1);
  }

  // Find customer
  const customer = await db.query.customers.findFirst({
    where: eq(customers.walletAddress, walletAddress),
  });

  if (!customer) {
    console.error(`Customer not found: ${walletAddress}`);
    console.log('Hint: Customer is created on first login');
    process.exit(1);
  }

  console.log(`Found customer ID: ${customer.customerId}`);

  // Clear existing logs for this customer
  console.log('Clearing existing demo data...');
  await clearCustomerLogs(db, customer.customerId, serviceType);

  const now = new Date();
  const baseOptions = {
    serviceType,
    network: 1 as const, // mainnet
  };

  let totalRequests = 0;
  let totalGuaranteed = 0;
  let totalBurst = 0;
  let totalClientErrors = 0;
  let totalServerErrors = 0;

  console.log('Generating traffic data...');

  // Pre-generate day patterns (cache by daysAgo to avoid regenerating)
  const dayPatterns = new Map<number, HourPattern[]>();
  const getPattern = (daysAgo: number, hourOfDay: number): HourPattern => {
    if (!dayPatterns.has(daysAgo)) {
      dayPatterns.set(daysAgo, generateDayPattern(daysAgo));
    }
    return dayPatterns.get(daysAgo)![hourOfDay];
  };

  // Generate data using a single linear loop - timestamp drives the pattern selection
  // This ensures the pattern hour matches the actual wall-clock hour of the data
  for (let hoursAgo = hours; hoursAgo >= 1; hoursAgo--) {
    const timestamp = new Date(now.getTime() - hoursAgo * MS_PER_HOUR);
    const hourOfDay = timestamp.getHours();
    const daysAgo = Math.floor((hoursAgo - 1) / 24); // 0 = most recent day

    const pattern = getPattern(daysAgo, hourOfDay);

    // Calculate total requests for this hour
    const totalReqThisHour = pattern.reqPerSec * SECONDS_PER_HOUR;

    // Split into guaranteed vs burst based on cap
    const guaranteed = Math.min(totalReqThisHour, GUARANTEED_CAP_PER_HOUR);
    const burst = Math.max(0, totalReqThisHour - GUARANTEED_CAP_PER_HOUR);

    // Calculate response time distribution for whisker chart (5 values: min, below-avg, avg, above-avg, max)
    const baseRt = pattern.responseTimeMs;
    const spread = pattern.spread;
    const responseTimes = [
      Math.max(20, baseRt - spread),           // min
      Math.max(25, baseRt - spread * 0.4),     // below avg
      baseRt,                                   // avg
      baseRt + spread * 0.4,                   // above avg
      baseRt + spread,                         // max
    ];

    // Insert guaranteed traffic distributed across 5 logs with different response times
    if (guaranteed > 0) {
      const perLog = Math.floor(guaranteed / 5);
      const remainder = guaranteed - perLog * 5;

      for (let i = 0; i < 5; i++) {
        const count = perLog + (i === 2 ? remainder : 0); // Give remainder to middle (avg) log
        if (count > 0) {
          await insertMockHAProxyLogs(db, customer.customerId, {
            ...baseOptions,
            count: 1,
            repeat: count,
            trafficType: 1, // guaranteed
            statusCode: 200,
            responseTimeMs: Math.round(responseTimes[i]),
            timestamp: new Date(timestamp.getTime() + i), // Offset by milliseconds
          });
        }
      }
      totalGuaranteed += guaranteed;
      totalRequests += guaranteed;
    }

    // Insert burst traffic distributed across 3 logs with different response times
    // Burst traffic is slightly slower than guaranteed
    if (burst > 0) {
      const burstRts = [baseRt + 30, baseRt + 50, baseRt + 80];
      const perLog = Math.floor(burst / 3);
      const remainder = burst - perLog * 3;

      for (let i = 0; i < 3; i++) {
        const count = perLog + (i === 1 ? remainder : 0);
        if (count > 0) {
          await insertMockHAProxyLogs(db, customer.customerId, {
            ...baseOptions,
            count: 1,
            repeat: count,
            trafficType: 2, // burst
            statusCode: 200,
            responseTimeMs: burstRts[i],
            timestamp: new Date(timestamp.getTime() + 1000 + i), // 1 second offset from guaranteed
          });
        }
      }
      totalBurst += burst;
      totalRequests += burst;
    }

    // Insert client errors (400)
    if (pattern.clientErrors > 0) {
      await insertMockHAProxyLogs(db, customer.customerId, {
        ...baseOptions,
        count: 1,
        repeat: pattern.clientErrors,
        trafficType: 1,
        statusCode: 400,
        responseTimeMs: 55, // Errors are fast
        timestamp: new Date(timestamp.getTime() + 2000),
      });
      totalClientErrors += pattern.clientErrors;
      totalRequests += pattern.clientErrors;
    }

    // Insert server errors (500)
    if (pattern.serverErrors > 0) {
      await insertMockHAProxyLogs(db, customer.customerId, {
        ...baseOptions,
        count: 1,
        repeat: pattern.serverErrors,
        trafficType: 1,
        statusCode: 500,
        responseTimeMs: 150, // Server errors take time
        timestamp: new Date(timestamp.getTime() + 3000),
      });
      totalServerErrors += pattern.serverErrors;
      totalRequests += pattern.serverErrors;
    }
  }

  console.log(`  Generated ${hours} hours of data`);

  // Ensure minimum required errors for UI testing
  const MIN_CLIENT_ERRORS = 6;
  const MIN_SERVER_ERRORS = 1;

  if (totalClientErrors < MIN_CLIENT_ERRORS) {
    const needed = MIN_CLIENT_ERRORS - totalClientErrors;
    for (let i = 0; i < needed; i++) {
      const hoursAgo = 4 + i * 6; // Spread them out
      const timestamp = new Date(now.getTime() - hoursAgo * MS_PER_HOUR);
      await insertMockHAProxyLogs(db, customer.customerId, {
        ...baseOptions,
        count: 1,
        repeat: 1,
        trafficType: 1,
        statusCode: 400,
        responseTimeMs: 50,
        timestamp,
      });
      totalClientErrors++;
      totalRequests++;
    }
    console.log(`  Added ${needed} extra client errors`);
  }

  if (totalServerErrors < MIN_SERVER_ERRORS) {
    const timestamp = new Date(now.getTime() - 12 * MS_PER_HOUR);
    await insertMockHAProxyLogs(db, customer.customerId, {
      ...baseOptions,
      count: 1,
      repeat: 1,
      trafficType: 1,
      statusCode: 500,
      responseTimeMs: 150,
      timestamp,
    });
    totalServerErrors++;
    totalRequests++;
    console.log('  Added 1 server error');
  }

  // Refresh the TimescaleDB aggregate
  console.log('Refreshing stats aggregate...');
  await refreshStatsAggregate(db);

  // Sync usage to DRAFT invoice
  console.log('Syncing usage to billing...');
  try {
    await forceSyncUsageToDraft(db, customer.customerId, dbClock);
  } catch (err) {
    // Expected: customer might not have a draft invoice or active service
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('No DRAFT invoice') || msg.includes('No active service')) {
      console.log('  (Skipped billing sync - no draft invoice or service)');
    } else {
      // Unexpected error - log but don't fail the script
      console.error('  Warning: Billing sync failed:', msg);
    }
  }

  // =========================================================================
  // Infrastructure Stats Data (for InfraStats page)
  // 100 days of data with color pattern:
  // - Days 1-30 (recent): errors → red status bars
  // - Days 31-60: slow (>150ms) but no server errors → yellow status bars
  // - Days 61-100: healthy and fast → green status bars
  // =========================================================================
  console.log('');
  console.log('Injecting infrastructure stats data (100 days)...');

  // Event type definitions for various error categories
  const infraEventTypes = {
    // Auth/Protocol errors (10-17) - client errors
    authMissingKey: 10,
    authFailed: 11,
    malformedRequest: 12,
    // IP/Access errors (20-21) - client errors
    ipBlocked: 20,
    ipRateLimited: 21,
    // Backend errors (50-54) - server errors (user-affecting)
    backend500: 50,
    backend502: 51,
    backend503: 52,
    backend504: 53,
    // Infrastructure errors (60-63) - server errors (user-affecting)
    connectionRefused: 60,
    connectionTimeout: 61,
    noBackendAvailable: 62,
    queueTimeout: 63,
  };

  let totalInfraLogs = 0;
  let totalInfraErrors = 0;
  const INFRA_DAYS = 100;
  const MS_PER_DAY = 24 * MS_PER_HOUR;

  // Inject data for all 3 services
  const allServiceTypes = [1, 2, 3] as const;

  for (const svcType of allServiceTypes) {
    const svcName = svcType === 1 ? 'Seal' : svcType === 2 ? 'RPC' : 'GraphQL';
    console.log(`  Injecting ${svcName} service data...`);

    for (let daysAgo = INFRA_DAYS; daysAgo >= 1; daysAgo--) {
      // Inject one entry per day (at noon) for efficiency
      const timestamp = new Date(now.getTime() - daysAgo * MS_PER_DAY + 12 * MS_PER_HOUR);
      const serverId = ((daysAgo % 3) + 1) as 1 | 2 | 3;
      const backendId = (((daysAgo + 5) % 3) + 1) as 1 | 2 | 3;

      // Determine which zone this day falls into
      // Days 1-30: RED zone (errors)
      // Days 31-60: YELLOW zone (slow but no server errors)
      // Days 61-100: GREEN zone (healthy and fast)

      if (daysAgo <= 30) {
        // RED ZONE: Server errors + current variation pattern
        // Base successful traffic with normal latency
        await insertInfraLogs(db, {
          serviceType: svcType,
          network: 1,
          timestamp,
          eventType: 0, // success
          serverId,
          backendId,
          timeTotal: 80 + Math.floor(Math.random() * 40), // 80-120ms
          repeat: 10000, // 10k requests per day
          customerId: customer.customerId,
        });
        totalInfraLogs += 10000;

        // Add server errors (backend + infra) - these cause RED
        const serverErrors = [
          // Backend errors (50-54)
          infraEventTypes.backend502,
          infraEventTypes.backend503,
          infraEventTypes.backend504,
          // Infrastructure errors (60-63)
          infraEventTypes.connectionRefused,
          infraEventTypes.connectionTimeout,
          infraEventTypes.noBackendAvailable,
          infraEventTypes.queueTimeout,
        ];
        const serverError = serverErrors[daysAgo % serverErrors.length];
        await insertInfraLogs(db, {
          serviceType: svcType,
          network: 1,
          timestamp: new Date(timestamp.getTime() + 1000),
          eventType: serverError,
          serverId,
          backendId: serverError >= 60 ? 0 : backendId,
          timeTotal: serverError === infraEventTypes.connectionTimeout ? 30000 : 5000,
          repeat: 1 + (daysAgo % 5), // 1-5 errors per day
          customerId: customer.customerId,
        });
        totalInfraErrors += 1 + (daysAgo % 5);
        totalInfraLogs += 1 + (daysAgo % 5);

        // Also add some client errors (these don't cause RED, but show in client bar)
        if (daysAgo % 3 === 0) {
          await insertInfraLogs(db, {
            serviceType: svcType,
            network: 1,
            timestamp: new Date(timestamp.getTime() + 2000),
            eventType: infraEventTypes.authMissingKey,
            serverId,
            backendId: 0,
            timeTotal: 15,
            repeat: 5 + (daysAgo % 10),
            customerId: null,
          });
          totalInfraLogs += 5 + (daysAgo % 10);
        }

      } else if (daysAgo <= 60) {
        // YELLOW ZONE: Slow responses (>150ms) but NO server errors
        // Degraded traffic with high latency
        await insertInfraLogs(db, {
          serviceType: svcType,
          network: 1,
          timestamp,
          eventType: 0, // success
          serverId,
          backendId,
          timeTotal: 180 + Math.floor(Math.random() * 100), // 180-280ms (above 150ms threshold)
          repeat: 10000,
          customerId: customer.customerId,
        });
        totalInfraLogs += 10000;

        // Add some client errors (these don't affect server status bar)
        if (daysAgo % 4 === 0) {
          await insertInfraLogs(db, {
            serviceType: svcType,
            network: 1,
            timestamp: new Date(timestamp.getTime() + 1000),
            eventType: infraEventTypes.ipRateLimited,
            serverId,
            backendId: 0,
            timeTotal: 10,
            repeat: 3 + (daysAgo % 7),
            customerId: null,
          });
          totalInfraLogs += 3 + (daysAgo % 7);
        }

      } else {
        // GREEN ZONE: Healthy and fast (no errors, <150ms)
        await insertInfraLogs(db, {
          serviceType: svcType,
          network: 1,
          timestamp,
          eventType: 0, // success
          serverId,
          backendId,
          timeTotal: 50 + Math.floor(Math.random() * 50), // 50-100ms (well under 150ms)
          repeat: 10000,
          customerId: customer.customerId,
        });
        totalInfraLogs += 10000;
      }
    }
  }

  // Add guaranteed recent errors for demo visibility (in the RED zone)
  // These are added to ALL services (not just the one from command line)
  console.log('  Adding guaranteed errors for demo visibility...');
  const guaranteedErrors = [
    // Backend errors (server errors)
    { eventType: infraEventTypes.backend502, count: 5, label: 'Backend 502' },
    { eventType: infraEventTypes.backend504, count: 3, label: 'Backend 504' },
    // Infrastructure errors (server errors)
    { eventType: infraEventTypes.connectionRefused, count: 2, label: 'Connection Refused' },
    { eventType: infraEventTypes.connectionTimeout, count: 2, label: 'Connection Timeout' },
    { eventType: infraEventTypes.noBackendAvailable, count: 3, label: 'No Backend Available' },
    { eventType: infraEventTypes.queueTimeout, count: 2, label: 'Queue Timeout' },
    // Client errors
    { eventType: infraEventTypes.authMissingKey, count: 8, label: 'Missing API Key' },
    { eventType: infraEventTypes.ipRateLimited, count: 10, label: 'IP Rate Limited' },
  ];

  for (const error of guaranteedErrors) {
    for (const svcType of allServiceTypes) {
      for (let i = 0; i < error.count; i++) {
        // First instance of each error type goes in the last 24h for demo visibility
        // Rest are distributed in the RED zone (last 30 days)
        let timestamp: Date;
        if (i === 0) {
          // Place in last 24 hours (1-23 hours ago)
          const hoursAgo = 1 + Math.floor(Math.random() * 22);
          timestamp = new Date(now.getTime() - hoursAgo * MS_PER_HOUR);
        } else {
          // Place in the rest of the RED zone (1-29 days ago)
          const daysAgo = 1 + Math.floor(Math.random() * 28);
          timestamp = new Date(now.getTime() - daysAgo * MS_PER_DAY);
        }
        await insertInfraLogs(db, {
          serviceType: svcType,
          network: 1,
          timestamp,
          eventType: error.eventType,
          serverId: ((i % 3) + 1) as 1 | 2 | 3,
          backendId: error.eventType >= 50 ? ((i % 3) + 1) as 1 | 2 | 3 : 0,
          timeTotal: error.eventType === infraEventTypes.connectionTimeout ? 30000 : 100,
          customerId: error.eventType >= 50 ? customer.customerId : null,
        });
      }
    }
    if (error.eventType >= 50) {
      totalInfraErrors += error.count * 3; // 3 services
    }
    totalInfraLogs += error.count * 3; // 3 services
    console.log(`    Added ${error.count} ${error.label} errors (per service)`);
  }

  // Refresh infrastructure aggregates
  console.log('Refreshing infrastructure aggregates...');
  await refreshInfraAggregates(db);

  console.log('');
  console.log('='.repeat(60));
  console.log('  Demo Data Injected Successfully');
  console.log('='.repeat(60));
  console.log(`  Customer traffic (${hours}h):`);
  console.log(`    Total requests:   ${totalRequests.toLocaleString()}`);
  console.log(`    - Guaranteed:     ${totalGuaranteed.toLocaleString()}`);
  console.log(`    - Burst:          ${totalBurst.toLocaleString()}`);
  console.log(`    - Client errors:  ${totalClientErrors}`);
  console.log(`    - Server errors:  ${totalServerErrors}`);
  console.log(`  Infrastructure (100 days, all services):`);
  console.log(`    Total logs:       ${totalInfraLogs.toLocaleString()}`);
  console.log(`    Server errors:    ${totalInfraErrors}`);
  console.log(`    Days 1-30:        RED (errors)`);
  console.log(`    Days 31-60:       YELLOW (slow >150ms)`);
  console.log(`    Days 61-100:      GREEN (healthy)`);
  console.log('='.repeat(60));
  console.log('');

  process.exit(0);
}

injectDemoData().catch((error) => {
  console.error('ERROR:', error);
  process.exit(1);
});
