/**
 * Landing page (/)
 * Phase 7: With wallet integration
 */

import { createFileRoute, Link } from '@tanstack/react-router';
import { WalletButton } from '../components/wallet/WalletButton';

export const Route = createFileRoute('/')({
  component: Index,
});

function Index() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-indigo-50">
      <div className="container mx-auto px-4 py-16">
        <div className="max-w-4xl mx-auto text-center">
          {/* Header */}
          <h1 className="text-6xl font-bold text-gray-900 mb-4">
            Suiftly
          </h1>
          <p className="text-2xl text-gray-600 mb-12">
            Self-Service Sui Infrastructure
          </p>

          {/* Wallet Connection */}
          <div className="mb-12">
            <WalletButton />
          </div>

          {/* Features */}
          <div className="grid md:grid-cols-3 gap-6 mb-12">
            <div className="bg-white rounded-lg p-6 shadow-md">
              <div className="text-3xl mb-3">🔐</div>
              <h3 className="font-semibold mb-2">Wallet Auth</h3>
              <p className="text-sm text-gray-600">
                Sign in with your Sui wallet - no passwords needed
              </p>
            </div>
            <div className="bg-white rounded-lg p-6 shadow-md">
              <div className="text-3xl mb-3">⚡</div>
              <h3 className="font-semibold mb-2">Seal Storage</h3>
              <p className="text-sm text-gray-600">
                Decentralized storage with Walrus protocol
              </p>
            </div>
            <div className="bg-white rounded-lg p-6 shadow-md">
              <div className="text-3xl mb-3">📊</div>
              <h3 className="font-semibold mb-2">Usage-Based Billing</h3>
              <p className="text-sm text-gray-600">
                Pay only for what you use with Web3 escrow
              </p>
            </div>
          </div>

          {/* Phase Status */}
          <div className="bg-green-50 border border-green-200 rounded-lg p-6 max-w-2xl mx-auto">
            <p className="text-green-800 font-medium mb-3">
              ✅ Phases 0-7 Complete
            </p>
            <div className="text-sm text-left space-y-1 text-green-700">
              <p>✓ Server setup & database (13 tables)</p>
              <p>✓ Type-safe API with tRPC</p>
              <p>✓ Authentication backend (mock mode)</p>
              <p>✓ React frontend with routing</p>
              <p>✓ Wallet integration (@mysten/dapp-kit)</p>
            </div>
            <div className="mt-4 pt-4 border-t border-green-200">
              <Link
                to="/wallet-demo"
                className="inline-block px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition"
              >
                Try Wallet Demo →
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
