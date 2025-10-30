/**
 * Billing Page
 * Usage and billing information
 */

import { createLazyFileRoute } from '@tanstack/react-router';
import { DashboardLayout } from '../components/layout/DashboardLayout';

export const Route = createLazyFileRoute('/billing')({
  component: BillingPage,
});

function BillingPage() {
  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="font-semibold" style={{ fontSize: '1.46667rem', color: '#333333' }}>
            Billing & Usage
          </h1>
          <p className="mt-1" style={{ fontSize: '0.86667rem', color: '#808285' }}>
            Monitor your spending and usage
          </p>
        </div>

        <div
          className="bg-white rounded p-8 text-center"
          style={{ border: '1px solid #ebebeb', boxShadow: '0 1px 1px rgba(0, 0, 0, 0.05)' }}
        >
          <div className="text-5xl mb-4">💳</div>
          <h2 className="font-semibold mb-2" style={{ fontSize: '1rem', color: '#333333' }}>
            No Services Configured
          </h2>
          <p className="mb-6" style={{ fontSize: '0.86667rem', color: '#808285' }}>
            Configure a service to start tracking usage and billing
          </p>
          <a
            href="/services"
            className="inline-block px-4 py-2 rounded font-semibold transition-colors"
            style={{
              backgroundColor: '#2F7BBF',
              color: 'white',
              fontSize: '0.86667rem',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = '#1E4E79';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = '#2F7BBF';
            }}
          >
            Configure Services
          </a>
        </div>
      </div>
    </DashboardLayout>
  );
}
