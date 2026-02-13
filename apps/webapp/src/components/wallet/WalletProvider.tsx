/**
 * Wallet Provider setup with @mysten/dapp-kit-react
 * Supports both mock wallet (localStorage) and real Sui wallets
 */

import { DAppKitProvider } from '@mysten/dapp-kit-react';
import { createDAppKit } from '@mysten/dapp-kit-core';
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';

const networks = ['mainnet', 'testnet', 'devnet', 'localnet'] as const;

const dAppKit = createDAppKit({
  networks: [...networks],
  createClient: (network) => {
    const url = network === 'localnet'
      ? 'http://localhost:9000'
      : getJsonRpcFullnodeUrl(network);
    return new SuiJsonRpcClient({ url, network });
  },
  defaultNetwork: 'testnet',
  autoConnect: true,
  slushWalletConfig: null,
});

declare module '@mysten/dapp-kit-react' {
  interface Register {
    dAppKit: typeof dAppKit;
  }
}

interface WalletProviderProps {
  children: React.ReactNode;
}

export function WalletProvider({ children }: WalletProviderProps) {
  return (
    <DAppKitProvider dAppKit={dAppKit}>
      {children}
    </DAppKitProvider>
  );
}
