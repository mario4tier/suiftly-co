/**
 * Services Page
 * Lists all available services
 */

import { createLazyFileRoute } from '@tanstack/react-router';
import { DashboardLayout } from '../components/layout/DashboardLayout';

export const Route = createLazyFileRoute('/services')({
  component: ServicesPage,
});

function ServicesPage() {
  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="font-semibold" style={{ fontSize: '1.46667rem', color: '#333333' }}>
            Services
          </h1>
          <p className="mt-1" style={{ fontSize: '0.86667rem', color: '#808285' }}>
            Configure and manage your Suiftly infrastructure services
          </p>
        </div>

        {/* Services Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <a
            href="/services/seal"
            className="bg-white rounded p-6 transition-all block"
            style={{ border: '1px solid #ebebeb', boxShadow: '0 1px 1px rgba(0, 0, 0, 0.05)' }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = '#2F7BBF';
              e.currentTarget.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.1)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = '#ebebeb';
              e.currentTarget.style.boxShadow = '0 1px 1px rgba(0, 0, 0, 0.05)';
            }}
          >
            <div className="text-4xl mb-4">🔷</div>
            <h2 className="font-semibold mb-2" style={{ fontSize: '1rem', color: '#333333' }}>
              Seal Storage
            </h2>
            <p className="mb-4" style={{ fontSize: '0.86667rem', color: '#808285' }}>
              Decentralized storage with Walrus protocol
            </p>
            <div
              className="inline-block px-3 py-1 rounded text-xs font-semibold"
              style={{ backgroundColor: '#F7F7F7', color: '#808285' }}
            >
              Not configured
            </div>
          </a>

          <div
            className="bg-white rounded p-6"
            style={{ border: '1px solid #ebebeb', boxShadow: '0 1px 1px rgba(0, 0, 0, 0.05)', opacity: 0.6 }}
          >
            <div className="text-4xl mb-4">🌐</div>
            <h2 className="font-semibold mb-2" style={{ fontSize: '1rem', color: '#333333' }}>
              gRPC
            </h2>
            <p className="mb-4" style={{ fontSize: '0.86667rem', color: '#808285' }}>
              High-performance RPC endpoints
            </p>
            <div
              className="inline-block px-3 py-1 rounded text-xs font-semibold"
              style={{ backgroundColor: '#F7F7F7', color: '#808285' }}
            >
              Coming Soon
            </div>
          </div>

          <div
            className="bg-white rounded p-6"
            style={{ border: '1px solid #ebebeb', boxShadow: '0 1px 1px rgba(0, 0, 0, 0.05)', opacity: 0.6 }}
          >
            <div className="text-4xl mb-4">📊</div>
            <h2 className="font-semibold mb-2" style={{ fontSize: '1rem', color: '#333333' }}>
              GraphQL
            </h2>
            <p className="mb-4" style={{ fontSize: '0.86667rem', color: '#808285' }}>
              Flexible query language for Sui data
            </p>
            <div
              className="inline-block px-3 py-1 rounded text-xs font-semibold"
              style={{ backgroundColor: '#F7F7F7', color: '#808285' }}
            >
              Coming Soon
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
