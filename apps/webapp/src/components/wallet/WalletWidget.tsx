/**
 * Wallet Widget
 * Shows connected wallet address and account menu for authenticated users
 */

import { useCurrentAccount, useDisconnectWallet } from '@mysten/dapp-kit';
import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { disconnectMockWallet } from '../../lib/mockWallet';
import { useAuth } from '../../lib/auth';
import {
  Wallet,
  Copy,
  CreditCard,
  LogOut,
  ChevronDown
} from 'lucide-react';

export function WalletWidget() {
  const currentAccount = useCurrentAccount();
  const navigate = useNavigate();
  const { mutate: disconnect } = useDisconnectWallet();
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);
  const { user, isAuthenticated, logout } = useAuth();

  // Check if we're using mock wallet by examining localStorage
  const mockWallet = localStorage.getItem('mock-wallet');
  const isMock = !!mockWallet && !currentAccount;

  // If not authenticated, we shouldn't show this widget
  if (!isAuthenticated || !user) {
    console.warn('[WalletWidget] Rendered but user not authenticated');
    return null;
  }

  const handleCopyAddress = () => {
    if (user) {
      navigator.clipboard.writeText(user.walletAddress);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    }
  };

  const handleDisconnect = async () => {
    await logout(); // This clears session and mock wallet from localStorage

    // Clear wallet connection (mock or real)
    if (isMock) {
      disconnectMockWallet();
    } else {
      disconnect(); // Disconnect real wallet
    }

    setShowAccountMenu(false);

    // Redirect to login page after disconnect
    navigate({ to: '/login' });
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setShowAccountMenu(!showAccountMenu);
        }}
        className="flex items-center gap-2 px-3 py-1.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg hover:border-gray-300 dark:hover:border-gray-600 transition text-sm"
      >
        <div className="w-6 h-6 bg-gradient-to-br from-green-400 to-green-500 rounded-full flex items-center justify-center">
          <Wallet className="h-3 w-3 text-white" />
        </div>
        <span className="font-mono text-gray-700 dark:text-gray-200">
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
          <div className="absolute right-0 mt-2 w-64 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-20">
            <div className="p-1.5">
              <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-700 mb-1">
                <p className="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1">
                  Connected Account
                </p>
                <p className="text-xs font-mono text-gray-700 dark:text-gray-200">
                  {user.walletAddress.slice(0, 10)}...{user.walletAddress.slice(-8)}
                </p>
              </div>

              {/* Billing */}
              <Link
                to="/billing"
                onClick={() => setShowAccountMenu(false)}
                className="flex items-center gap-2.5 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 rounded text-sm text-gray-700 dark:text-gray-200 transition"
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
                className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 rounded text-sm text-gray-700 dark:text-gray-200 transition"
              >
                <Copy className="h-4 w-4 text-gray-400" />
                <span>{copySuccess ? 'Copied!' : 'Copy Address'}</span>
              </button>

              {/* Divider */}
              <div className="border-t border-gray-100 dark:border-gray-700 my-1" />

              {/* Disconnect */}
              <button
                onClick={handleDisconnect}
                className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400 rounded text-sm transition"
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