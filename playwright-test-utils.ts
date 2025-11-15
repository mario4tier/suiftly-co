/**
 * Playwright Test Server Utilities
 * Provides robust server management with graceful shutdown and config verification
 */

import { spawn, ChildProcess, execSync } from 'child_process';

export interface ServerConfig {
  environment: string;
  mockAuth: boolean;
  shortJWTExpiry: boolean;
  jwtConfig: {
    accessTokenExpiry: string;
    refreshTokenExpiry: string;
  };
}

export interface ExpectedConfig {
  shortJWTExpiry?: boolean;
  jwtAccessExpiry?: string;
  jwtRefreshExpiry?: string;
  mockAuth?: boolean;
}

/**
 * Attempt to fetch server configuration via /test/config endpoint
 */
export async function getServerConfig(url: string): Promise<ServerConfig | null> {
  try {
    const response = await fetch(`${url}/test/config`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return null;
    return (await response.json()) as ServerConfig;
  } catch {
    return null;
  }
}

/**
 * Check if server config matches expected config
 */
export function configMatches(actual: ServerConfig, expected: ExpectedConfig): boolean {
  if (expected.shortJWTExpiry !== undefined && actual.shortJWTExpiry !== expected.shortJWTExpiry) {
    return false;
  }
  if (expected.jwtAccessExpiry && actual.jwtConfig.accessTokenExpiry !== expected.jwtAccessExpiry) {
    return false;
  }
  if (expected.jwtRefreshExpiry && actual.jwtConfig.refreshTokenExpiry !== expected.jwtRefreshExpiry) {
    return false;
  }
  if (expected.mockAuth !== undefined && actual.mockAuth !== expected.mockAuth) {
    return false;
  }
  return true;
}

/**
 * Attempt graceful shutdown via /test/shutdown endpoint
 */
export async function gracefulShutdown(url: string): Promise<boolean> {
  try {
    await fetch(`${url}/test/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(2000),
    });
    // Give server time to shutdown
    await new Promise(resolve => setTimeout(resolve, 2000));
    return true;
  } catch {
    return false;
  }
}

/**
 * Send SIGTERM to process on port
 */
export async function sigtermPort(port: number): Promise<boolean> {
  try {
    // Find PID using port
    const pid = execSync(`lsof -ti:${port}`, { encoding: 'utf-8' }).trim();
    if (!pid) return false;

    // Send SIGTERM
    execSync(`kill -TERM ${pid}`, { stdio: 'ignore' });

    // Wait for graceful shutdown
    await new Promise(resolve => setTimeout(resolve, 3000));
    return true;
  } catch {
    return false;
  }
}

/**
 * Force kill processes on ports (last resort)
 */
export async function forceKillPorts(ports: number[]): Promise<void> {
  for (const port of ports) {
    try {
      const pids = execSync(`lsof -ti:${port}`, { encoding: 'utf-8', stdio: 'pipe' })
        .trim()
        .split('\n')
        .filter(pid => pid.length > 0)
        .join(' '); // Convert newline-separated PIDs to space-separated for kill command

      if (pids) {
        console.log(`🧹 Force killing processes on port ${port}: PIDs ${pids}`);
        // Redirect stderr to /dev/null to suppress npm error messages
        execSync(`kill -9 ${pids} 2>/dev/null || true`, { stdio: 'pipe' });
        console.log(`✅ Force killed processes on port ${port}`);
      }
    } catch {
      // Port was already free or lsof failed
      console.log(`ℹ️  No processes found on port ${port} (already free)`);
    }
  }
  // Give OS time to release the ports
  await new Promise(resolve => setTimeout(resolve, 2000));
}

/**
 * Check if a port is free
 */
export function isPortFree(port: number): boolean {
  try {
    execSync(`lsof -ti:${port}`, { encoding: 'utf-8', stdio: 'pipe' });
    // If lsof found something, port is in use
    return false;
  } catch {
    // lsof exits with non-zero when no process found (port is free)
    return true;
  }
}

/**
 * Wait for port to be free, with force kill fallback
 */
export async function waitForPortFree(port: number, timeout = 10000): Promise<void> {
  const startTime = Date.now();
  let attempts = 0;
  while (Date.now() - startTime < timeout) {
    if (isPortFree(port)) {
      console.log(`✅ Port ${port} is free`);
      return;
    }
    attempts++;
    console.log(`⏳ Waiting for port ${port} to be released... (attempt ${attempts})`);

    // After 5 seconds of waiting, try force kill
    if (attempts === 5) {
      console.log(`⚠️  Port ${port} still occupied after 5s, attempting force kill...`);
      await forceKillPorts([port]);
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Last resort: one more force kill attempt
  console.log(`⚠️  Port ${port} still not free, final force kill attempt...`);
  await forceKillPorts([port]);

  if (isPortFree(port)) {
    console.log(`✅ Port ${port} is now free after force kill`);
    return;
  }

  throw new Error(`Port ${port} did not become free within ${timeout}ms even after force kill`);
}

/**
 * Wait for server to be ready
 */
export async function waitForServer(url: string, timeout = 30000): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        console.log(`✅ Server ready at ${url}`);
        return;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Server at ${url} did not start within ${timeout}ms`);
}

/**
 * Ensure server is running with correct config
 * Attempts graceful shutdown if config is wrong, falls back to force kill if needed
 */
export async function ensureCorrectServer(
  healthUrl: string,
  port: number,
  expectedConfig: ExpectedConfig
): Promise<{ needsRestart: boolean; reason?: string }> {
  // Check if server is responding
  try {
    const healthCheck = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
    if (!healthCheck.ok) {
      return { needsRestart: true, reason: 'Server not responding to health check' };
    }
  } catch {
    return { needsRestart: true, reason: 'No server running' };
  }

  // Get server config
  const baseUrl = healthUrl.replace('/health', '');
  const serverConfig = await getServerConfig(baseUrl);

  if (!serverConfig) {
    console.log('⚠️  Server running but no test config endpoint - assuming wrong config');
    return { needsRestart: true, reason: 'No test config endpoint (old server?)' };
  }

  // Check if config matches
  if (!configMatches(serverConfig, expectedConfig)) {
    console.log('⚠️  Server config mismatch:');
    console.log('   Expected:', expectedConfig);
    console.log('   Actual:', serverConfig);
    return { needsRestart: true, reason: 'Config mismatch' };
  }

  console.log('✅ Server running with correct config');
  return { needsRestart: false };
}

/**
 * Shutdown server gracefully with fallback to force kill
 */
export async function shutdownServer(
  baseUrl: string,
  port: number,
  name: string
): Promise<void> {
  console.log(`🧹 Shutting down ${name}...`);

  // Try graceful shutdown via endpoint
  console.log('   Attempting graceful shutdown via /test/shutdown...');
  const graceful = await gracefulShutdown(baseUrl);
  if (graceful && isPortFree(port)) {
    console.log(`✅ ${name} shutdown gracefully`);
    return;
  }

  // Try SIGTERM
  console.log('   Graceful shutdown failed, trying SIGTERM...');
  const sigterm = await sigtermPort(port);
  if (sigterm && isPortFree(port)) {
    console.log(`✅ ${name} stopped via SIGTERM`);
    return;
  }

  // Last resort: force kill
  console.log('   SIGTERM failed, force killing...');
  await forceKillPorts([port]);

  if (isPortFree(port)) {
    console.log(`✅ ${name} force killed`);
  } else {
    console.log(`⚠️  ${name} may still be running (port ${port} still occupied)`);
  }
}
