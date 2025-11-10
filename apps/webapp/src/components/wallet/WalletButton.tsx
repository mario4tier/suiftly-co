/**
 * Wallet connection button
 * Premium design with professional styling
 */

import { useCurrentAccount, useConnectWallet, useDisconnectWallet, useWallets } from '@mysten/dapp-kit';
import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { connectMockWallet, disconnectMockWallet } from '../../lib/mockWallet';
import { useAuth } from '../../lib/auth';
import {
  Wallet,
  Copy,
  CreditCard,
  LogOut,
  ChevronDown,
  X
} from 'lucide-react';

export function WalletButton() {
  const currentAccount = useCurrentAccount();
  const wallets = useWallets();
  const navigate = useNavigate();
  const { mutate: connect, error, isPending } = useConnectWallet();
  const { mutate: disconnect } = useDisconnectWallet();
  const [showWalletModal, setShowWalletModal] = useState(false);
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const [mockAccount, setMockAccount] = useState<{address: string} | null>(null);
  const [copySuccess, setCopySuccess] = useState(false);

  // Track if we're waiting for wallet approval to complete
  const [pendingAuth, setPendingAuth] = useState(false);

  // Request flags
  const disconnectRequestedRef = useRef(false);
  const [triggerDisconnect, setTriggerDisconnect] = useState(0);

  const { user, isAuthenticated, login, logout } = useAuth();

  const connectedAccount = mockAccount || currentAccount;
  const isMock = !!mockAccount;

  // Separate useEffect: Trigger login when wallet actually connects (currentAccount populated)
  useEffect(() => {
    // Only trigger if we're pending auth AND wallet is now connected AND not already authenticated
    if (pendingAuth && connectedAccount && !isAuthenticated) {
      console.log('[WALLET] Wallet approved and connected, triggering sign...');
      setPendingAuth(false); // Clear pending flag

      login().then((success) => {
        if (success) {
          setShowWalletModal(false);
        }
      });
    }
  }, [pendingAuth, connectedAccount, isAuthenticated, login]);

  // Handle disconnect
  useEffect(() => {
    if (!disconnectRequestedRef.current) return;
    disconnectRequestedRef.current = false;

    const performDisconnect = async () => {
      await logout(); // This now clears mock wallet from localStorage

      // Clear wallet connection (mock or real)
      if (isMock) {
        setMockAccount(null); // Clear component state
      } else {
        disconnect(); // Disconnect real wallet
      }

      setShowAccountMenu(false);

      // Redirect to login page after disconnect
      navigate({ to: '/login' });
    };

    performDisconnect();
  }, [triggerDisconnect, isMock, logout, disconnect, navigate]);

  const handleCopyAddress = () => {
    if (user) {
      navigator.clipboard.writeText(user.walletAddress);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    }
  };

  // AUTHENTICATED - Show address with dropdown menu
  if (isAuthenticated && user) {
    return (
      <div className="relative">
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setShowAccountMenu(!showAccountMenu);
          }}
          className="flex items-center gap-2 px-3 py-1.5 bg-white border border-gray-200 rounded-lg hover:border-gray-300 transition text-sm"
        >
          <div className="w-6 h-6 bg-gradient-to-br from-green-400 to-green-500 rounded-full flex items-center justify-center">
            <Wallet className="h-3 w-3 text-white" />
          </div>
          <span className="font-mono text-gray-700">
            {user.walletAddress.slice(0, 6)}...{user.walletAddress.slice(-4)}
          </span>
          {isMock && (
            <span className="text-[10px] px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded font-medium">
              MOCK
            </span>
          )}
          <ChevronDown className="h-3 w-3 text-gray-400" />
        </button>

        {/* Dropdown Menu */}
        {showAccountMenu && (
          <>
            {/* Backdrop to close menu */}
            <div
              className="fixed inset-0 z-10"
              onClick={() => setShowAccountMenu(false)}
            />
            {/* Menu */}
            <div className="absolute right-0 mt-2 w-64 bg-white border border-gray-200 rounded-lg shadow-lg z-20">
              <div className="p-1.5">
                <div className="px-3 py-2 border-b border-gray-100 mb-1">
                  <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wider mb-1">
                    Connected Account
                  </p>
                  <p className="text-xs font-mono text-gray-700">
                    {user.walletAddress.slice(0, 10)}...{user.walletAddress.slice(-8)}
                  </p>
                </div>

                {/* Billing */}
                <Link
                  to="/billing"
                  onClick={() => setShowAccountMenu(false)}
                  className="flex items-center gap-2.5 px-3 py-2 hover:bg-gray-50 rounded text-sm text-gray-700 transition"
                >
                  <CreditCard className="h-4 w-4 text-gray-400" />
                  <span>Billing & Balance</span>
                </Link>

                {/* Copy Address */}
                <button
                  onClick={() => {
                    handleCopyAddress();
                    setShowAccountMenu(false);
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-gray-50 rounded text-sm text-gray-700 transition"
                >
                  <Copy className="h-4 w-4 text-gray-400" />
                  <span>{copySuccess ? 'Copied!' : 'Copy Address'}</span>
                </button>

                {/* Divider */}
                <div className="border-t border-gray-100 my-1" />

                {/* Disconnect */}
                <button
                  onClick={() => {
                    disconnectRequestedRef.current = true;
                    setTriggerDisconnect(prev => prev + 1);
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-red-50 text-red-600 rounded text-sm transition"
                >
                  <LogOut className="h-4 w-4" />
                  <span>Disconnect</span>
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  // NO WALLET or CONNECTING - Show connect button
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setShowWalletModal(true);
        }}
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
          {/* Modal Content */}
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
                    onClick={() => {
                      if (isPending) return;
                      console.log('[WALLET] Requesting real wallet connection...');
                      connect({ wallet });
                      setPendingAuth(true);
                    }}
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
                onClick={() => {
                  console.log('[WALLET] Connecting mock wallet...');
                  const account = connectMockWallet();
                  setMockAccount(account);
                  setPendingAuth(true);
                }}
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