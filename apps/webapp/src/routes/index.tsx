/**
 * Landing page (/)
 * Simple welcome page for Phase 6
 */

import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  component: Index,
});

function Index() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-gray-900 mb-4">
          Suiftly
        </h1>
        <p className="text-xl text-gray-600 mb-8">
          Sui Infrastructure Services
        </p>
        <div className="bg-green-50 border border-green-200 rounded-lg p-6 max-w-md mx-auto">
          <p className="text-green-800 font-medium mb-2">
            ✅ Phase 6 Complete
          </p>
          <p className="text-green-700 text-sm">
            Frontend foundation is running!
          </p>
          <p className="text-gray-600 text-sm mt-4">
            Next: Phase 7 - Wallet Integration
          </p>
        </div>
      </div>
    </div>
  );
}
