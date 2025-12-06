// Local Manager (lm) - Per-server control plane agent
// Port: 22610 (default, supports 22610-22613 for multi-instance dev)

import Fastify from 'fastify';

const PORT = parseInt(process.env.LM_PORT || '22610', 10);
const HOST = '0.0.0.0';

const server = Fastify({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  },
});

// Health check endpoint
server.get('/health', async () => {
  return {
    status: 'up',
    service: 'local-manager',
    port: PORT,
    timestamp: new Date().toISOString(),
  };
});

// Graceful shutdown
const shutdown = async (signal: string) => {
  console.log(`\n${signal} received, shutting down gracefully...`);
  await server.close();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start server
async function start() {
  try {
    await server.listen({ port: PORT, host: HOST });
    console.log(`Local Manager (lm) listening on http://${HOST}:${PORT}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

start();
