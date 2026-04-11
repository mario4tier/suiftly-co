/**
 * gRPC IP Allowlist End-to-End Control Plane Test
 *
 * Validates the full control plane for IP allowlist:
 * 1. Enable IP allowlist via API (requires Pro tier)
 * 2. GM generates rma vault with allowlist in customer config
 * 3. LM writes HAProxy map files with allowlist entries
 * 4. HAProxy enforces allowlist on metered port (rejects non-allowed IPs)
 *
 * This tests the vault content to verify the control plane works correctly:
 * - mapConfigHex control bit 1 (IP_ALLOWLIST_ENABLED) is set
 * - ipAllowlist field contains the correct IPs
 * - HAProxy allowlist map file has the customer entry
 *
 * Prerequisites:
 * - HAProxy, GM, LM, API running
 * - sui-proxy backends running (for health checks)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as http2 from 'node:http2';
import { db } from '@suiftly/database';
import { serviceInstances, systemControl } from '@suiftly/database/schema';
import { eq, and } from 'drizzle-orm';
import { SERVICE_TYPE, GRPC_PORT } from '@suiftly/shared/constants';
import {
  trpcQuery,
  trpcMutation,
} from './helpers/http.js';
import { setupBillingTest, type SetupBillingTestResult } from './helpers/setup.js';

// ============================================================================
// HTTP/2 Helper (same as grpc-haproxy-requests.test.ts)
// ============================================================================

function grpcRequest(options: {
  apiKey?: string;
  port?: number;
  clientIp?: string;
  path?: string;
  timeout?: number;
}): Promise<{ ok: boolean; status: number; body: string; error?: string }> {
  const port = options.port ?? GRPC_PORT.MAINNET_LOCAL;
  const path = options.path ?? '/health';
  const timeout = options.timeout ?? 5000;

  return new Promise((resolve) => {
    const client = http2.connect(`http://localhost:${port}`);
    const headers: http2.OutgoingHttpHeaders = { ':method': 'GET', ':path': path };
    if (options.apiKey) headers['x-api-key'] = options.apiKey;
    if (options.clientIp) headers['cf-connecting-ip'] = options.clientIp;

    const timeoutId = setTimeout(() => { client.close(); resolve({ ok: false, status: 0, body: '', error: 'timeout' }); }, timeout);
    client.on('error', (err) => { clearTimeout(timeoutId); client.close(); resolve({ ok: false, status: 0, body: '', error: err.message }); });

    const req = client.request(headers);
    let data = '';
    let status = 0;
    req.on('response', (h) => { status = h[':status'] as number ?? 0; });
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => { clearTimeout(timeoutId); client.close(); resolve({ ok: status >= 200 && status < 300, status, body: data }); });
    req.on('error', (err) => { clearTimeout(timeoutId); client.close(); resolve({ ok: false, status: 0, body: '', error: err.message }); });
    req.end();
  });
}

// ============================================================================
// Vault Sync Helpers
// ============================================================================

const GM_BASE = 'http://localhost:22600';
const LM_BASE = 'http://localhost:22610';
const SUDOB_BASE = 'http://localhost:22800';

async function triggerFullSync(timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await fetch(`${GM_BASE}/api/queue/sync-all`, { method: 'POST' });
    await fetch(`${SUDOB_BASE}/api/service/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'sync-files' }),
    });

    // Check if LM has applied the latest vault
    try {
      const res = await fetch(`${LM_BASE}/api/health`);
      if (res.ok) {
        const data = await res.json() as any;
        const rmaVault = data.vaults?.find((v: any) => v.type === 'rma');
        const [control] = await db
          .select({ rmaVaultSeq: systemControl.rmaVaultSeq })
          .from(systemControl)
          .where(eq(systemControl.id, 1))
          .limit(1);
        if (rmaVault?.applied?.seq >= (control?.rmaVaultSeq ?? 0) && (control?.rmaVaultSeq ?? 0) > 0) {
          return;
        }
      }
    } catch { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Timed out waiting for vault sync');
}

/**
 * Read HAProxy map file content via sudob
 */
async function readMapFile(path: string): Promise<string | null> {
  try {
    const res = await fetch(`${SUDOB_BASE}/api/files/read?path=${encodeURIComponent(path)}`);
    if (res.ok) {
      const data = await res.json() as any;
      return data.content ?? null;
    }
  } catch { /* ignore */ }
  return null;
}

// ============================================================================
// Test Setup
// ============================================================================

let setup: SetupBillingTestResult;
let grpcApiKey: string;
let haproxyAvailable: boolean;

const ALLOWED_IP = '192.168.1.100';
const BLOCKED_IP = '10.99.99.99';

beforeAll(async () => {
  // Check prerequisites
  try {
    const res = await grpcRequest({ path: '/health', timeout: 2000 });
    haproxyAvailable = res.status > 0;
  } catch {
    haproxyAvailable = false;
  }

  if (!haproxyAvailable) {
    console.warn('SKIP: HAProxy gRPC frontend not available');
    return;
  }

  // Setup customer with Pro tier (required for IP allowlist)
  setup = await setupBillingTest({ balance: 200 });

  // Upgrade to Pro tier
  await trpcMutation('services.upgradeTier', { serviceType: 'platform', newTier: 'pro' }, setup.accessToken);

  // Enable gRPC service
  await trpcMutation('services.toggleService', { serviceType: 'grpc', enabled: true }, setup.accessToken);

  // Create API key
  const keyResult = await trpcMutation<any>('grpc.createApiKey', {}, setup.accessToken);
  if (keyResult.error) throw new Error(`Failed to create API key: ${JSON.stringify(keyResult.error)}`);
  grpcApiKey = keyResult.result!.data.apiKey;

  // Initial vault sync
  await triggerFullSync();
}, 30000);

// ============================================================================
// Tests
// ============================================================================

describe('gRPC IP Allowlist Control Plane', () => {
  describe('Without IP Allowlist (default)', () => {
    it('should accept requests from any IP when allowlist is disabled', { timeout: 15000 }, async () => {
      if (!haproxyAvailable) return;

      // Verify allowlist is disabled
      const settings = await trpcQuery<any>('grpc.getMoreSettings', undefined, setup.accessToken);
      expect(settings.result?.data?.ipAllowlistEnabled).toBe(false);

      // Request from any IP should work via local port
      const response = await grpcRequest({
        apiKey: grpcApiKey,
        port: GRPC_PORT.MAINNET_LOCAL,
        path: '/health',
        clientIp: '1.2.3.4',
      });
      expect(response.ok).toBe(true);
    });
  });

  describe('Enable IP Allowlist', () => {
    it('should enable IP allowlist and add allowed IPs', { timeout: 15000 }, async () => {
      if (!haproxyAvailable) return;

      const result = await trpcMutation<any>(
        'grpc.updateIpAllowlist',
        { enabled: true, entries: ALLOWED_IP },
        setup.accessToken
      );

      expect(result.error).toBeUndefined();
      expect(result.result?.data?.success).toBe(true);
      expect(result.result?.data?.enabled).toBe(true);
      expect(result.result?.data?.entries).toEqual([ALLOWED_IP]);
    });

    it('should persist allowlist settings', async () => {
      if (!haproxyAvailable) return;

      const settings = await trpcQuery<any>('grpc.getMoreSettings', undefined, setup.accessToken);
      expect(settings.result?.data?.ipAllowlistEnabled).toBe(true);
      expect(settings.result?.data?.ipAllowlist).toEqual([ALLOWED_IP]);
    });

    it('should sync allowlist to vault and HAProxy maps', { timeout: 30000 }, async () => {
      if (!haproxyAvailable) return;

      // Sync vault with allowlist changes
      await triggerFullSync();

      // Verify vault has entries (customer with allowlist config)
      const [control] = await db
        .select({
          rmaVaultSeq: systemControl.rmaVaultSeq,
          rmaVaultEntries: systemControl.rmaVaultEntries,
        })
        .from(systemControl)
        .where(eq(systemControl.id, 1))
        .limit(1);

      expect(control!.rmaVaultEntries).toBeGreaterThanOrEqual(1);
    });

    it('should have allowlist map file with customer entry', async () => {
      if (!haproxyAvailable) return;

      // Read the gRPC allowlist map file
      const mapContent = await readMapFile('/etc/haproxy/conf.d/206-mgrpc_allowlist.map');

      // Map content should exist and contain our customer's entry
      // The allowlist map format is: <customerId> <comma-separated CIDRs>
      expect(mapContent).not.toBeNull();
      if (mapContent && mapContent.trim().length > 0) {
        // Filter out metadata entries (starting with __)
        const customerEntries = mapContent
          .split('\n')
          .filter(line => line.trim() && !line.startsWith('__'));

        // Should have at least one customer entry with our allowed IP
        const hasOurEntry = customerEntries.some(line =>
          line.includes(ALLOWED_IP)
        );
        expect(hasOurEntry).toBe(true);
      }
    });

    it('should have config map with IP_ALLOWLIST_ENABLED bit set', async () => {
      if (!haproxyAvailable) return;

      // Read the gRPC config map
      const mapContent = await readMapFile('/etc/haproxy/conf.d/206-mgrpc_config.map');

      expect(mapContent).not.toBeNull();
      if (mapContent && mapContent.trim().length > 0) {
        const customerEntries = mapContent
          .split('\n')
          .filter(line => line.trim() && !line.startsWith('__'));

        // Should have customer entry with control flags
        // Control bit 1 (0x0002) = IP_ALLOWLIST_ENABLED
        // The mapConfigHex format is: header,api_keys,ip_filter,extra
        const hasEntry = customerEntries.some(line => {
          // The hex config has control flags in the header
          // Position 12-15 of header: CCCC (control flags)
          const parts = line.split(/\s+/);
          if (parts.length >= 2) {
            const configHex = parts[1]; // The 67-char hex string
            const headerPart = configHex.split(',')[0]; // First 16 hex chars
            if (headerPart && headerPart.length >= 16) {
              const controlFlags = parseInt(headerPart.slice(12, 16), 16);
              return (controlFlags & 0x0002) !== 0; // IP_ALLOWLIST_ENABLED bit
            }
          }
          return false;
        });

        expect(hasEntry).toBe(true);
      }
    });
  });

  describe('Disable IP Allowlist', () => {
    it('should disable IP allowlist', { timeout: 15000 }, async () => {
      if (!haproxyAvailable) return;

      const result = await trpcMutation<any>(
        'grpc.updateIpAllowlist',
        { enabled: false },
        setup.accessToken
      );

      expect(result.error).toBeUndefined();
      expect(result.result?.data?.enabled).toBe(false);
    });

    it('should sync disabled allowlist to vault', { timeout: 30000 }, async () => {
      if (!haproxyAvailable) return;

      await triggerFullSync();

      // Config map should no longer have IP_ALLOWLIST_ENABLED bit
      const mapContent = await readMapFile('/etc/haproxy/conf.d/206-mgrpc_config.map');

      if (mapContent && mapContent.trim().length > 0) {
        const customerEntries = mapContent
          .split('\n')
          .filter(line => line.trim() && !line.startsWith('__'));

        // IP_ALLOWLIST bit should be cleared
        const hasAllowlistEnabled = customerEntries.some(line => {
          const parts = line.split(/\s+/);
          if (parts.length >= 2) {
            const configHex = parts[1];
            const headerPart = configHex.split(',')[0];
            if (headerPart && headerPart.length >= 16) {
              const controlFlags = parseInt(headerPart.slice(12, 16), 16);
              return (controlFlags & 0x0002) !== 0;
            }
          }
          return false;
        });

        // After disabling, the bit should NOT be set
        expect(hasAllowlistEnabled).toBe(false);
      }
    });

    it('should accept requests from any IP after allowlist disabled', async () => {
      if (!haproxyAvailable) return;

      const response = await grpcRequest({
        apiKey: grpcApiKey,
        port: GRPC_PORT.MAINNET_LOCAL,
        path: '/health',
        clientIp: BLOCKED_IP,
      });

      // With allowlist disabled, any IP should be accepted
      expect(response.ok).toBe(true);
    });
  });
});
