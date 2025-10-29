/**
 * Fastify server with tRPC
 * Based on ARCHITECTURE.md backend specification
 */

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { createContext } from './lib/trpc';
import { appRouter } from './routes';

const PORT = parseInt(process.env.PORT || '3000');
const HOST = process.env.HOST || '0.0.0.0';

const server = Fastify({
  logger: true,
  maxParamLength: 5000,
});

// Register cookie plugin (for httpOnly refresh tokens)
await server.register(cookie, {
  secret: process.env.COOKIE_SECRET || 'dev-cookie-secret-change-in-production',
});

// Register tRPC plugin
await server.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
  trpcOptions: {
    router: appRouter,
    createContext,
  },
});

// Health check endpoint
server.get('/health', async () => {
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    mockAuth: process.env.MOCK_AUTH === 'true',
  };
});

// Start server
async function start() {
  try {
    await server.listen({ port: PORT, host: HOST });
    console.log(`\n🚀 API Server running on http://${HOST}:${PORT}`);
    console.log(`📡 tRPC endpoint: http://${HOST}:${PORT}/trpc`);
    console.log(`🔧 Health check: http://${HOST}:${PORT}/health`);
    console.log(`🔐 Mock Auth: ${process.env.MOCK_AUTH === 'true' ? 'ENABLED' : 'DISABLED'}\n`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

start();
