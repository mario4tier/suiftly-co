/**
 * Test delay manager
 * Allows tests to inject artificial delays for UI testing
 *
 * IMPORTANT: Only active in non-production environments (per system.conf)
 */

import { isTestFeaturesEnabled } from '@mhaxbe/system-config';

interface DelayConfig {
  validateSubscription?: number; // ms
  subscribe?: number; // ms
  sealFormMutation?: number; // ms - applies to all seal form mutations (toggle, config update, etc.)
  tierChange?: number; // ms - applies to tier upgrade/downgrade operations (Phase 1C)
  cancellation?: number; // ms - applies to cancellation operations (Phase 1C)
  postToggle?: number; // ms - delay AFTER toggle mutation completes, BEFORE GM sync (for observing "Updating..." state)
  // Add more endpoints as needed
}

class TestDelayManager {
  private delays: DelayConfig = {};
  private enabled = false;

  constructor() {
    // Only enable in non-production environments (per system.conf)
    this.enabled = isTestFeaturesEnabled();
  }

  /**
   * Set delays for specific endpoints
   */
  setDelays(config: DelayConfig) {
    if (!this.enabled) return;
    this.delays = { ...this.delays, ...config };
    console.log('[TEST DELAYS] Updated:', this.delays);
  }

  /**
   * Clear all delays
   */
  clearDelays() {
    if (!this.enabled) return;
    this.delays = {};
    console.log('[TEST DELAYS] Cleared');
  }

  /**
   * Get delay for specific endpoint
   */
  getDelay(endpoint: keyof DelayConfig): number {
    if (!this.enabled) return 0;
    return this.delays[endpoint] || 0;
  }

  /**
   * Sleep for specified delay (if configured)
   */
  async applyDelay(endpoint: keyof DelayConfig) {
    const delay = this.getDelay(endpoint);
    if (delay > 0) {
      console.log(`[TEST DELAYS] Sleeping ${delay}ms for ${endpoint}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// Singleton instance
export const testDelayManager = new TestDelayManager();
