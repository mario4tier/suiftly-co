/**
 * API Keys Page
 * Manage API keys
 */

import { createLazyFileRoute } from '@tanstack/react-router';
import { DashboardLayout } from '../components/layout/DashboardLayout';

export const Route = createLazyFileRoute('/api-keys')({
  component: ApiKeysPage,
});

function ApiKeysPage() {
  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="font-semibold" style={{ fontSize: '1.46667rem', color: '#333333' }}>
            API Keys
          </h1>
          <p className="mt-1" style={{ fontSize: '0.86667rem', color: '#808285' }}>
            Manage authentication keys for your services
          </p>
        </div>

        <div
          className="bg-white rounded p-8 text-center"
          style={{ border: '1px solid #ebebeb', boxShadow: '0 1px 1px rgba(0, 0, 0, 0.05)' }}
        >
          <div className="text-5xl mb-4">🔑</div>
          <h2 className="font-semibold mb-2" style={{ fontSize: '1rem', color: '#333333' }}>
            No API Keys
          </h2>
          <p style={{ fontSize: '0.86667rem', color: '#808285' }}>
            Configure a service to generate API keys
          </p>
        </div>
      </div>
    </DashboardLayout>
  );
}
