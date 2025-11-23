/**
 * Sui Mock Configuration Manager
 *
 * Allows tests to configure mock Sui service behavior:
 * - Inject artificial delays for UI testing
 * - Force deterministic failures for error handling tests
 *
 * IMPORTANT: Only active in test/development environments
 *
 * Usage:
 *   POST /test/sui/config { chargeDelayMs: 3000, forceChargeFailure: true }
 *   POST /test/sui/config/clear
 */

export interface SuiMockConfig {
  // Delays (milliseconds) - simulate blockchain latency
  chargeDelayMs?: number;
  depositDelayMs?: number;
  withdrawDelayMs?: number;
  creditDelayMs?: number;
  getAccountDelayMs?: number;

  // Deterministic failure injection
  forceChargeFailure?: boolean;
  forceChargeFailureMessage?: string;
  forceDepositFailure?: boolean;
  forceDepositFailureMessage?: string;
  forceWithdrawFailure?: boolean;
  forceWithdrawFailureMessage?: string;
  forceCreditFailure?: boolean;
  forceCreditFailureMessage?: string;

  // Specific failure scenarios (deterministic)
  forceInsufficientBalance?: boolean;
  forceSpendingLimitExceeded?: boolean;
  forceAccountNotFound?: boolean;
}

class SuiMockConfigManager {
  private config: SuiMockConfig = {};
  private enabled = false;

  constructor() {
    // Only enable in test/development
    const env = process.env.NODE_ENV || 'development';
    this.enabled = env === 'test' || env === 'development';
  }

  /**
   * Set mock configuration
   * Merges with existing config (use clear() to reset)
   */
  setConfig(newConfig: SuiMockConfig): void {
    if (!this.enabled) return;
    this.config = { ...this.config, ...newConfig };
    console.log('[SUI MOCK CONFIG] Updated:', this.config);
  }

  /**
   * Clear all configuration (reset to defaults)
   */
  clearConfig(): void {
    if (!this.enabled) return;
    this.config = {};
    console.log('[SUI MOCK CONFIG] Cleared');
  }

  /**
   * Get current configuration
   */
  getConfig(): SuiMockConfig {
    return { ...this.config };
  }

  /**
   * Get delay for specific operation
   */
  getDelay(operation: 'charge' | 'deposit' | 'withdraw' | 'credit' | 'getAccount'): number {
    if (!this.enabled) return 0;
    const key = `${operation}DelayMs` as keyof SuiMockConfig;
    return (this.config[key] as number) || 0;
  }

  /**
   * Apply delay for operation (if configured)
   */
  async applyDelay(operation: 'charge' | 'deposit' | 'withdraw' | 'credit' | 'getAccount'): Promise<void> {
    const delay = this.getDelay(operation);
    if (delay > 0) {
      console.log(`[SUI MOCK] Sleeping ${delay}ms for ${operation}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  /**
   * Check if operation should fail (deterministic)
   * Returns error message if should fail, undefined otherwise
   */
  shouldFail(operation: 'charge' | 'deposit' | 'withdraw' | 'credit'): string | undefined {
    if (!this.enabled) return undefined;

    // Check operation-specific forced failure
    const forceKey = `force${operation.charAt(0).toUpperCase() + operation.slice(1)}Failure` as keyof SuiMockConfig;
    const messageKey = `force${operation.charAt(0).toUpperCase() + operation.slice(1)}FailureMessage` as keyof SuiMockConfig;

    if (this.config[forceKey]) {
      return (this.config[messageKey] as string) || `Forced ${operation} failure (test mode)`;
    }

    return undefined;
  }

  /**
   * Check if specific failure scenario is enabled
   */
  isScenarioEnabled(scenario: 'insufficientBalance' | 'spendingLimitExceeded' | 'accountNotFound'): boolean {
    if (!this.enabled) return false;

    switch (scenario) {
      case 'insufficientBalance':
        return this.config.forceInsufficientBalance === true;
      case 'spendingLimitExceeded':
        return this.config.forceSpendingLimitExceeded === true;
      case 'accountNotFound':
        return this.config.forceAccountNotFound === true;
      default:
        return false;
    }
  }

  /**
   * Check if mock config is enabled (test/dev only)
   */
  isEnabled(): boolean {
    return this.enabled;
  }
}

// Singleton instance
export const suiMockConfig = new SuiMockConfigManager();
