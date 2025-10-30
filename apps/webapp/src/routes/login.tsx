/**
 * Login Page
 * Landing page for unauthenticated users
 */

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useCurrentAccount, useConnectWallet, useWallets } from '@mysten/dapp-kit';
import { connectMockWallet } from '../lib/mockWallet';
import { useAuth } from '../lib/auth';
import { Wallet, AlertCircle } from 'lucide-react';

export const Route = createFileRoute('/login')({
  component: LoginPage,
});

function LoginPage() {
  const { isAuthenticated, login } = useAuth();
  const navigate = useNavigate();
  const currentAccount = useCurrentAccount();
  const wallets = useWallets();
  const { mutate: connect, error, isPending } = useConnectWallet();
  const [mockAccount, setMockAccount] = useState<{address: string} | null>(null);
  const [pendingAuth, setPendingAuth] = useState(false);

  const connectedAccount = mockAccount || currentAccount;

  // Redirect to dashboard if already authenticated
  useEffect(() => {
    if (isAuthenticated) {
      navigate({ to: '/services/seal' });
    }
  }, [isAuthenticated, navigate]);

  // When wallet connects and we're pending auth, trigger login
  useEffect(() => {
    if (pendingAuth && connectedAccount && !isAuthenticated) {
      console.log('[LOGIN] Wallet connected, triggering authentication...');
      setPendingAuth(false);

      login().then((success) => {
        if (success) {
          // Navigation is handled by auth context after successful login
        }
      });
    }
  }, [pendingAuth, connectedAccount, isAuthenticated, login]);

  const handleWalletSelect = (wallet: any) => {
    if (isPending) return;
    console.log('[LOGIN] Requesting real wallet connection...');
    connect({ wallet });
    setPendingAuth(true);
  };

  const handleMockConnect = () => {
    console.log('[LOGIN] Connecting mock wallet...');
    const account = connectMockWallet();
    setMockAccount(account);
    setPendingAuth(true);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-indigo-50 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-white rounded-xl shadow-lg border border-gray-200 p-8">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-semibold text-gray-900 mb-2">
            Suiftly
          </h1>
          <p className="text-gray-600">
            Connect your wallet to access your dashboard
          </p>
        </div>

        {/* Wallet Options */}
        <div className="space-y-3 mb-6">
          {wallets.length === 0 ? (
            <div className="text-center py-8 px-4 bg-gray-50 rounded-lg border border-gray-200">
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
            wallets.map((wallet) => (
              <button
                key={wallet.name}
                onClick={() => handleWalletSelect(wallet)}
                disabled={isPending}
                className="w-full px-4 py-3 bg-white hover:bg-gray-50 rounded-lg flex items-center gap-3 transition border border-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {wallet.icon && (
                  <div className="w-6 h-6 flex items-center justify-center flex-shrink-0">
                    <img src={wallet.icon} alt={wallet.name} className="max-w-full max-h-full object-contain" />
                  </div>
                )}
                <span className="font-medium text-gray-900">{wallet.name}</span>
              </button>
            ))
          )}

          {/* Mock Wallet Option (Dev) */}
          {import.meta.env.DEV && (
            <>
              <div className="relative my-4">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-gray-200"></div>
                </div>
                <div className="relative flex justify-center text-xs">
                  <span className="bg-white px-2 text-gray-500 uppercase tracking-wider">Development</span>
                </div>
              </div>
              <button
                onClick={handleMockConnect}
                disabled={isPending}
                className="w-full px-4 py-3 bg-gray-50 hover:bg-gray-100 rounded-lg transition text-sm font-medium text-gray-700 border border-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Connect Mock Wallet
              </button>
            </>
          )}
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex gap-2 items-start">
            <AlertCircle className="h-4 w-4 text-red-600 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-700">{error.message}</p>
          </div>
        )}

        <div className="text-center text-xs text-gray-500">
          Secure authentication with your Sui wallet
        </div>
      </div>
    </div>
  );
}
