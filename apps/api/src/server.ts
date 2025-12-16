/**
 * Fastify server with tRPC
 * Phase 5: Complete API server foundation
 */

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { createContext } from './lib/trpc';
import { appRouter } from './routes';
import { registerAuthRoutes } from './routes/rest-auth';
import { config, logConfig } from './lib/config';
import { initializeFrontendConfig } from './lib/init-config';
import { initializeConfigCache } from './lib/config-cache';
import { verifyDatabasePermissions } from './lib/db-permissions-check';
import { testDelayManager } from './lib/test-delays';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Convert hex string to Buffer for BYTEA fields
 * Handles both 0x-prefixed and non-prefixed hex strings
 */
function hexToBuffer(hex: string): Buffer {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  return Buffer.from(cleanHex, 'hex');
}

const server = Fastify({
  logger: {
    level: config.NODE_ENV === 'production' ? 'info' : 'debug',
  },
});

// Security headers (helmet)
await server.register(helmet, {
  contentSecurityPolicy: config.NODE_ENV === 'production' ? undefined : false,
});

// Rate limiting (prevent abuse)
// Skip rate limiting for localhost to allow tests to run freely
await server.register(rateLimit, {
  max: config.RATE_LIMIT_MAX,
  timeWindow: '1 minute',
  allowList: ['127.0.0.1', '::1'], // Exempt localhost (IPv4 and IPv6)
  errorResponseBuilder: () => ({
    error: 'Rate limit exceeded',
    message: `Maximum ${config.RATE_LIMIT_MAX} requests per minute`,
  }),
});

// Cookie support (for httpOnly refresh tokens)
await server.register(cookie, {
  secret: config.COOKIE_SECRET,
});

// REST Auth routes (internal endpoints)
await registerAuthRoutes(server);

// tRPC API routes (internal endpoints)
await server.register(fastifyTRPCPlugin, {
  prefix: '/i/api',
  trpcOptions: {
    router: appRouter,
    createContext,
    onError({ path, error }: { path?: string; error: Error }) {
      console.error(`[tRPC Error] ${path}:`, error.message);
    },
  },
});

// Health check endpoint (no rate limit)
server.get('/health', {
  config: { rateLimit: false },
}, async () => {
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: config.NODE_ENV,
    mockAuth: config.MOCK_AUTH,
    version: '0.1.0',
  };
});

// Test endpoints (only in development/test)
if (config.NODE_ENV !== 'production') {
  // Import test utilities
  const { testDelayManager } = await import('./lib/test-delays.js');
  const {
    resetCustomerTestData,
    getCustomerTestData,
    getApiKeysTestData,
    getSealKeysTestData,
    getServiceInstanceTestData,
    setupSealWithCpEnabled,
  } = await import('./lib/test-data.js');

  // Get test configuration - allows tests to verify server config
  server.get('/test/config', {
    config: { rateLimit: false },
  }, async () => {
    const { getJWTConfig } = await import('./lib/jwt-config.js');
    const { hasRuntimeJWTOverride } = await import('./lib/runtime-jwt-config.js');
    const jwtConfig = getJWTConfig();

    return {
      environment: config.NODE_ENV,
      mockAuth: config.MOCK_AUTH,
      shortJWTExpiry: process.env.ENABLE_SHORT_JWT_EXPIRY === 'true',
      hasRuntimeJWTOverride: hasRuntimeJWTOverride(),
      jwtConfig: {
        accessTokenExpiry: jwtConfig.accessTokenExpiry,
        refreshTokenExpiry: jwtConfig.refreshTokenExpiry,
      },
    };
  });

  // Set JWT config at runtime (for testing only)
  server.post('/test/jwt-config', {
    config: { rateLimit: false },
  }, async (request, reply) => {
    if (config.NODE_ENV === 'production') {
      reply.status(403).send({ error: 'Cannot change JWT config in production' });
      return;
    }

    const { setRuntimeJWTConfig } = await import('./lib/runtime-jwt-config.js');
    const body = request.body as any;

    if (body.clear) {
      setRuntimeJWTConfig(null);
      reply.send({ success: true, message: 'JWT config cleared (using defaults)' });
    } else {
      const { accessTokenExpiry, refreshTokenExpiry } = body;
      if (!accessTokenExpiry || !refreshTokenExpiry) {
        reply.status(400).send({ error: 'Must provide accessTokenExpiry and refreshTokenExpiry' });
        return;
      }

      setRuntimeJWTConfig({ accessTokenExpiry, refreshTokenExpiry });
      reply.send({
        success: true,
        message: 'JWT config set',
        config: { accessTokenExpiry, refreshTokenExpiry }
      });
    }
  });

  // Set test delays - allows tests to slow down API responses for UI testing
  server.post('/test/delays', {
    config: { rateLimit: false },
  }, async (request, reply) => {
    const body = request.body as any;
    testDelayManager.setDelays(body);
    reply.send({
      success: true,
      delays: body,
      message: 'Test delays configured'
    });
  });

  // Clear test delays
  server.post('/test/delays/clear', {
    config: { rateLimit: false },
  }, async (request, reply) => {
    testDelayManager.clearDelays();
    reply.send({
      success: true,
      message: 'Test delays cleared'
    });
  });

  // Reset customer test data - deletes all services, keys, resets balance
  server.post('/test/data/reset', {
    config: { rateLimit: false },
  }, async (request, reply) => {
    const body = request.body as any;
    const result = await resetCustomerTestData(body);
    reply.send(result);
  });

  // Get customer test data - returns current state for debugging
  server.get('/test/data/customer', {
    config: { rateLimit: false },
  }, async (request, reply) => {
    const query = request.query as any;
    const walletAddress = query.walletAddress || undefined;
    const result = await getCustomerTestData(walletAddress);
    reply.send(result);
  });

  // Get API keys test data
  server.get('/test/data/api-keys', {
    config: { rateLimit: false },
  }, async (request, reply) => {
    const query = request.query as any;
    const walletAddress = query.walletAddress || undefined;
    const result = await getApiKeysTestData(walletAddress);
    reply.send(result);
  });

  // Get seal keys test data
  server.get('/test/data/seal-keys', {
    config: { rateLimit: false },
  }, async (request, reply) => {
    const query = request.query as any;
    const walletAddress = query.walletAddress || undefined;
    const result = await getSealKeysTestData(walletAddress);
    reply.send(result);
  });

  // Get service instance test data
  server.get('/test/data/service-instance', {
    config: { rateLimit: false },
  }, async (request, reply) => {
    const query = request.query as any;
    const serviceType = query.serviceType || 'seal';
    const walletAddress = query.walletAddress || undefined;
    const result = await getServiceInstanceTestData(serviceType, walletAddress);
    reply.send(result);
  });

  // Setup seal service with cpEnabled=true (for control plane sync tests)
  // Creates: service instance, seal key, package -> triggers cpEnabled
  server.post('/test/data/setup-cp-enabled', {
    config: { rateLimit: false },
  }, async (request, reply) => {
    const body = request.body as any;
    const walletAddress = body.walletAddress || undefined;
    const result = await setupSealWithCpEnabled(walletAddress);
    reply.send(result);
  });

  // Truncate all tables - DB-only reset (vault cleanup handled by sudob)
  // Use sudob's /api/test/reset-all for full reset including vault files
  server.post('/test/data/truncate-all', {
    config: { rateLimit: false },
  }, async (request, reply) => {
    const { db } = await import('@suiftly/database');
    const { sql } = await import('drizzle-orm');

    try {
      await db.transaction(async (tx) => {
        // Disable triggers to avoid foreign key issues
        await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);

        // Truncate all tables (CASCADE handles foreign keys)
        await tx.execute(sql`
          TRUNCATE TABLE
            customers,
            api_keys,
            escrow_transactions,
            ledger_entries,
            user_activity_logs,
            service_instances,
            service_cancellation_history,
            seal_keys,
            auth_nonces,
            refresh_tokens,
            billing_records,
            lm_status
          CASCADE
        `);

        // Reset vault sequence numbers in system_control
        // This ensures next vault generation starts fresh at seq=1
        await tx.execute(sql`
          UPDATE system_control SET
            sma_vault_seq = 0,
            sma_vault_content_hash = NULL,
            smm_vault_seq = 0,
            smm_vault_content_hash = NULL,
            sms_vault_seq = 0,
            sms_vault_content_hash = NULL,
            smo_vault_seq = 0,
            smo_vault_content_hash = NULL,
            sta_vault_seq = 0,
            sta_vault_content_hash = NULL,
            stm_vault_seq = 0,
            stm_vault_content_hash = NULL,
            sts_vault_seq = 0,
            sts_vault_content_hash = NULL,
            sto_vault_seq = 0,
            sto_vault_content_hash = NULL,
            skk_vault_seq = 0,
            skk_vault_content_hash = NULL
          WHERE id = 1
        `);
      });

      reply.send({
        success: true,
        message: 'All tables truncated and vault sequences reset',
      });
    } catch (error: any) {
      console.error('[TRUNCATE ERROR]', error);
      reply.code(500).send({
        success: false,
        error: error.message || String(error),
        details: error.toString(),
      });
    }
  });

  // Mock wallet control endpoints
  const { getSuiService } = await import('@suiftly/database/sui-mock');
  const suiService = getSuiService();

  // Get mock wallet balance
  server.get('/test/wallet/balance', {
    config: { rateLimit: false },
  }, async (request, reply) => {
    const query = request.query as any;
    const walletAddress = query.walletAddress || '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    // Prevent caching to ensure fresh balance data
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    reply.header('Pragma', 'no-cache');
    reply.header('Expires', '0');

    const account = await suiService.getAccount(walletAddress);
    if (!account) {
      reply.send({
        found: false,
        message: 'Account not found',
      });
      return;
    }

    reply.send({
      found: true,
      walletAddress,
      balanceUsd: account.balanceUsdCents / 100,
      spendingLimitUsd: account.spendingLimitUsdCents / 100,
      currentPeriodChargedUsd: account.currentPeriodChargedUsdCents / 100,
      currentPeriodStartMs: account.currentPeriodStartMs,
    });
  });

  // Mock wallet deposit
  server.post('/test/wallet/deposit', {
    config: { rateLimit: false },
  }, async (request, reply) => {
    const body = request.body as any;
    const walletAddress = body.walletAddress || '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const amountUsd = body.amountUsd || 0;
    const initialSpendingLimitUsd = body.initialSpendingLimitUsd;

    if (amountUsd <= 0) {
      reply.code(400).send({
        success: false,
        error: 'Amount must be positive',
      });
      return;
    }

    const result = await suiService.deposit({
      userAddress: walletAddress,
      amountUsdCents: Math.round(amountUsd * 100),
      initialSpendingLimitUsdCents: initialSpendingLimitUsd !== undefined
        ? Math.round(initialSpendingLimitUsd * 100)
        : undefined,
    });

    reply.send({
      success: result.success,
      error: result.error,
      digest: result.digest,
      accountCreated: result.accountCreated,
      newBalanceUsd: result.success
        ? ((await suiService.getAccount(walletAddress))?.balanceUsdCents ?? 0) / 100
        : undefined,
    });
  });

  // Mock wallet withdraw
  server.post('/test/wallet/withdraw', {
    config: { rateLimit: false },
  }, async (request, reply) => {
    const body = request.body as any;
    const walletAddress = body.walletAddress || '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const amountUsd = body.amountUsd || 0;

    if (amountUsd <= 0) {
      reply.code(400).send({
        success: false,
        error: 'Amount must be positive',
      });
      return;
    }

    const result = await suiService.withdraw({
      userAddress: walletAddress,
      amountUsdCents: Math.round(amountUsd * 100),
    });

    reply.send({
      success: result.success,
      error: result.error,
      digest: result.digest,
      accountCreated: result.accountCreated,
      newBalanceUsd: result.success
        ? ((await suiService.getAccount(walletAddress))?.balanceUsdCents ?? 0) / 100
        : undefined,
    });
  });

  // Mock wallet set spending limit
  server.post('/test/wallet/spending-limit', {
    config: { rateLimit: false },
  }, async (request, reply) => {
    const body = request.body as any;
    const walletAddress = body.walletAddress || '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const limitUsd = body.limitUsd ?? 0;

    if (limitUsd < 0) {
      reply.code(400).send({
        success: false,
        error: 'Limit must be non-negative (0 = unlimited)',
      });
      return;
    }

    const result = await suiService.updateSpendingLimit({
      userAddress: walletAddress,
      newLimitUsdCents: Math.round(limitUsd * 100),
    });

    reply.send({
      success: result.success,
      error: result.error,
      digest: result.digest,
      accountCreated: result.accountCreated,
      newLimitUsd: result.success
        ? ((await suiService.getAccount(walletAddress))?.spendingLimitUsdCents ?? 0) / 100
        : undefined,
    });
  });

  // Mock wallet charge - simulates Suiftly charging for services
  server.post('/test/wallet/charge', {
    config: { rateLimit: false },
  }, async (request, reply) => {
    const body = request.body as any;
    const walletAddress = body.walletAddress || '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const amountUsd = body.amountUsd || 0;
    const description = body.description || 'Test charge';

    if (amountUsd <= 0) {
      reply.code(400).send({
        success: false,
        error: 'Amount must be positive',
      });
      return;
    }

    // Get the escrow address for this wallet
    const account = await suiService.getAccount(walletAddress);
    if (!account) {
      reply.code(400).send({
        success: false,
        error: 'Account does not exist. Create account first with deposit or withdraw.',
      });
      return;
    }

    const result = await suiService.charge({
      userAddress: walletAddress,
      amountUsdCents: Math.round(amountUsd * 100),
      description,
      escrowAddress: account.accountAddress,
    });

    // If successful, create invoice (billing record) and ledger entry
    if (result.success) {
      const { db } = await import('@suiftly/database');
      const { ledgerEntries, customers, billingRecords, invoiceLineItems } = await import('@suiftly/database/schema');
      const { eq } = await import('drizzle-orm');

      const customer = await db.query.customers.findFirst({
        where: eq(customers.walletAddress, walletAddress),
      });

      if (customer) {
        const amountCents = Math.round(amountUsd * 100);
        // Use dbClock for consistent timestamps in testing
        const { dbClock } = await import('@suiftly/shared/db-clock');
        const now = dbClock.now();

        // Create invoice (billing record) with status 'paid'
        const [invoice] = await db.insert(billingRecords).values({
          customerId: customer.customerId,
          billingPeriodStart: now,
          billingPeriodEnd: now,
          amountUsdCents: amountCents,
          amountPaidUsdCents: amountCents,
          type: 'charge',
          status: 'paid',
          billingType: 'immediate',
          txDigest: hexToBuffer(result.digest),
          createdAt: now,
        }).returning({ id: billingRecords.id });

        // Create line item for display (test charge uses subscription_pro as default)
        await db.insert(invoiceLineItems).values({
          billingRecordId: invoice.id,
          itemType: 'subscription_pro', // Test endpoint default
          serviceType: 'seal',
          quantity: 1,
          unitPriceUsdCents: amountCents,
          amountUsdCents: amountCents,
        });

        // Also create ledger entry for audit trail
        await db.insert(ledgerEntries).values({
          customerId: customer.customerId,
          invoiceId: invoice.id,
          type: 'charge',
          amountUsdCents: amountCents,
          txDigest: hexToBuffer(result.digest),
          description,
        });
      }
    }

    reply.send({
      success: result.success,
      error: result.error,
      digest: result.digest,
      newBalanceUsd: result.success
        ? ((await suiService.getAccount(walletAddress))?.balanceUsdCents ?? 0) / 100
        : undefined,
    });
  });

  // Mock wallet refund - simulates Suiftly refunding charges
  server.post('/test/wallet/refund', {
    config: { rateLimit: false },
  }, async (request, reply) => {
    const body = request.body as any;
    const walletAddress = body.walletAddress || '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const amountUsd = body.amountUsd || 0;
    const description = body.description || 'Test refund';

    if (amountUsd <= 0) {
      reply.code(400).send({
        success: false,
        error: 'Amount must be positive',
      });
      return;
    }

    // Get the escrow address for this wallet
    const account = await suiService.getAccount(walletAddress);
    if (!account) {
      reply.code(400).send({
        success: false,
        error: 'Account does not exist. Create account first with deposit or withdraw.',
      });
      return;
    }

    const result = await suiService.credit({
      userAddress: walletAddress,
      amountUsdCents: Math.round(amountUsd * 100),
      description,
      escrowAddress: account.accountAddress,
    });

    // If successful, create invoice (billing record) and ledger entry
    if (result.success) {
      const { db } = await import('@suiftly/database');
      const { ledgerEntries, customers, billingRecords, invoiceLineItems } = await import('@suiftly/database/schema');
      const { eq } = await import('drizzle-orm');

      const customer = await db.query.customers.findFirst({
        where: eq(customers.walletAddress, walletAddress),
      });

      if (customer) {
        const amountCents = Math.round(amountUsd * 100);
        // Use dbClock for consistent timestamps in testing
        const { dbClock } = await import('@suiftly/shared/db-clock');
        const now = dbClock.now();

        // Create invoice (billing record) with status 'paid' and type 'credit'
        const [invoice] = await db.insert(billingRecords).values({
          customerId: customer.customerId,
          billingPeriodStart: now,
          billingPeriodEnd: now,
          amountUsdCents: amountCents,
          amountPaidUsdCents: amountCents,
          type: 'credit',
          status: 'paid',
          billingType: 'immediate',
          txDigest: hexToBuffer(result.digest),
          createdAt: now,
        }).returning({ id: billingRecords.id });

        // Create line item for display (refund/credit)
        await db.insert(invoiceLineItems).values({
          billingRecordId: invoice.id,
          itemType: 'credit', // Refund is a credit line item
          quantity: 1,
          unitPriceUsdCents: amountCents,
          amountUsdCents: amountCents,
        });

        // Also create ledger entry for audit trail
        await db.insert(ledgerEntries).values({
          customerId: customer.customerId,
          invoiceId: invoice.id,
          type: 'credit',
          amountUsdCents: amountCents,
          txDigest: hexToBuffer(result.digest),
          description,
        });
      }
    }

    reply.send({
      success: result.success,
      error: result.error,
      digest: result.digest,
      newBalanceUsd: result.success
        ? ((await suiService.getAccount(walletAddress))?.balanceUsdCents ?? 0) / 100
        : undefined,
    });
  });

  // ========================================
  // Sui Mock Configuration Endpoints
  // ========================================

  // Import suiMockConfig for test endpoints
  const { suiMockConfig } = await import('@suiftly/database/sui-mock');

  // Import database clock and configure test_kv sync (read-only for API)
  // GM is the source of truth for mock clock - API just reads from test_kv
  const { dbClockProvider } = await import('@suiftly/shared/db-clock');
  const { getMockClockState, setMockClockState } = await import('@suiftly/database/test-kv');
  dbClockProvider.configureTestKvSync(getMockClockState, setMockClockState);
  dbClockProvider.enableTestKvSync();

  // ========================================
  // Sui Mock Configuration Endpoints
  // ========================================

  // Get current Sui mock configuration
  server.get('/test/sui/config', {
    config: { rateLimit: false },
  }, async (request, reply) => {
    reply.send({
      enabled: suiMockConfig.isEnabled(),
      config: suiMockConfig.getConfig(),
    });
  });

  // Set Sui mock configuration (delays, failures)
  server.post('/test/sui/config', {
    config: { rateLimit: false },
  }, async (request, reply) => {
    const body = request.body as any;

    // Validate config fields
    const validKeys = [
      'chargeDelayMs', 'depositDelayMs', 'withdrawDelayMs', 'creditDelayMs', 'getAccountDelayMs',
      'forceChargeFailure', 'forceChargeFailureMessage',
      'forceDepositFailure', 'forceDepositFailureMessage',
      'forceWithdrawFailure', 'forceWithdrawFailureMessage',
      'forceCreditFailure', 'forceCreditFailureMessage',
      'forceInsufficientBalance', 'forceSpendingLimitExceeded', 'forceAccountNotFound',
    ];

    const invalidKeys = Object.keys(body).filter(k => !validKeys.includes(k));
    if (invalidKeys.length > 0) {
      reply.code(400).send({
        success: false,
        error: `Invalid config keys: ${invalidKeys.join(', ')}`,
        validKeys,
      });
      return;
    }

    suiMockConfig.setConfig(body);
    reply.send({
      success: true,
      config: suiMockConfig.getConfig(),
    });
  });

  // Clear Sui mock configuration
  server.post('/test/sui/config/clear', {
    config: { rateLimit: false },
  }, async (request, reply) => {
    suiMockConfig.clearConfig();
    reply.send({
      success: true,
      config: suiMockConfig.getConfig(),
    });
  });

  // Get Sui mock transaction history
  server.get('/test/sui/transactions', {
    config: { rateLimit: false },
  }, async (request, reply) => {
    const query = request.query as any;
    const walletAddress = query.walletAddress || '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const limit = parseInt(query.limit) || 100;

    const history = await suiService.getTransactionHistory(walletAddress, limit);

    reply.send({
      walletAddress,
      count: history.length,
      transactions: history,
    });
  });

  // ========================================
  // Clock Test Endpoints - REMOVED
  // Clock management moved to Global Manager (GM) only
  // Tests should call GM's /api/test/clock/* endpoints
  // GM writes mock time to test_kv, and syncs before billing operations
  // ========================================

  // Get billing period info for testing
  server.get('/test/billing/period', {
    config: { rateLimit: false },
  }, async (request, reply) => {
    const query = request.query as any;
    const customerCreatedAt = query.createdAt ? new Date(query.createdAt) : new Date();

    if (isNaN(customerCreatedAt.getTime())) {
      reply.code(400).send({
        error: 'Invalid createdAt date',
      });
      return;
    }

    // Sync clock from test_kv before use
    await dbClockProvider.syncFromTestKv();

    const { getBillingPeriodInfo } = await import('@suiftly/shared/billing');
    const periodInfo = getBillingPeriodInfo(customerCreatedAt);

    reply.send({
      ...periodInfo,
      start: periodInfo.start.toISOString(),
      end: periodInfo.end.toISOString(),
      currentTime: dbClockProvider.getClock().now().toISOString(),
    });
  });

  // Run periodic billing job (for testing)
  // In production, this is called by Global Manager
  server.post('/test/billing/run-periodic-job', {
    config: { rateLimit: false },
  }, async (request, reply) => {
    const body = request.body as { customerId?: number } | undefined;
    const customerId = body?.customerId;

    try {
      const { db } = await import('@suiftly/database');
      const { runPeriodicBillingJob, runPeriodicJobForCustomer } = await import('@suiftly/database/billing');
      const { getSuiService } = await import('@suiftly/database/sui-mock');

      // Sync clock from test_kv before use
      await dbClockProvider.syncFromTestKv();

      const clock = dbClockProvider.getClock();
      const suiService = getSuiService();

      const billingConfig = {
        clock,
        gracePeriodDays: 14,
        maxRetryAttempts: 3,
        retryIntervalHours: 24,
        usageChargeThresholdCents: 500,
      };

      let result;
      if (customerId) {
        result = await runPeriodicJobForCustomer(db, customerId, billingConfig, suiService);
      } else {
        result = await runPeriodicBillingJob(db, billingConfig, suiService);
      }

      reply.send({
        success: result.errors.length === 0,
        result,
      });
    } catch (error: any) {
      console.error('[TEST BILLING JOB ERROR]', error);
      reply.code(500).send({
        success: false,
        error: error.message || String(error),
      });
    }
  });

  // Reconcile pending payments for a customer (for testing)
  // Calls GM queue endpoint to ensure single-threaded execution
  server.post('/test/billing/reconcile', {
    config: { rateLimit: false },
  }, async (request, reply) => {
    const body = request.body as { customerId: number };
    if (!body.customerId) {
      reply.code(400).send({ success: false, error: 'customerId is required' });
      return;
    }

    try {
      // Call GM's sync-customer endpoint (synchronous by default)
      // This ensures reconciliation runs in GM's single-threaded task queue
      const gmResponse = await fetch(
        `http://localhost:22600/api/queue/sync-customer/${body.customerId}?source=test`,
        { method: 'POST' }
      );

      if (!gmResponse.ok) {
        const errorText = await gmResponse.text();
        throw new Error(`GM sync-customer failed: ${gmResponse.status} ${errorText}`);
      }

      const result = await gmResponse.json();
      reply.send({ success: true, result });
    } catch (error: any) {
      console.error('[TEST RECONCILE ERROR]', error);
      reply.code(500).send({
        success: false,
        error: error.message || String(error),
      });
    }
  });

  // ========================================
  // Stats Test Endpoints (STATS_DESIGN.md D6)
  // ========================================

  // Insert mock HAProxy logs for testing stats
  server.post('/test/stats/mock-logs', {
    config: { rateLimit: false },
  }, async (request, reply) => {
    const body = request.body as any;

    // Validate required fields
    if (!body.customerId || !body.serviceType || !body.count || !body.timestamp) {
      reply.code(400).send({
        success: false,
        error: 'Missing required fields: customerId, serviceType, count, timestamp',
      });
      return;
    }

    try {
      const { db } = await import('@suiftly/database');
      const { insertMockHAProxyLogs, refreshStatsAggregate } = await import('@suiftly/database/stats');

      const timestamp = typeof body.timestamp === 'string'
        ? new Date(body.timestamp)
        : new Date(body.timestamp);

      if (isNaN(timestamp.getTime())) {
        reply.code(400).send({
          success: false,
          error: 'Invalid timestamp format',
        });
        return;
      }

      const count = await insertMockHAProxyLogs(db, body.customerId, {
        serviceType: body.serviceType,
        network: body.network ?? 1,
        count: body.count,
        timestamp,
        statusCode: body.statusCode ?? 200,
        trafficType: body.trafficType ?? 1,
        responseTimeMs: body.responseTimeMs ?? 50,
        bytesSent: body.bytesSent ?? 1024,
        spreadAcrossHours: body.spreadAcrossHours,
      });

      // Optionally refresh the aggregate (default: true for tests)
      if (body.refreshAggregate !== false) {
        await refreshStatsAggregate(db);
      }

      reply.send({
        success: true,
        inserted: count,
        timestamp: timestamp.toISOString(),
      });
    } catch (error: any) {
      console.error('[MOCK LOGS ERROR]', error);
      reply.code(500).send({
        success: false,
        error: error.message || String(error),
      });
    }
  });

  // Insert mixed success/error logs for dashboard testing
  server.post('/test/stats/mock-mixed-logs', {
    config: { rateLimit: false },
  }, async (request, reply) => {
    const body = request.body as any;

    if (!body.customerId || !body.serviceType || !body.count || !body.timestamp) {
      reply.code(400).send({
        success: false,
        error: 'Missing required fields: customerId, serviceType, count, timestamp',
      });
      return;
    }

    try {
      const { db } = await import('@suiftly/database');
      const { insertMockMixedLogs, refreshStatsAggregate } = await import('@suiftly/database/stats');

      const timestamp = typeof body.timestamp === 'string'
        ? new Date(body.timestamp)
        : new Date(body.timestamp);

      // Convert old-style { success, clientError, serverError } to new format
      // { guaranteed, burst, dropped, clientError, serverError }
      const rawDist = body.distribution ?? {};
      const distribution = {
        // If 'success' is provided, split it into guaranteed (70%) and burst (30%)
        guaranteed: rawDist.guaranteed ?? (rawDist.success ? Math.floor(rawDist.success * 0.7) : 50),
        burst: rawDist.burst ?? (rawDist.success ? rawDist.success - Math.floor(rawDist.success * 0.7) : 20),
        dropped: rawDist.dropped ?? 0,
        clientError: rawDist.clientError ?? 15,
        serverError: rawDist.serverError ?? 5,
      };

      const result = await insertMockMixedLogs(db, body.customerId, {
        serviceType: body.serviceType,
        network: body.network ?? 1,
        count: body.count,
        timestamp,
        trafficType: body.trafficType ?? 1,
        responseTimeMs: body.responseTimeMs ?? 50,
        spreadAcrossHours: body.spreadAcrossHours,
      }, distribution);

      if (body.refreshAggregate !== false) {
        await refreshStatsAggregate(db);
      }

      reply.send({
        success: true,
        inserted: result,
        total: result.success + result.clientError + result.serverError,
      });
    } catch (error: any) {
      console.error('[MOCK MIXED LOGS ERROR]', error);
      reply.code(500).send({
        success: false,
        error: error.message || String(error),
      });
    }
  });

  // Manually refresh stats aggregate
  server.post('/test/stats/refresh', {
    config: { rateLimit: false },
  }, async (request, reply) => {
    try {
      const { db } = await import('@suiftly/database');
      const { refreshStatsAggregate } = await import('@suiftly/database/stats');

      const body = request.body as any;
      const startTime = body.startTime ? new Date(body.startTime) : undefined;
      const endTime = body.endTime ? new Date(body.endTime) : undefined;

      await refreshStatsAggregate(db, startTime, endTime);

      reply.send({
        success: true,
        message: 'Stats aggregate refreshed',
      });
    } catch (error: any) {
      console.error('[REFRESH STATS ERROR]', error);
      reply.code(500).send({
        success: false,
        error: error.message || String(error),
      });
    }
  });

  // Clear logs for a customer
  server.post('/test/stats/clear-logs', {
    config: { rateLimit: false },
  }, async (request, reply) => {
    try {
      const { db } = await import('@suiftly/database');
      const { clearCustomerLogs, clearAllLogs, refreshStatsAggregate } = await import('@suiftly/database/stats');

      const body = request.body as any;

      if (body.customerId) {
        await clearCustomerLogs(db, body.customerId);
      } else {
        await clearAllLogs(db);
      }

      // Refresh aggregate after clearing
      if (body.refreshAggregate !== false) {
        await refreshStatsAggregate(db);
      }

      reply.send({
        success: true,
        message: body.customerId
          ? `Cleared logs for customer ${body.customerId}`
          : 'Cleared all logs',
      });
    } catch (error: any) {
      console.error('[CLEAR LOGS ERROR]', error);
      reply.code(500).send({
        success: false,
        error: error.message || String(error),
      });
    }
  });

  // Sync usage to DRAFT invoice for a customer (uses production code path)
  server.post('/test/stats/sync-draft', {
    config: { rateLimit: false },
  }, async (request, reply) => {
    try {
      const { db } = await import('@suiftly/database');
      const { forceSyncUsageToDraft } = await import('@suiftly/database/billing');
      const { dbClockProvider } = await import('@suiftly/shared/db-clock');

      const body = request.body as any;

      if (!body.customerId) {
        return reply.code(400).send({
          success: false,
          error: 'customerId is required',
        });
      }

      const clock = dbClockProvider.getClock();
      const result = await forceSyncUsageToDraft(db, body.customerId, clock);
      reply.send({
        success: result.success,
        operations: result.operations,
        errors: result.errors,
      });
    } catch (error: any) {
      console.error('[SYNC DRAFT ERROR]', error);
      reply.code(500).send({
        success: false,
        error: error.message || String(error),
      });
    }
  });

  // Graceful shutdown endpoint - allows tests to cleanly shutdown server
  server.post('/test/shutdown', {
    config: { rateLimit: false },
  }, async (request, reply) => {
    reply.send({ message: 'Shutting down gracefully...' });

    // Shutdown after sending response
    setImmediate(async () => {
      console.log('\n📴 Test shutdown requested via /test/shutdown');
      await server.close();
      process.exit(0);
    });
  });
}

// Serve static SPA (production only - dev uses Vite dev server with proxy)
if (config.NODE_ENV === 'production') {
  const webappDistPath = path.resolve(__dirname, '../../webapp/dist');

  await server.register(fastifyStatic, {
    root: webappDistPath,
    prefix: '/',
  });

  // SPA fallback - serve index.html for client-side routing
  server.setNotFoundHandler((request, reply) => {
    // Don't handle API routes with SPA fallback
    if (request.url.startsWith('/i/') || request.url.startsWith('/health')) {
      reply.code(404).send({ error: 'Not found' });
    } else {
      reply.sendFile('index.html');
    }
  });
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('\n📴 SIGTERM received, shutting down gracefully...');
  await server.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\n📴 SIGINT received, shutting down gracefully...');
  await server.close();
  process.exit(0);
});

// Start server
async function start() {
  try {
    // Verify database permissions (fail-fast if misconfigured)
    await verifyDatabasePermissions();

    // Initialize frontend configuration in database before starting server
    await initializeFrontendConfig();

    // Load configuration cache for fast backend access
    await initializeConfigCache();

    await server.listen({ port: parseInt(config.PORT), host: config.HOST });

    console.log('\n🚀 Suiftly API Server');
    console.log('='.repeat(50));
    logConfig();
    console.log('Endpoints:');
    console.log(`  🔐 Auth REST: http://${config.HOST}:${config.PORT}/i/auth/*`);
    console.log(`  📡 tRPC API: http://${config.HOST}:${config.PORT}/i/api`);
    console.log(`  🔧 Health: http://${config.HOST}:${config.PORT}/health`);
    if (config.NODE_ENV !== 'production') {
      console.log(`  🧪 Test Config: http://${config.HOST}:${config.PORT}/test/config`);
      console.log(`  🧪 Test Delays: POST http://${config.HOST}:${config.PORT}/test/delays`);
      console.log(`  🧪 Test Data Reset: POST http://${config.HOST}:${config.PORT}/test/data/reset`);
      console.log(`  🧪 Test Data Get: GET http://${config.HOST}:${config.PORT}/test/data/customer`);
      console.log(`  🧪 Test Truncate All: POST http://${config.HOST}:${config.PORT}/test/data/truncate-all`);
      console.log(`  🧪 Test Shutdown: POST http://${config.HOST}:${config.PORT}/test/shutdown`);
    }
    console.log('='.repeat(50));
    console.log('');
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

start();
