/**
 * Mock wallet for development
 * No browser extension needed - uses localStorage
 * Based on AUTHENTICATION_DESIGN.md mock wallet spec
 */

const MOCK_WALLET_KEY = 'suiftly_mock_wallet';

export interface MockWalletAccount {
  address: string;
  connected: boolean;
}

/**
 * Get current mock wallet state from localStorage
 */
export function getMockWallet(): MockWalletAccount | null {
  const stored = localStorage.getItem(MOCK_WALLET_KEY);
  if (!stored) return null;
  return JSON.parse(stored);
}

/**
 * Connect mock wallet (generates random address)
 */
export function connectMockWallet(): MockWalletAccount {
  // Generate random Sui address (0x + 64 hex chars)
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const address = '0x' + Array.from(randomBytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  const account: MockWalletAccount = {
    address,
    connected: true,
  };

  localStorage.setItem(MOCK_WALLET_KEY, JSON.stringify(account));
  return account;
}

/**
 * Disconnect mock wallet
 */
export function disconnectMockWallet(): void {
  localStorage.removeItem(MOCK_WALLET_KEY);
}

/**
 * Check if we're in mock mode
 */
export function isMockMode(): boolean {
  return import.meta.env.VITE_MOCK_WALLET === 'true' || import.meta.env.DEV;
}
