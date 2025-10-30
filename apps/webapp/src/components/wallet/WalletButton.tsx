/**
 * Wallet connection button
 * Standard Web3 UX: Modal for wallet selection, dropdown menu for connected state
 */

import { useCurrentAccount, useConnectWallet, useDisconnectWallet, useWallets } from '@mysten/dapp-kit';
import { useState, useEffect, useRef } from 'react';
import { connectMockWallet, disconnectMockWallet } from '../../lib/mockWallet';
import { useAuth } from '../../lib/auth';

export function WalletButton() {
  const currentAccount = useCurrentAccount();
  const wallets = useWallets();
  const { mutate: connect, error, isPending } = useConnectWallet();
  const { mutate: disconnect } = useDisconnectWallet();
  const [showWalletModal, setShowWalletModal] = useState(false);
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const [mockAccount, setMockAccount] = useState<{address: string} | null>(null);

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
    };

    performDisconnect();
  }, [triggerDisconnect, isMock, logout, disconnect]);

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
          className="px-4 py-2 bg-green-100 text-green-800 rounded-lg hover:bg-green-200 transition font-mono text-sm font-medium"
        >
          {user.walletAddress.slice(0, 6)}...{user.walletAddress.slice(-4)}
          {isMock && <span className="ml-2 text-xs">(MOCK)</span>}
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
              <div className="p-2">
                <div className="px-3 py-2 text-xs text-gray-500 border-b border-gray-100 mb-1">
                  Connected {isMock && '(Mock)'}
                </div>

                {/* Billing */}
                <a
                  href="/billing"
                  onClick={() => setShowAccountMenu(false)}
                  className="w-full text-left px-3 py-2 hover:bg-gray-100 rounded text-sm flex items-center gap-2"
                >
                  <span>💳</span>
                  <span>Billing & Balance</span>
                </a>

                {/* Copy Address */}
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(user.walletAddress);
                    setShowAccountMenu(false);
                  }}
                  className="w-full text-left px-3 py-2 hover:bg-gray-100 rounded text-sm flex items-center gap-2"
                >
                  <span>📋</span>
                  <span>Copy Address</span>
                </button>

                {/* Disconnect */}
                <button
                  onClick={() => {
                    disconnectRequestedRef.current = true;
                    setTriggerDisconnect(prev => prev + 1);
                  }}
                  className="w-full text-left px-3 py-2 hover:bg-red-50 text-red-600 rounded text-sm flex items-center gap-2 border-t border-gray-100 mt-1 pt-2"
                >
                  <span>🚪</span>
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
  // Button stays visible during connection/authentication (just greyed out if modal open)
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setShowWalletModal(true);
        }}
        className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-medium"
      >
        Connect Wallet
      </button>

      {/* Wallet Selection Modal */}
      {showWalletModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-30"
          onClick={() => setShowWalletModal(false)}
        >
          {/* Modal Content - white box */}
          <div
            className="bg-white rounded-xl shadow-2xl p-6 max-w-md w-full mx-4"
            onClick={(e) => e.stopPropagation()}
          >
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-xl font-semibold">Connect Wallet</h3>
                <button
                  onClick={() => setShowWalletModal(false)}
                  className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
                >
                  ×
                </button>
              </div>


              {wallets.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-gray-600 mb-4">No Sui wallets detected.</p>
                  <a
                    href="https://chrome.google.com/webstore/detail/sui-wallet/opcgpfmipidbgpenhmajoajpbobppdil"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block px-6 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition"
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
                        if (isPending) return; // Prevent double-click, but don't disable button
                        console.log('[WALLET] Requesting real wallet connection...');
                        connect({ wallet });
                        setPendingAuth(true);
                      }}
                      className="w-full px-4 py-3 bg-gray-50 hover:bg-gray-100 rounded-lg flex items-center gap-3 transition border border-gray-200"
                    >
                      {wallet.icon && <img src={wallet.icon} alt={wallet.name} className="w-8 h-8" />}
                      <span className="font-medium">{wallet.name}</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Mock Wallet Option (Dev) */}
              <div className="border-t border-gray-200 pt-4 mt-4">
                <p className="text-xs text-gray-500 mb-2">Development Mode:</p>
                <button
                  onClick={() => {
                    console.log('[WALLET] Connecting mock wallet...');
                    const account = connectMockWallet();
                    setMockAccount(account);
                    setPendingAuth(true); // Mark as pending - will trigger immediately since mockAccount is sync
                  }}
                  className="w-full px-4 py-3 bg-gray-100 hover:bg-gray-200 rounded-lg transition text-sm font-medium border border-gray-300"
                >
                  Connect Mock Wallet
                </button>
              </div>

            {error && (
              <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
                {error.message}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
