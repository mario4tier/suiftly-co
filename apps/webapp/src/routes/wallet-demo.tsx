/**
 * Wallet demo page
 * Shows wallet connection with @mysten/dapp-kit
 */

import { createFileRoute } from '@tanstack/react-router';
import { WalletButton } from '../components/wallet/WalletButton';
import { useCurrentAccount } from '@mysten/dapp-kit';

export const Route = createFileRoute('/wallet-demo')({
  component: WalletDemo,
});

function WalletDemo() {
  const currentAccount = useCurrentAccount();

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50">
      <div className="container mx-auto px-4 py-16">
        <div className="max-w-2xl mx-auto">
          <h1 className="text-4xl font-bold text-gray-900 mb-2">
            Wallet Integration Demo
          </h1>
          <p className="text-gray-600 mb-8">
            Phase 7: @mysten/dapp-kit wallet connection
          </p>

          <div className="bg-white rounded-xl shadow-lg p-8">
            <div className="mb-6">
              <h2 className="text-xl font-semibold mb-4">Connection Status</h2>
              {currentAccount ? (
                <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                  <p className="text-green-800 font-medium mb-2">
                    ✅ Wallet Connected
                  </p>
                  <div className="space-y-2 text-sm">
                    <div>
                      <span className="text-gray-600">Address:</span>
                      <code className="ml-2 font-mono bg-gray-100 px-2 py-1 rounded">
                        {currentAccount.address}
                      </code>
                    </div>
                    <div>
                      <span className="text-gray-600">Chain:</span>
                      <span className="ml-2 font-medium">
                        {currentAccount.chains[0] || 'Unknown'}
                      </span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                  <p className="text-gray-600">
                    No wallet connected. Click the button below to connect.
                  </p>
                </div>
              )}
            </div>

            <div className="flex justify-center">
              <WalletButton />
            </div>

            <div className="mt-8 pt-8 border-t border-gray-200">
              <h3 className="text-lg font-semibold mb-3">Next Steps</h3>
              <ul className="space-y-2 text-sm text-gray-600">
                <li>✅ Phase 6: Frontend foundation complete</li>
                <li>✅ Phase 7: Wallet integration complete</li>
                <li>⏭️ Phase 8: Full authentication flow (connect wallet → sign → get JWT)</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
