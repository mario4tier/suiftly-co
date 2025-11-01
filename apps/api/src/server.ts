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
