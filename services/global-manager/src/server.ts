// Global Manager (gm) - Centralized control plane for Suiftly infrastructure
// Port: 22600

import Fastify from 'fastify';
import { db, adminNotifications } from '@suiftly/database';
import { getMockClockState, setMockClockState } from '@suiftly/database/test-kv';
import { desc, eq } from 'drizzle-orm';
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

const PORT = 22600;
const HOST = '0.0.0.0';

const server = Fastify({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
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
server.get('/api/notifications', async (request) => {
  const query = request.query as { acknowledged?: string; limit?: string };
  const limit = Math.min(parseInt(query.limit || '100', 10), 500);

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
server.post<{ Params: { id: string } }>('/api/notifications/:id/acknowledge', async (request, reply) => {
  const id = parseInt(request.params.id, 10);
  if (isNaN(id)) {
    return reply.status(400).send({ error: 'Invalid notification ID' });
  }

  const [updated] = await db
    .update(adminNotifications)
    .set({
      acknowledged: true,
      acknowledgedAt: new Date(),
      acknowledgedBy: 'admin', // Could be extended with actual user tracking
    })
    .where(eq(adminNotifications.notificationId, id))
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
server.delete<{ Params: { id: string } }>('/api/notifications/:id', async (request, reply) => {
  const id = parseInt(request.params.id, 10);
  if (isNaN(id)) {
    return reply.status(400).send({ error: 'Invalid notification ID' });
  }

  const [deleted] = await db
    .delete(adminNotifications)
    .where(eq(adminNotifications.notificationId, id))
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
server.post<{ Params: { customerId: string } }>(
  '/api/queue/sync-customer/:customerId',
  async (request, reply) => {
    const customerId = parseInt(request.params.customerId, 10);
    if (isNaN(customerId)) {
      return reply.status(400).send({ error: 'Invalid customer ID' });
    }

    const query = request.query as { source?: string; async?: string };
    const source = (query.source as 'api' | 'test' | 'manual') || 'api';
    const runAsync = query.async === 'true';

    let task;
    if (runAsync) {
      // Async mode - return immediately (for production API server calls)
      task = queueSyncCustomer(customerId, source);
      if (task) {
        return { success: true, queued: true, taskId: task.id };
      } else {
        return { success: true, queued: false, reason: 'deduplicated' };
      }
    } else {
      // Synchronous mode (default) - wait for completion
      task = await queueSyncCustomerSync(customerId, source);
      return { success: true, queued: !!task, completed: true, taskId: task?.id };
    }
  }
);

// Queue a sync-all (on-demand trigger)
// Default: waits for completion (synchronous)
// Use ?async=true to return immediately without waiting
server.post('/api/queue/sync-all', async (request) => {
  const query = request.query as { source?: string; async?: string };
  const source = (query.source as 'api' | 'test' | 'manual') || 'manual';
  const runAsync = query.async === 'true';

  let task;
  if (runAsync) {
    // Async mode - return immediately (for periodic timer)
    task = queueSyncAll(source);
    if (task) {
      return { success: true, queued: true, taskId: task.id };
    } else {
      return { success: true, queued: false, reason: 'deduplicated' };
    }
  } else {
    // Synchronous mode (default) - wait for completion
    task = await queueSyncAllSync(source);
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

if (process.env.NODE_ENV !== 'production') {
  const { dbClockProvider } = await import('@suiftly/shared/db-clock');

  // Configure test_kv sync for cross-process clock sharing
  dbClockProvider.configureTestKvSync(getMockClockState, setMockClockState);
  dbClockProvider.enableTestKvSync();

  // Clock mock endpoints - GM is the single source of truth
  // Sets local mock clock AND writes to test_kv for other processes
  server.post('/api/test/clock/mock', async (request) => {
    const body = request.body as { time?: string | number; autoAdvance?: boolean; timeScale?: number };

    let mockTime: Date | undefined;
    if (body.time) {
      mockTime = typeof body.time === 'string' ? new Date(body.time) : new Date(body.time);
      if (isNaN(mockTime.getTime())) {
        return { error: 'Invalid date/time value' };
      }
    }

    // Set local mock clock AND persist to test_kv
    const mockClock = await dbClockProvider.useMockClockAndSync({
      currentTime: mockTime,
      autoAdvance: body.autoAdvance || false,
      timeScale: body.timeScale || 1.0,
    });

    return {
      success: true,
      type: 'mock',
      currentTime: mockClock.now().toISOString(),
      config: {
        autoAdvance: body.autoAdvance || false,
        timeScale: body.timeScale || 1.0,
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
  server.post('/api/test/clock/advance', async (request) => {
    const mockClock = dbClockProvider.getMockClock();
    if (!mockClock) {
      return { error: 'Mock clock not enabled. Use /api/test/clock/mock first.' };
    }

    const body = request.body as { days?: number; hours?: number; minutes?: number; milliseconds?: number };

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
        days: body.days || 0,
        hours: body.hours || 0,
        minutes: body.minutes || 0,
        milliseconds: body.milliseconds || 0,
      },
    };
  });

  // Create a test notification
  server.post('/api/test/notification', async (request) => {
    const body = request.body as {
      severity?: string;
      category?: string;
      code?: string;
      message?: string;
    } | undefined;

    const [notification] = await db
      .insert(adminNotifications)
      .values({
        severity: body?.severity || 'info',
        category: body?.category || 'test',
        code: body?.code || 'TEST_NOTIFICATION',
        message: body?.message || 'This is a test notification',
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
// Graceful shutdown
// ============================================================================

const shutdown = async (signal: string) => {
  console.log(`\n${signal} received, shutting down gracefully...`);
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
    console.log(`Global Manager (gm) listening on http://${HOST}:${PORT}`);

    // Start periodic sync-all (1 hour interval in production, 5 minutes in dev)
    const syncInterval = process.env.NODE_ENV === 'production'
      ? 60 * 60 * 1000  // 1 hour
      : 5 * 60 * 1000;  // 5 minutes
    startPeriodicSync(syncInterval);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

start();
