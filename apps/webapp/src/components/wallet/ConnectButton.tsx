/**
 * Connect Wallet Button
 * Used exclusively on the login page for initial wallet connection
 */

import { useCurrentAccount, useConnectWallet, useWallets } from '@mysten/dapp-kit';
import { useState, useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { connectMockWallet } from '../../lib/mockWallet';
import { useAuth } from '../../lib/auth';
import { Wallet, X } from 'lucide-react';

export function ConnectButton() {
  const currentAccount = useCurrentAccount();
  const wallets = useWallets();
  const navigate = useNavigate();
  const { mutate: connect, error, isPending } = useConnectWallet();
  const [showWalletModal, setShowWalletModal] = useState(false);
  const [mockAccount, setMockAccount] = useState<{address: string} | null>(null);
  const [pendingAuth, setPendingAuth] = useState(false);

  const { login, isAuthenticated } = useAuth();

  const connectedAccount = mockAccount || currentAccount;

  // When wallet connects and we're pending auth, trigger login
  useEffect(() => {
    if (pendingAuth && connectedAccount && !isAuthenticated) {
      console.log('[CONNECT] Wallet connected, triggering authentication...');
      setPendingAuth(false);

      login().then((success) => {
        if (success) {
          setShowWalletModal(false);
          // Navigation is handled by auth context after successful login
        }
      });
    }
  }, [pendingAuth, connectedAccount, isAuthenticated, login]);

  // If already authenticated, redirect (shouldn't happen normally)
  useEffect(() => {
    if (isAuthenticated) {
      navigate({ to: '/services/seal' });
    }
  }, [isAuthenticated, navigate]);

  const handleConnect = () => {
    setShowWalletModal(true);
  };

  const handleWalletSelect = (wallet: any) => {
    if (isPending) return;
    console.log('[CONNECT] Requesting real wallet connection...');
    connect({ wallet });
    setPendingAuth(true);
  };

  const handleMockConnect = () => {
    console.log('[CONNECT] Connecting mock wallet...');
    const account = connectMockWallet();
    setMockAccount(account);
    setPendingAuth(true);
  };

  return (
    <>
      <button
        type="button"
        onClick={handleConnect}
        className="flex items-center gap-2 px-4 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition text-sm font-medium"
      >
        <Wallet className="h-4 w-4" />
        <span>Connect Wallet</span>
      </button>

      {/* Wallet Selection Modal */}
      {showWalletModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40"
          onClick={() => setShowWalletModal(false)}
        >
          <div
            className="bg-white rounded-xl shadow-2xl p-6 max-w-md w-full mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-lg font-semibold text-gray-900">Connect Wallet</h3>
              <button
                onClick={() => setShowWalletModal(false)}
                className="text-gray-400 hover:text-gray-600 transition p-1"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {wallets.length === 0 ? (
              <div className="text-center py-8">
                <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Wallet className="h-8 w-8 text-gray-400" />
                </div>
                <p className="text-gray-600 mb-4 text-sm">No Sui wallets detected</p>
                <a
                  href="https://chrome.google.com/webstore/detail/sui-wallet/opcgpfmipidbgpenhmajoajpbobppdil"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition text-sm font-medium"
                >
                  Install Sui Wallet
                </a>
              </div>
            ) : (
              <div className="space-y-2 mb-4">
                {wallets.map((wallet) => (
                  <button
                    key={wallet.name}
                    onClick={() => handleWalletSelect(wallet)}
                    className="w-full px-4 py-3 bg-white hover:bg-gray-50 rounded-lg flex items-center gap-3 transition border border-gray-200"
                  >
                    {wallet.icon && <img src={wallet.icon} alt={wallet.name} className="w-8 h-8" />}
                    <span className="font-medium text-gray-900">{wallet.name}</span>
                  </button>
                ))}
              </div>
            )}

            {/* Mock Wallet Option (Dev) */}
            <div className="border-t border-gray-200 pt-4 mt-4">
              <p className="text-xs text-gray-500 mb-2">Development Mode</p>
              <button
                onClick={handleMockConnect}
                className="w-full px-4 py-3 bg-gray-50 hover:bg-gray-100 rounded-lg transition text-sm font-medium text-gray-700 border border-gray-200"
              >
                Connect Mock Wallet
              </button>
            </div>

            {error && (
              <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                {error.message}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}