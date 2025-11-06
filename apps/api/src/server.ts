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
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
await server.register(rateLimit, {
  max: config.RATE_LIMIT_MAX,
  timeWindow: '1 minute',
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
    onError({ path, error }) {
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
  const { resetCustomerTestData, getCustomerTestData } = await import('./lib/test-data.js');

  // Get test configuration - allows tests to verify server config
  server.get('/test/config', {
    config: { rateLimit: false },
  }, async () => {
    return {
      environment: config.NODE_ENV,
      mockAuth: config.MOCK_AUTH,
      shortJWTExpiry: config.ENABLE_SHORT_JWT_EXPIRY === true,
      jwtConfig: {
        accessTokenExpiry: process.env.JWT_ACCESS_EXPIRY || '15m',
        refreshTokenExpiry: process.env.JWT_REFRESH_EXPIRY || '30d',
      },
    };
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

  // Mock wallet control endpoints
  const { getSuiService } = await import('./services/sui/index.js');
  const suiService = getSuiService();

  // Get mock wallet balance
  server.get('/test/wallet/balance', {
    config: { rateLimit: false },
  }, async (request, reply) => {
    const query = request.query as any;
    const walletAddress = query.walletAddress || '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

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
      balanceUsd: account.balanceUsdcCents / 100,
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
      amountUsdcCents: Math.round(amountUsd * 100),
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
        ? ((await suiService.getAccount(walletAddress))?.balanceUsdcCents ?? 0) / 100
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
      amountUsdcCents: Math.round(amountUsd * 100),
    });

    reply.send({
      success: result.success,
      error: result.error,
      digest: result.digest,
      accountCreated: result.accountCreated,
      newBalanceUsd: result.success
        ? ((await suiService.getAccount(walletAddress))?.balanceUsdcCents ?? 0) / 100
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

    const result = await suiService.charge({
      userAddress: walletAddress,
      amountUsdCents: Math.round(amountUsd * 100),
      description,
    });

    // If successful, create ledger entry
    if (result.success) {
      const { db } = await import('@suiftly/database');
      const { ledgerEntries, customers } = await import('@suiftly/database/schema');
      const { eq } = await import('drizzle-orm');

      const customer = await db.query.customers.findFirst({
        where: eq(customers.walletAddress, walletAddress),
      });

      if (customer) {
        await db.insert(ledgerEntries).values({
          customerId: customer.customerId,
          type: 'charge',
          amountUsdCents: Math.round(amountUsd * 100),
          txHash: result.digest,
          description,
        });
      }
    }

    reply.send({
      success: result.success,
      error: result.error,
      digest: result.digest,
      newBalanceUsd: result.success
        ? ((await suiService.getAccount(walletAddress))?.balanceUsdcCents ?? 0) / 100
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

    const result = await suiService.credit({
      userAddress: walletAddress,
      amountUsdCents: Math.round(amountUsd * 100),
      description,
    });

    // If successful, create ledger entry
    if (result.success) {
      const { db } = await import('@suiftly/database');
      const { ledgerEntries, customers } = await import('@suiftly/database/schema');
      const { eq } = await import('drizzle-orm');

      const customer = await db.query.customers.findFirst({
        where: eq(customers.walletAddress, walletAddress),
      });

      if (customer) {
        await db.insert(ledgerEntries).values({
          customerId: customer.customerId,
          type: 'credit',
          amountUsdCents: Math.round(amountUsd * 100),
          txHash: result.digest,
          description,
        });
      }
    }

    reply.send({
      success: result.success,
      error: result.error,
      digest: result.digest,
      newBalanceUsd: result.success
        ? ((await suiService.getAccount(walletAddress))?.balanceUsdcCents ?? 0) / 100
        : undefined,
    });
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
    // Initialize frontend configuration in database before starting server
    await initializeFrontendConfig();

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
