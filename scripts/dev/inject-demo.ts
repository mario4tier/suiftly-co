#!/usr/bin/env tsx
/**
 * Inject demo traffic data for UI testing
 *
 * Creates ~48 hours of realistic HAProxy log data with:
 * - Day/night traffic variation
 * - Occasional burst periods (exceeding guaranteed limit)
 * - Response times 50-200ms (correlating with load)
 * - Response time spread for whisker chart visualization (min/avg/max per hour)
 * - Server errors (5xx) and client errors (4xx)
 *
 * For whisker chart support, each hour inserts 5 logs for guaranteed traffic
 * and 3 logs for burst traffic, each with different response times to create
 * realistic min/max spread while maintaining correct weighted averages.
 *
 * Usage:
 *   tsx scripts/dev/inject-demo.ts [wallet-address] [--service seal|grpc|graphql] [--hours N]
 *
 * Examples:
 *   tsx scripts/dev/inject-demo.ts                     # Default: mock wallet, seal, 48 hours
 *   tsx scripts/dev/inject-demo.ts --hours 24          # 24 hours of data
 *   tsx scripts/dev/inject-demo.ts --service grpc      # gRPC service
 *   tsx scripts/dev/inject-demo.ts 0x1234...           # Specific wallet
 */

import { db } from '@suiftly/database';
import { customers } from '@suiftly/database/schema';
import {
  insertMockHAProxyLogs,
  refreshStatsAggregate,
  clearCustomerLogs,
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
const MAX_HOURS = 168; // 1 week max

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
        console.error(`Error: --hours cannot exceed ${MAX_HOURS} (1 week)`);
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

  console.log('');
  console.log('='.repeat(60));
  console.log('  Demo Data Injected Successfully');
  console.log('='.repeat(60));
  console.log(`  Total requests:   ${totalRequests.toLocaleString()}`);
  console.log(`  - Guaranteed:     ${totalGuaranteed.toLocaleString()}`);
  console.log(`  - Burst:          ${totalBurst.toLocaleString()}`);
  console.log(`  - Client errors:  ${totalClientErrors}`);
  console.log(`  - Server errors:  ${totalServerErrors}`);
  console.log(`  Hours of data:    ${hours}`);
  console.log('='.repeat(60));
  console.log('');

  process.exit(0);
}

injectDemoData().catch((error) => {
  console.error('ERROR:', error);
  process.exit(1);
});
