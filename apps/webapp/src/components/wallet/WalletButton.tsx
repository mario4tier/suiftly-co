/**
 * Wallet connection button
 * Shows connect button or connected wallet address
 */

import { useCurrentAccount, useConnectWallet, useDisconnectWallet } from '@mysten/dapp-kit';

export function WalletButton() {
  const currentAccount = useCurrentAccount();
  const { mutate: connect } = useConnectWallet();
  const { mutate: disconnect } = useDisconnectWallet();

  if (currentAccount) {
    return (
      <div className="flex items-center gap-3">
        <div className="px-4 py-2 bg-gray-100 rounded-lg">
          <span className="text-sm text-gray-600">Connected:</span>
          <span className="ml-2 font-mono text-sm">
            {currentAccount.address.slice(0, 6)}...{currentAccount.address.slice(-4)}
          </span>
        </div>
        <button
          onClick={() => disconnect()}
          className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => connect({ wallet: { name: 'Sui Wallet' } })}
      className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-medium"
    >
      Connect Wallet
    </button>
  );
}
