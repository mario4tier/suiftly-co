// Global Manager (gm) - Centralized control plane for Suiftly infrastructure
//
// Environment variables:
//   GM_PORT - Server port (default: 22600)
//   GM_HOST - Server host (default: 0.0.0.0)
// Deployment type from /etc/walrus/system.conf (DEPLOYMENT_TYPE=test|production)

import Fastify from 'fastify';
import { z } from 'zod';
import { db, adminNotifications } from '@suiftly/database';
import { getMockClockState, setMockClockState } from '@suiftly/database/test-kv';
import { desc, eq } from 'drizzle-orm';
import { isTestDeployment } from './config/lm-config.js';
import {
  queueSyncCustomer,
  queueSyncCustomerSync,
  queueSyncAll,
  queueSyncAllSync,
  getQueueStats,
  getPendingTasks,
  startPeriodicSync,
  stopPeriodicSync,
} from './task-queue.js';

const PORT = parseInt(process.env.GM_PORT || '22600', 10);
const HOST = process.env.GM_HOST || '0.0.0.0';

// ============================================================================
// Zod Schemas
// ============================================================================

// Common schemas
const idParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'ID must be a positive integer').transform(Number),
});

const customerIdParamSchema = z.object({
  customerId: z.string().regex(/^\d+$/, 'Customer ID must be a positive integer').transform(Number),
});

// Notification schemas
const notificationListQuerySchema = z.object({
  acknowledged: z.enum(['true', 'false']).optional(),
  limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().min(1).max(500)).optional(),
});

// Queue schemas
const queueQuerySchema = z.object({
  source: z.enum(['api', 'test', 'manual']).optional().default('api'),
  async: z.enum(['true', 'false']).optional(),
});

const syncAllQuerySchema = z.object({
  source: z.enum(['api', 'test', 'manual']).optional().default('manual'),
  async: z.enum(['true', 'false']).optional(),
});

// Test endpoint schemas
const clockMockBodySchema = z.object({
  time: z.union([z.string(), z.number()]).optional(),
  autoAdvance: z.boolean().optional().default(false),
  timeScale: z.number().positive().optional().default(1.0),
});

const clockAdvanceBodySchema = z.object({
  days: z.number().int().optional(),
  hours: z.number().int().optional(),
  minutes: z.number().int().optional(),
  milliseconds: z.number().int().optional(),
});

const testNotificationBodySchema = z.object({
  severity: z.enum(['info', 'warning', 'error']).optional().default('info'),
  category: z.string().min(1).max(100).optional().default('test'),
  code: z.string().min(1).max(100).optional().default('TEST_NOTIFICATION'),
  message: z.string().min(1).max(1000).optional().default('This is a test notification'),
});

// Helper to validate and return parsed result or send error
function validate<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown,
  reply: any
): z.output<T> | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    reply.status(400).send({
      error: 'Validation failed',
      details: result.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
    });
    return null;
  }
  return result.data;
}

const server = Fastify({
  logger: {
    level: isTestDeployment() ? 'debug' : 'info',
  },
});

// Health check endpoint (both paths for direct and proxied access)
const healthResponse = async () => ({
  status: 'up',
  service: 'global-manager',
  timestamp: new Date().toISOString(),
});

server.get('/health', healthResponse);
server.get('/api/health', healthResponse);

// ============================================================================
// Admin Notifications API
// ============================================================================

// List all notifications (most recent first)
server.get('/api/notifications', async (request, reply) => {
  const query = validate(notificationListQuerySchema, request.query, reply);
  if (!query) return;

  const limit = query.limit ?? 100;

  let notifications;
  if (query.acknowledged === 'false') {
    notifications = await db
      .select()
      .from(adminNotifications)
      .where(eq(adminNotifications.acknowledged, false))
      .orderBy(desc(adminNotifications.createdAt))
      .limit(limit);
  } else if (query.acknowledged === 'true') {
    notifications = await db
      .select()
      .from(adminNotifications)
      .where(eq(adminNotifications.acknowledged, true))
      .orderBy(desc(adminNotifications.createdAt))
      .limit(limit);
  } else {
    notifications = await db
      .select()
      .from(adminNotifications)
      .orderBy(desc(adminNotifications.createdAt))
      .limit(limit);
  }

  return {
    notifications: notifications.map((n) => ({
      ...n,
      details: n.details ? JSON.parse(n.details) : null,
    })),
    count: notifications.length,
  };
});

// Get notification counts by severity
server.get('/api/notifications/counts', async () => {
  const notifications = await db
    .select()
    .from(adminNotifications)
    .where(eq(adminNotifications.acknowledged, false));

  const counts = {
    total: notifications.length,
    error: 0,
    warning: 0,
    info: 0,
  };

  for (const n of notifications) {
    if (n.severity === 'error') counts.error++;
    else if (n.severity === 'warning') counts.warning++;
    else if (n.severity === 'info') counts.info++;
  }

  return counts;
});

// Acknowledge (dismiss) a notification
server.post('/api/notifications/:id/acknowledge', async (request, reply) => {
  const params = validate(idParamSchema, request.params, reply);
  if (!params) return;

  const [updated] = await db
    .update(adminNotifications)
    .set({
      acknowledged: true,
      acknowledgedAt: new Date(),
      acknowledgedBy: 'admin', // Could be extended with actual user tracking
    })
    .where(eq(adminNotifications.notificationId, params.id))
    .returning();

  if (!updated) {
    return reply.status(404).send({ error: 'Notification not found' });
  }

  return { success: true, notification: updated };
});

// Acknowledge all unacknowledged notifications
server.post('/api/notifications/acknowledge-all', async () => {
  const result = await db
    .update(adminNotifications)
    .set({
      acknowledged: true,
      acknowledgedAt: new Date(),
      acknowledgedBy: 'admin',
    })
    .where(eq(adminNotifications.acknowledged, false))
    .returning({ notificationId: adminNotifications.notificationId });

  return { success: true, acknowledgedCount: result.length };
});

// Delete a notification permanently
server.delete('/api/notifications/:id', async (request, reply) => {
  const params = validate(idParamSchema, request.params, reply);
  if (!params) return;

  const [deleted] = await db
    .delete(adminNotifications)
    .where(eq(adminNotifications.notificationId, params.id))
    .returning();

  if (!deleted) {
    return reply.status(404).send({ error: 'Notification not found' });
  }

  return { success: true };
});

// Delete all acknowledged notifications
server.delete('/api/notifications/acknowledged', async () => {
  const result = await db
    .delete(adminNotifications)
    .where(eq(adminNotifications.acknowledged, true))
    .returning({ notificationId: adminNotifications.notificationId });

  return { success: true, deletedCount: result.length };
});

// ============================================================================
// Task Queue API
// ============================================================================

// Queue a sync for a specific customer (called by API server after deposit, etc.)
// Default: waits for completion (synchronous)
// Use ?async=true to return immediately without waiting
server.post('/api/queue/sync-customer/:customerId', async (request, reply) => {
  const params = validate(customerIdParamSchema, request.params, reply);
  if (!params) return;

  const query = validate(queueQuerySchema, request.query, reply);
  if (!query) return;

  const runAsync = query.async === 'true';

  let task;
  if (runAsync) {
    // Async mode - return immediately (for production API server calls)
    task = queueSyncCustomer(params.customerId, query.source);
    if (task) {
      return { success: true, queued: true, taskId: task.id };
    } else {
      return { success: true, queued: false, reason: 'deduplicated' };
    }
  } else {
    // Synchronous mode (default) - wait for completion
    task = await queueSyncCustomerSync(params.customerId, query.source);
    return { success: true, queued: !!task, completed: true, taskId: task?.id };
  }
});

// Queue a sync-all (on-demand trigger)
// Default: waits for completion (synchronous)
// Use ?async=true to return immediately without waiting
server.post('/api/queue/sync-all', async (request, reply) => {
  const query = validate(syncAllQuerySchema, request.query, reply);
  if (!query) return;

  const runAsync = query.async === 'true';

  let task;
  if (runAsync) {
    // Async mode - return immediately (for periodic timer)
    task = queueSyncAll(query.source);
    if (task) {
      return { success: true, queued: true, taskId: task.id };
    } else {
      return { success: true, queued: false, reason: 'deduplicated' };
    }
  } else {
    // Synchronous mode (default) - wait for completion
    task = await queueSyncAllSync(query.source);
    return { success: true, queued: !!task, completed: true, taskId: task?.id };
  }
});

// Get queue status
server.get('/api/queue/stats', async () => {
  return getQueueStats();
});

// Get pending tasks (for debugging)
server.get('/api/queue/pending', async () => {
  return { tasks: getPendingTasks() };
});

// ============================================================================
// Test Endpoints (development only)
// ============================================================================

if (isTestDeployment()) {
  const { dbClockProvider } = await import('@suiftly/shared/db-clock');

  // Configure test_kv sync for cross-process clock sharing
  dbClockProvider.configureTestKvSync(getMockClockState, setMockClockState);
  dbClockProvider.enableTestKvSync();

  // Clock mock endpoints - GM is the single source of truth
  // Sets local mock clock AND writes to test_kv for other processes
  server.post('/api/test/clock/mock', async (request, reply) => {
    const body = validate(clockMockBodySchema, request.body || {}, reply);
    if (!body) return;

    let mockTime: Date | undefined;
    if (body.time !== undefined) {
      mockTime = typeof body.time === 'string' ? new Date(body.time) : new Date(body.time);
      if (isNaN(mockTime.getTime())) {
        return reply.status(400).send({ error: 'Invalid date/time value' });
      }
    }

    // Set local mock clock AND persist to test_kv
    const mockClock = await dbClockProvider.useMockClockAndSync({
      currentTime: mockTime,
      autoAdvance: body.autoAdvance,
      timeScale: body.timeScale,
    });

    return {
      success: true,
      type: 'mock',
      currentTime: mockClock.now().toISOString(),
      config: {
        autoAdvance: body.autoAdvance,
        timeScale: body.timeScale,
      },
    };
  });

  server.post('/api/test/clock/real', async () => {
    // Reset local clock AND clear test_kv
    await dbClockProvider.useRealClockAndSync();
    return {
      success: true,
      type: 'real',
      currentTime: new Date().toISOString(),
    };
  });

  server.get('/api/test/clock', async () => {
    // Sync from test_kv to ensure we have latest state
    await dbClockProvider.syncFromTestKv();
    const clock = dbClockProvider.getClock();
    const isMock = dbClockProvider.isUsingMockClock();
    return {
      type: isMock ? 'mock' : 'real',
      currentTime: clock.now().toISOString(),
    };
  });

  // Advance mock clock by specific duration
  server.post('/api/test/clock/advance', async (request, reply) => {
    const mockClock = dbClockProvider.getMockClock();
    if (!mockClock) {
      return reply.status(400).send({ error: 'Mock clock not enabled. Use /api/test/clock/mock first.' });
    }

    const body = validate(clockAdvanceBodySchema, request.body || {}, reply);
    if (!body) return;

    // Advance by each specified unit
    if (body.days) {
      mockClock.advanceDays(body.days);
    }
    if (body.hours) {
      mockClock.advanceHours(body.hours);
    }
    if (body.minutes) {
      mockClock.advanceMinutes(body.minutes);
    }
    if (body.milliseconds) {
      mockClock.advance(body.milliseconds);
    }

    // Persist updated time to test_kv
    await dbClockProvider.writeToTestKv();

    return {
      success: true,
      currentTime: mockClock.now().toISOString(),
      advanced: {
        days: body.days ?? 0,
        hours: body.hours ?? 0,
        minutes: body.minutes ?? 0,
        milliseconds: body.milliseconds ?? 0,
      },
    };
  });

  // Create a test notification
  server.post('/api/test/notification', async (request, reply) => {
    const body = validate(testNotificationBodySchema, request.body || {}, reply);
    if (!body) return;

    const [notification] = await db
      .insert(adminNotifications)
      .values({
        severity: body.severity as 'info' | 'warning' | 'error',
        category: body.category,
        code: body.code,
        message: body.message,
        details: JSON.stringify({ createdAt: new Date().toISOString(), test: true }),
      })
      .returning();

    return { success: true, notification };
  });

  // Create sample notifications of each severity
  server.post('/api/test/notifications/samples', async () => {
    const samples = [
      { severity: 'error', category: 'billing', code: 'PAYMENT_FAILED', message: 'Payment processing failed for customer 12345' },
      { severity: 'warning', category: 'system', code: 'HIGH_MEMORY', message: 'Memory usage above 80% threshold' },
      { severity: 'info', category: 'security', code: 'NEW_LOGIN', message: 'New login from IP 192.168.1.100' },
    ];

    const notifications = [];
    for (const sample of samples) {
      const [n] = await db
        .insert(adminNotifications)
        .values({
          ...sample,
          details: JSON.stringify({ timestamp: new Date().toISOString() }),
        })
        .returning();
      notifications.push(n);
    }

    return { success: true, count: notifications.length, notifications };
  });
}

// ============================================================================
// Vault Status API (for Admin Dashboard KVCrypt Debug)
// ============================================================================

// Get vault status from data_tx
server.get('/api/vault/status', async () => {
  const { createVaultReader } = await import('@walrus/vault-codec');

  const reader = createVaultReader({
    storageDir: '/opt/syncf/data_tx',
  });

  // Get status for known vault types
  const vaultTypes = ['sma'] as const; // Add more as implemented: 'smm', 'sms', etc.
  const vaults: Record<string, {
    vaultType: string;
    latest: { seq: number; pg: number; filename: string } | null;
    previous: { seq: number; pg: number; filename: string } | null;
    allVersions: Array<{ seq: number; pg: number; filename: string }>;
  }> = {};

  for (const vaultType of vaultTypes) {
    try {
      const versions = await reader.listVersions(vaultType);
      const latest = versions[0] || null;
      const previous = versions[1] || null;

      vaults[vaultType] = {
        vaultType,
        latest,
        previous,
        allVersions: versions.slice(0, 10), // Limit to 10 versions
      };
    } catch {
      vaults[vaultType] = {
        vaultType,
        latest: null,
        previous: null,
        allVersions: [],
      };
    }
  }

  return { vaults };
});

// Get Local Manager statuses (live polling)
server.get('/api/lm/status', async () => {
  // Poll LM directly for live status
  interface LMStatus {
    name: string;
    host: string;
    reachable: boolean;
    inSync: boolean;
    fullSync: boolean;
    vaults: Array<{
      type: string;
      seq: number;
      customerCount: number;
      inSync: boolean;
      fullSync: boolean;
    }>;
    error?: string;
  }

  const managers: LMStatus[] = [];

  // Local LM (development)
  const localLm: LMStatus = {
    name: 'Local LM',
    host: 'http://localhost:22610',
    reachable: false,
    inSync: false,
    fullSync: false,
    vaults: [],
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const res = await fetch('http://localhost:22610/health', {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      const data = await res.json() as {
        vaults: Array<{
          type: string;
          seq: number;
          customerCount: number;
          inSync: boolean;
          fullSync: boolean;
        }>;
        inSync: boolean;
        fullSync: boolean;
      };
      localLm.reachable = true;
      localLm.inSync = data.inSync;
      localLm.fullSync = data.fullSync;
      localLm.vaults = data.vaults.map((v) => ({
        type: v.type,
        seq: v.seq,
        customerCount: v.customerCount,
        inSync: v.inSync,
        fullSync: v.fullSync,
      }));
    } else {
      localLm.error = `HTTP ${res.status}`;
    }
  } catch (err) {
    localLm.error = err instanceof Error ? err.message : 'Connection failed';
  }

  managers.push(localLm);

  return { managers };
});

// ============================================================================
// Sync Overview API (for Admin Dashboard)
// ============================================================================

// Get fleet-wide sync overview
server.get('/api/sync/overview', async () => {
  const { getLMStatuses, getMinLMVaultSeq, areAllLMsInSync } = await import('./tasks/poll-lm-status.js');
  const { systemControl } = await import('@suiftly/database');
  const { eq } = await import('drizzle-orm');

  // Get current vault seq from system_control
  const [control] = await db
    .select()
    .from(systemControl)
    .where(eq(systemControl.id, 1))
    .limit(1);

  const currentVaultSeq = control?.smaVaultSeq ?? 0;

  // Get LM statuses
  const lmStatuses = await getLMStatuses();
  const minLMSeq = await getMinLMVaultSeq();
  const allInSync = await areAllLMsInSync();

  // Calculate sync status
  // LM is "reachable" if we've seen it recently (within last 30 seconds)
  const recentThreshold = new Date(Date.now() - 30000);
  const lmsReachable = lmStatuses.filter(s => s.lastSeenAt && s.lastSeenAt > recentThreshold).length;
  const lmsInSync = lmStatuses.filter(s => s.inSync).length;
  const lmsFullSync = lmStatuses.filter(s => s.fullSync).length;
  const lmsTotal = lmStatuses.length;

  return {
    vault: {
      currentSeq: currentVaultSeq,
      contentHash: control?.smaVaultContentHash ?? null,
    },
    lms: {
      total: lmsTotal,
      reachable: lmsReachable,
      inSync: lmsInSync,
      fullSync: lmsFullSync,
      minSeq: minLMSeq,
      allInSync,
      statuses: lmStatuses.map(s => {
        const isReachable = s.lastSeenAt && s.lastSeenAt > recentThreshold;
        return {
          id: s.lmId,
          name: s.displayName,
          host: s.host,
          region: s.region,
          reachable: isReachable,
          vaultSeq: s.vaultSeq,
          customerCount: s.customerCount,
          inSync: s.inSync,
          fullSync: s.fullSync,
          lastSeenAt: s.lastSeenAt?.toISOString() ?? null,
          lastError: s.lastError,
        };
      }),
    },
    syncStatus: allInSync && minLMSeq !== null && minLMSeq >= currentVaultSeq
      ? 'synced'
      : 'pending',
  };
});

// ============================================================================
// Graceful shutdown
// ============================================================================

const shutdown = async (signal: string) => {
  server.log.info(`${signal} received, shutting down gracefully...`);
  stopPeriodicSync();
  await server.close();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start server
async function start() {
  try {
    await server.listen({ port: PORT, host: HOST });
    server.log.info(`Global Manager (gm) listening on http://${HOST}:${PORT}`);

    // Reconcile vault state (data_tx vs DB) on startup
    // This handles scenarios where DB was reset but vault files still exist
    try {
      const { reconcileVaultState } = await import('./tasks/reconcile-vault-state.js');
      const results = await reconcileVaultState();
      const updated = results.filter((r) => r.action === 'updated_db');
      if (updated.length > 0) {
        server.log.info(`Vault state reconciled: ${updated.map((r) => `${r.vaultType} seq ${r.dbSeq} → ${r.newDbSeq}`).join(', ')}`);
      }
    } catch (err) {
      server.log.warn(`Vault reconciliation failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }

    // Start periodic sync-all (10 minutes in production, 1 minute in dev)
    const syncInterval = isTestDeployment()
      ? 1 * 60 * 1000   // 1 minute (test/dev)
      : 10 * 60 * 1000; // 10 minutes (production)
    startPeriodicSync(syncInterval);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

start();
