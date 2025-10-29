/**
 * Wallet connection button
 * Shows connect button or connected wallet address
 */

import { useCurrentAccount, useConnectWallet, useDisconnectWallet, useWallets } from '@mysten/dapp-kit';
import { useState } from 'react';

export function WalletButton() {
  const currentAccount = useCurrentAccount();
  const wallets = useWallets();
  const { mutate: connect, error, isPending } = useConnectWallet();
  const { mutate: disconnect } = useDisconnectWallet();
  const [showWalletList, setShowWalletList] = useState(false);

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

  // Show wallet selection
  if (showWalletList) {
    return (
      <div className="bg-white rounded-lg shadow-lg p-6 max-w-md">
        <h3 className="text-lg font-semibold mb-4">Select Wallet</h3>

        {wallets.length === 0 ? (
          <div className="text-center py-6">
            <p className="text-gray-600 mb-4">
              No Sui wallets detected. Please install one:
            </p>
            <div className="space-y-2 text-sm">
              <a
                href="https://chrome.google.com/webstore/detail/sui-wallet/opcgpfmipidbgpenhmajoajpbobppdil"
                target="_blank"
                rel="noopener noreferrer"
                className="block px-4 py-2 bg-blue-50 text-blue-700 rounded hover:bg-blue-100 transition"
              >
                📥 Install Sui Wallet
              </a>
              <a
                href="https://suiet.app"
                target="_blank"
                rel="noopener noreferrer"
                className="block px-4 py-2 bg-purple-50 text-purple-700 rounded hover:bg-purple-100 transition"
              >
                📥 Install Suiet Wallet
              </a>
            </div>
            <button
              onClick={() => setShowWalletList(false)}
              className="mt-4 px-4 py-2 text-gray-600 hover:text-gray-800"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {wallets.map((wallet) => (
              <button
                key={wallet.name}
                onClick={() => {
                  connect({ wallet });
                  setShowWalletList(false);
                }}
                disabled={isPending}
                className="w-full px-4 py-3 bg-gray-50 hover:bg-gray-100 rounded-lg flex items-center gap-3 transition disabled:opacity-50"
              >
                {wallet.icon && (
                  <img src={wallet.icon} alt={wallet.name} className="w-8 h-8" />
                )}
                <span className="font-medium">{wallet.name}</span>
              </button>
            ))}
            <button
              onClick={() => setShowWalletList(false)}
              className="w-full px-4 py-2 text-gray-600 hover:text-gray-800 mt-2"
            >
              Cancel
            </button>
          </div>
        )}

        {error && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
            {error.message}
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      onClick={() => setShowWalletList(true)}
      disabled={isPending}
      className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-medium disabled:opacity-50"
    >
      {isPending ? 'Connecting...' : 'Connect Wallet'}
    </button>
  );
}
