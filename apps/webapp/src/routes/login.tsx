/**
 * Login Page
 * Landing page for unauthenticated users
 */

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { ConnectButton } from '../components/wallet/ConnectButton';
import { useAuth } from '../lib/auth';

export const Route = createFileRoute('/login')({
  component: LoginPage,
});

function LoginPage() {
  const { isAuthenticated } = useAuth();
  const navigate = useNavigate();

  // Redirect to dashboard if already authenticated
  useEffect(() => {
    if (isAuthenticated) {
      navigate({ to: '/' });
    }
  }, [isAuthenticated, navigate]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-indigo-50 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-white rounded-xl shadow-lg border border-gray-200 p-8">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-semibold text-gray-900 mb-2">
            Suiftly
          </h1>
          <p className="text-gray-600">
            Sign in to access your dashboard
          </p>
        </div>

        <div className="flex justify-center mb-6">
          <ConnectButton />
        </div>

        <div className="text-center text-xs text-gray-500">
          Secure authentication with your Sui wallet
        </div>
      </div>
    </div>
  );
}
