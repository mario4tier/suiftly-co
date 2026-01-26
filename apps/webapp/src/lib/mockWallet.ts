/**
 * Mock wallet for development
 * No browser extension needed - uses localStorage
 * Based on AUTHENTICATION_DESIGN.md mock wallet spec
 */

const MOCK_WALLET_KEY = 'suiftly_mock_wallet';

// Mock wallet addresses (matching test-data.ts MOCK_WALLET_ADDRESS_0/1)
// Wallet 0: Obvious test pattern (0xaaa...) - for unit tests
// Wallet 1: Realistic-looking address - for demos/screenshots
export const MOCK_WALLET_ADDRESSES = {
  0: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  1: '0x7a3f8c2e5d91b6a4f0e82c3d9b7a5f1e6c8d2a4b9e3f7c1d5a8b2e6f0c4d8a2b',
} as const;

export type MockWalletIndex = keyof typeof MOCK_WALLET_ADDRESSES;

export interface MockWalletAccount {
  address: string;
  connected: boolean;
  walletIndex?: MockWalletIndex;
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
 * Connect mock wallet
 * @param walletIndex - 0 for test address (0xaaa...), 1 for realistic address
 */
export function connectMockWallet(walletIndex: MockWalletIndex = 0): MockWalletAccount {
  const address = MOCK_WALLET_ADDRESSES[walletIndex];

  const account: MockWalletAccount = {
    address,
    connected: true,
    walletIndex,
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
