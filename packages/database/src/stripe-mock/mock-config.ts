/**
 * Stripe Mock Configuration Manager
 *
 * Allows tests to configure mock Stripe service behavior:
 * - Inject artificial delays for UI testing
 * - Force deterministic failures for error handling tests
 * - Simulate 3DS requires_action scenarios
 *
 * IMPORTANT: Only active in test/development environments
 *
 * Follows the same pattern as SuiMockConfigManager.
 */

export interface StripeMockConfig {
  // Delays (milliseconds)
  chargeDelayMs?: number;
  createCustomerDelayMs?: number;
  createSetupIntentDelayMs?: number;

  // Deterministic failure injection
  forceChargeFailure?: boolean;
  forceChargeFailureMessage?: string;
  forceChargeRequiresAction?: boolean; // Simulate 3DS

  // Specific scenarios
  forceCardDeclined?: boolean;
  forceInsufficientFunds?: boolean;
}

class StripeMockConfigManager {
  private config: StripeMockConfig = {};
  private enabled = false;

  constructor() {
    const env = process.env.NODE_ENV || 'development';
    this.enabled = env === 'test' || env === 'development';
  }

  setConfig(newConfig: StripeMockConfig): void {
    if (!this.enabled) return;
    this.config = { ...this.config, ...newConfig };
    console.log('[STRIPE MOCK CONFIG] Updated:', this.config);
  }

  clearConfig(): void {
    if (!this.enabled) return;
    this.config = {};
    console.log('[STRIPE MOCK CONFIG] Cleared');
  }

  getConfig(): StripeMockConfig {
    return { ...this.config };
  }

  getDelay(operation: 'charge' | 'createCustomer' | 'createSetupIntent'): number {
    if (!this.enabled) return 0;
    const key = `${operation}DelayMs` as keyof StripeMockConfig;
    return (this.config[key] as number) || 0;
  }

  async applyDelay(operation: 'charge' | 'createCustomer' | 'createSetupIntent'): Promise<void> {
    const delay = this.getDelay(operation);
    if (delay > 0) {
      console.log(`[STRIPE MOCK] Sleeping ${delay}ms for ${operation}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  shouldFail(operation: 'charge'): string | undefined {
    if (!this.enabled) return undefined;

    if (this.config.forceChargeFailure) {
      return this.config.forceChargeFailureMessage || 'Forced charge failure (test mode)';
    }

    if (this.config.forceCardDeclined) {
      return 'Your card was declined.';
    }

    if (this.config.forceInsufficientFunds) {
      return 'Your card has insufficient funds.';
    }

    return undefined;
  }

  shouldRequireAction(): boolean {
    if (!this.enabled) return false;
    return this.config.forceChargeRequiresAction === true;
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

// Singleton instance
export const stripeMockConfig = new StripeMockConfigManager();
