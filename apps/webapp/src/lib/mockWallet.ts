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
 * Connect mock wallet (uses consistent test address)
 */
export function connectMockWallet(): MockWalletAccount {
  // Use consistent test address for stable development
  // This prevents creating new customers on every connect
  // Valid Sui address format (0x + 64 hex chars)
  const address = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

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
  return import.meta.env.VITE_MOCK_WALLET === 'true';
}

/**
 * Mock sign message function
 * Generates fake signature for development (backend with MOCK_AUTH=true accepts any signature)
 */
export function mockSignMessage(message: Uint8Array): { signature: string } {
  const messageStr = new TextDecoder().decode(message);
  const fakeSignature = btoa(`mock_signature_for_${messageStr.slice(0, 20)}`);

  return {
    signature: fakeSignature,
  };
}
