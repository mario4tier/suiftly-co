/**
 * Unit tests for @walrus/server-configs
 *
 * Validates that the server configuration helpers work correctly
 * when imported from suiftly-co.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getClusterConfig,
  getCurrentServer,
  getServerId,
  getServerById,
  getAllServers,
  getLocalVaultTypes,
  getGlobalVaultTypes,
  hasFluentdLm,
  hasFluentdGm,
  isGlobalServer,
  resetConfig,
  type ServerClusterConfig,
  type ServerInfo,
} from '@walrus/server-configs';

describe('@walrus/server-configs', () => {
  // Reset cache before each test to ensure fresh load
  beforeEach(() => {
    resetConfig();
  });

  afterEach(() => {
    resetConfig();
  });

  describe('getClusterConfig', () => {
    it('should load cluster config from server_configs.py', () => {
      const config = getClusterConfig();

      expect(config).toBeDefined();
      expect(config.current_server_id).toBeDefined();
      expect(config.servers).toBeDefined();
      expect(typeof config.servers).toBe('object');
    });

    it('should contain multiple servers', () => {
      const config = getClusterConfig();
      const serverCount = Object.keys(config.servers).length;

      expect(serverCount).toBeGreaterThan(0);
    });

    it('should cache the config on subsequent calls', () => {
      const config1 = getClusterConfig();
      const config2 = getClusterConfig();

      // Should be the exact same object reference (cached)
      expect(config1).toBe(config2);
    });
  });

  describe('getCurrentServer', () => {
    it('should return current server info', () => {
      const server = getCurrentServer();

      expect(server).toBeDefined();
      expect(server.server_id).toBeDefined();
      expect(typeof server.server_id).toBe('string');
    });

    it('should have required server properties', () => {
      const server = getCurrentServer();

      // Check all required ServerInfo properties
      expect(server).toHaveProperty('server_id');
      expect(server).toHaveProperty('deployment_type');
      expect(server).toHaveProperty('sync_base_dir');
      expect(server).toHaveProperty('private_ips');
      expect(server).toHaveProperty('public_ips');
      expect(server).toHaveProperty('data_tx');
      expect(server).toHaveProperty('data_rx');
      expect(server).toHaveProperty('data_install');
      expect(server).toHaveProperty('has_fluentd_lm');
      expect(server).toHaveProperty('has_fluentd_gm');
      expect(server).toHaveProperty('is_global');
      expect(server).toHaveProperty('has_cloudflared');
      expect(server).toHaveProperty('disable_os_maintenance');
      expect(server).toHaveProperty('backup_servers');
    });

    it('should have correct property types', () => {
      const server = getCurrentServer();

      expect(typeof server.server_id).toBe('string');
      expect(typeof server.deployment_type).toBe('string');
      expect(Array.isArray(server.private_ips)).toBe(true);
      expect(Array.isArray(server.public_ips)).toBe(true);
      expect(Array.isArray(server.data_tx)).toBe(true);
      expect(Array.isArray(server.data_rx)).toBe(true);
      expect(Array.isArray(server.data_install)).toBe(true);
      expect(typeof server.has_fluentd_lm).toBe('boolean');
      expect(typeof server.has_fluentd_gm).toBe('boolean');
      expect(typeof server.is_global).toBe('boolean');
      expect(typeof server.has_cloudflared).toBe('boolean');
      expect(typeof server.disable_os_maintenance).toBe('boolean');
      expect(Array.isArray(server.backup_servers)).toBe(true);
    });
  });

  describe('getServerId', () => {
    it('should return a non-empty string', () => {
      const serverId = getServerId();

      expect(typeof serverId).toBe('string');
      expect(serverId.length).toBeGreaterThan(0);
    });

    it('should match current server id', () => {
      const serverId = getServerId();
      const server = getCurrentServer();

      expect(serverId).toBe(server.server_id);
    });
  });

  describe('getServerById', () => {
    it('should return server for valid id', () => {
      const currentId = getServerId();
      const server = getServerById(currentId);

      expect(server).toBeDefined();
      expect(server?.server_id).toBe(currentId);
    });

    it('should return undefined for invalid id', () => {
      const server = getServerById('non-existent-server-xyz');

      expect(server).toBeUndefined();
    });
  });

  describe('getAllServers', () => {
    it('should return an object with server entries', () => {
      const servers = getAllServers();

      expect(typeof servers).toBe('object');
      expect(Object.keys(servers).length).toBeGreaterThan(0);
    });

    it('should include the current server', () => {
      const servers = getAllServers();
      const currentId = getServerId();

      expect(servers[currentId]).toBeDefined();
    });

    it('should have server_id matching the key', () => {
      const servers = getAllServers();

      for (const [key, server] of Object.entries(servers)) {
        expect(server.server_id).toBe(key);
      }
    });
  });

  describe('getLocalVaultTypes', () => {
    it('should return an array', () => {
      const vaultTypes = getLocalVaultTypes();

      expect(Array.isArray(vaultTypes)).toBe(true);
    });

    it('should match data_install from current server', () => {
      const vaultTypes = getLocalVaultTypes();
      const server = getCurrentServer();

      expect(vaultTypes).toEqual(server.data_install);
    });

    it('should contain valid vault type strings', () => {
      const vaultTypes = getLocalVaultTypes();

      for (const vt of vaultTypes) {
        expect(typeof vt).toBe('string');
        // Vault types are 3-character codes
        expect(vt.length).toBe(3);
      }
    });
  });

  describe('getGlobalVaultTypes', () => {
    it('should return an array', () => {
      const vaultTypes = getGlobalVaultTypes();

      expect(Array.isArray(vaultTypes)).toBe(true);
    });

    it('should match data_tx from current server', () => {
      const vaultTypes = getGlobalVaultTypes();
      const server = getCurrentServer();

      expect(vaultTypes).toEqual(server.data_tx);
    });

    it('should contain valid vault type strings', () => {
      const vaultTypes = getGlobalVaultTypes();

      for (const vt of vaultTypes) {
        expect(typeof vt).toBe('string');
        // Vault types are 3-character codes
        expect(vt.length).toBe(3);
      }
    });
  });

  describe('hasFluentdLm', () => {
    it('should return a boolean', () => {
      const result = hasFluentdLm();

      expect(typeof result).toBe('boolean');
    });

    it('should match current server config', () => {
      const result = hasFluentdLm();
      const server = getCurrentServer();

      expect(result).toBe(server.has_fluentd_lm);
    });
  });

  describe('hasFluentdGm', () => {
    it('should return a boolean', () => {
      const result = hasFluentdGm();

      expect(typeof result).toBe('boolean');
    });

    it('should match current server config', () => {
      const result = hasFluentdGm();
      const server = getCurrentServer();

      expect(result).toBe(server.has_fluentd_gm);
    });
  });

  describe('isGlobalServer', () => {
    it('should return a boolean', () => {
      const result = isGlobalServer();

      expect(typeof result).toBe('boolean');
    });

    it('should match current server config', () => {
      const result = isGlobalServer();
      const server = getCurrentServer();

      expect(result).toBe(server.is_global);
    });
  });

  describe('Development server (us-e2-3) specific tests', () => {
    it('should identify us-e2-3 as current server in dev environment', () => {
      const serverId = getServerId();

      // This test is specific to the dev environment
      // If running on a different server, this test should be skipped
      if (serverId === 'us-e2-3') {
        const server = getCurrentServer();
        expect(server.data_tx).toContain('sma');
        expect(server.data_tx).toContain('smm');
        expect(server.data_install).toContain('sma');
        expect(server.data_install).toContain('smm');
        expect(server.has_fluentd_lm).toBe(true);
        expect(server.has_fluentd_gm).toBe(true);
      }
    });
  });
});
