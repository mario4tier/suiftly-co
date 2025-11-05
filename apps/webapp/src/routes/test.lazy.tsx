/**
 * Test page for Phase 8 authentication flow
 * Protected route that requires authentication
 */

import { createLazyFileRoute } from '@tanstack/react-router';
import { useAuth } from '../lib/auth';
import { ProtectedRoute } from '../components/auth/ProtectedRoute';
import { trpc } from '../lib/trpc';
import { useState } from 'react';

export const Route = createLazyFileRoute('/test')({
  component: TestPage,
});

function TestPage() {
  return (
    <ProtectedRoute>
      <TestPageContent />
    </ProtectedRoute>
  );
}

function TestPageContent() {
  const { user, logout } = useAuth();
  const [testResult, setTestResult] = useState<string>('');

  // Use React Query for the test endpoint (disabled by default, only fetch on button click)
  const testQuery = trpc.test.getProfile.useQuery(undefined, { enabled: false });

  const testProtectedEndpoint = async () => {
    try {
      const result = await testQuery.refetch();
      if (result.data) {
        setTestResult(JSON.stringify(result.data, null, 2));
      } else if (result.error) {
        setTestResult(`Error: ${result.error.message}`);
      }
    } catch (error: any) {
      setTestResult(`Error: ${error.message}`);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-4xl mx-auto">
        <div className="bg-white rounded-lg shadow p-6">
          <h1 className="text-3xl font-bold mb-6">Phase 8: Authentication Test</h1>

          {/* User Info */}
          <div className="mb-8 p-4 bg-green-50 border border-green-200 rounded">
            <h2 className="text-lg font-semibold mb-2 text-green-800">
              ✅ Authentication Successful
            </h2>
            <div className="space-y-1 text-sm">
              <div>
                <span className="font-medium">Wallet Address:</span>{' '}
                <code className="bg-gray-100 px-2 py-1 rounded">
                  {user?.walletAddress}
                </code>
              </div>
            </div>
          </div>

          {/* Test Actions */}
          <div className="space-y-4">
            <div>
              <h3 className="text-lg font-semibold mb-2">Test Actions</h3>
              <div className="flex gap-2">
                <button
                  onClick={testProtectedEndpoint}
                  className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
                >
                  Test Protected Endpoint
                </button>
                <button
                  onClick={logout}
                  className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600"
                >
                  Logout
                </button>
              </div>
            </div>

            {testResult && (
              <div className="p-4 bg-gray-100 rounded">
                <pre className="text-sm">{testResult}</pre>
              </div>
            )}
          </div>

          {/* Implementation Notes */}
          <div className="mt-8 p-4 bg-blue-50 border border-blue-200 rounded">
            <h3 className="text-lg font-semibold mb-2 text-blue-800">
              Phase 8 Implementation
            </h3>
            <ul className="list-disc list-inside space-y-1 text-sm text-blue-900">
              <li>✅ Zustand auth store with session management</li>
              <li>✅ Challenge-response authentication flow</li>
              <li>✅ JWT storage (access token)</li>
              <li>✅ Refresh token in httpOnly cookie</li>
              <li>✅ Auto-refresh on 401 errors</li>
              <li>✅ Protected route guards</li>
              <li>✅ Logout endpoint with token revocation</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
