/**
 * Fastify server with tRPC
 * Phase 5: Complete API server foundation
 */

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { createContext } from './lib/trpc';
import { appRouter } from './routes';
import { config, logConfig } from './lib/config';

const server = Fastify({
  logger: {
    level: config.NODE_ENV === 'production' ? 'info' : 'debug',
  },
});

// Security headers (helmet)
await server.register(helmet, {
  contentSecurityPolicy: config.NODE_ENV === 'production' ? undefined : false,
});

// CORS (allow frontend to call API)
// Support multiple dev ports (5173, 5174, etc.)
const allowedOrigins = [
  config.CORS_ORIGIN,
  'http://localhost:5174', // Alternative Vite port
];
await server.register(cors, {
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, curl, Postman)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'), false);
    }
  },
  credentials: true, // Allow cookies
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

// tRPC API routes
await server.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
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
    console.log(`  📡 tRPC API: http://${config.HOST}:${config.PORT}/trpc`);
    console.log(`  🔧 Health: http://${config.HOST}:${config.PORT}/health`);
    console.log('='.repeat(50));
    console.log('');
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

start();
