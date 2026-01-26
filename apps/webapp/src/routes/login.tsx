/**
 * Login Page
 * Landing page for unauthenticated users
 */

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useCurrentAccount, useConnectWallet, useDisconnectWallet, useWallets } from '@mysten/dapp-kit';
import { connectMockWallet, MOCK_WALLET_ADDRESSES } from '../lib/mockWallet';
import { useAuth } from '../lib/auth';
import { mockAuth } from '../lib/config';
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
  const { mutate: disconnect } = useDisconnectWallet();
  const [mockAccount, setMockAccount] = useState<{address: string} | null>(null);
  const [pendingAuth, setPendingAuth] = useState(false);

  const connectedAccount = mockAccount || currentAccount;

  // Redirect to dashboard if already authenticated
  useEffect(() => {
    if (isAuthenticated) {
      navigate({ to: '/dashboard' });
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
    console.log('[LOGIN] Requesting real wallet connection...');
    // Disconnect any pending/existing connection to close old dialog
    disconnect();
    // Open fresh wallet dialog
    setTimeout(() => {
      connect({ wallet });
      setPendingAuth(true);
    }, 100); // Small delay to ensure disconnect completes
  };

  const handleMockConnect = (walletIndex: 0 | 1) => {
    console.log(`[LOGIN] Connecting mock wallet ${walletIndex}...`);
    const account = connectMockWallet(walletIndex);
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
        <div className="mb-6">
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
            <div className="flex flex-wrap gap-3 justify-center">
              {wallets.map((wallet) => (
                <button
                  key={wallet.name}
                  onClick={() => handleWalletSelect(wallet)}
                  className="px-4 py-3 bg-white hover:bg-blue-50 hover:border-blue-300 rounded-lg flex flex-col items-center gap-2 transition-all border border-gray-200 active:scale-95 hover:shadow-md"
                  style={{ width: '140px' }}
                >
                  {wallet.icon && (
                    <div className="flex items-center justify-center flex-shrink-0" style={{ width: '32px', height: '32px' }}>
                      <img
                        src={wallet.icon}
                        alt={wallet.name}
                        style={{ width: '32px', height: '32px', objectFit: 'contain' }}
                      />
                    </div>
                  )}
                  <span className="font-medium text-gray-900 text-sm text-center">{wallet.name}</span>
                </button>
              ))}
            </div>
          )}

          {/* Mock Wallet Options (Dev) */}
          {mockAuth && (
            <>
              <div className="relative my-6">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-gray-200"></div>
                </div>
                <div className="relative flex justify-center text-xs">
                  <span className="bg-white px-2 text-gray-500 uppercase tracking-wider">Development</span>
                </div>
              </div>
              <div className="flex justify-center gap-3">
                <button
                  onClick={() => handleMockConnect(0)}
                  className="px-4 py-3 bg-gray-50 hover:bg-gray-100 hover:border-gray-300 rounded-lg transition-all text-sm text-gray-700 border border-gray-200 active:scale-95 hover:shadow-md flex flex-col items-center gap-1"
                  style={{ width: '140px' }}
                >
                  <div className="flex items-center justify-center flex-shrink-0" style={{ width: '32px', height: '32px' }}>
                    <Wallet className="h-6 w-6 text-gray-600" />
                  </div>
                  <span className="font-medium">Mock Wallet 0</span>
                  <span className="text-[10px] text-gray-400 font-mono">
                    {MOCK_WALLET_ADDRESSES[0].slice(0, 6)}...{MOCK_WALLET_ADDRESSES[0].slice(-4)}
                  </span>
                </button>
                <button
                  onClick={() => handleMockConnect(1)}
                  className="px-4 py-3 bg-amber-50 hover:bg-amber-100 hover:border-amber-300 rounded-lg transition-all text-sm text-gray-700 border border-amber-200 active:scale-95 hover:shadow-md flex flex-col items-center gap-1"
                  style={{ width: '140px' }}
                >
                  <div className="flex items-center justify-center flex-shrink-0" style={{ width: '32px', height: '32px' }}>
                    <Wallet className="h-6 w-6 text-amber-600" />
                  </div>
                  <span className="font-medium">Mock Wallet 1</span>
                  <span className="text-[10px] text-gray-400 font-mono">
                    {MOCK_WALLET_ADDRESSES[1].slice(0, 6)}...{MOCK_WALLET_ADDRESSES[1].slice(-4)}
                  </span>
                </button>
              </div>
            </>
          )}
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex gap-2 items-start">
            <AlertCircle className="h-4 w-4 text-red-600 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-700">{error.message}</p>
          </div>
        )}

        <div className="text-center text-sm text-gray-500">
          Secure authentication with your Sui wallet
        </div>
      </div>
    </div>
  );
}
