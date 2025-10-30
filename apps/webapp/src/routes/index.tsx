/**
 * Dashboard Home (/)
 * Overview page with stats - Professional Cloudflare-style design
 */

import { createFileRoute } from '@tanstack/react-router';
import { DashboardLayout } from '../components/layout/DashboardLayout';
import { useAuth } from '../lib/auth';
import { ProtectedRoute } from '../components/auth/ProtectedRoute';

export const Route = createFileRoute('/')({
  component: DashboardHome,
});

function DashboardHome() {
  return (
    <ProtectedRoute>
      <DashboardContent />
    </ProtectedRoute>
  );
}

function DashboardContent() {
  const { user } = useAuth();

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Page Title */}
        <div>
          <h1 className="font-semibold" style={{ fontSize: '1.46667rem', color: '#333333' }}>
            Overview
          </h1>
          <p className="mt-1" style={{ fontSize: '0.86667rem', color: '#808285' }}>
            Monitor your Suiftly infrastructure
          </p>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[
            { label: 'Active Services', value: '0', sublabel: 'Not configured' },
            { label: 'This Month', value: '$0.00', sublabel: 'Current cycle' },
            { label: 'Requests (24h)', value: '0', sublabel: 'No activity' },
            { label: 'Balance', value: '$0.00', sublabel: 'Available' },
          ].map((stat) => (
            <div
              key={stat.label}
              className="bg-white rounded p-5"
              style={{
                border: '1px solid #ebebeb',
                boxShadow: '0 1px 1px rgba(0, 0, 0, 0.05)',
              }}
            >
              <div
                className="uppercase font-semibold mb-2"
                style={{ fontSize: '0.73333rem', color: '#808285', letterSpacing: '0.05em' }}
              >
                {stat.label}
              </div>
              <div className="font-semibold" style={{ fontSize: '2rem', color: '#333333' }}>
                {stat.value}
              </div>
              <div className="mt-1" style={{ fontSize: '0.73333rem', color: '#808285' }}>
                {stat.sublabel}
              </div>
            </div>
          ))}
        </div>

        {/* Quick Actions */}
        <div
          className="bg-white rounded overflow-hidden"
          style={{ border: '1px solid #ebebeb', boxShadow: '0 1px 1px rgba(0, 0, 0, 0.05)' }}
        >
          <div
            className="px-6 py-4"
            style={{ borderBottom: '1px solid #ebebeb', backgroundColor: 'white' }}
          >
            <h2 className="font-semibold" style={{ fontSize: '1rem', color: '#333333' }}>
              Get Started
            </h2>
          </div>

          <div className="p-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <a
                href="/services"
                className="rounded p-5 transition-all group flex items-start gap-4"
                style={{ border: '1px solid #ebebeb' }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = '#2F7BBF';
                  e.currentTarget.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.1)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = '#ebebeb';
                  e.currentTarget.style.boxShadow = 'none';
                }}
              >
                <div className="text-3xl">⚙️</div>
                <div>
                  <h3 className="font-semibold mb-1" style={{ fontSize: '0.93333rem', color: '#333333' }}>
                    Configure Services
                  </h3>
                  <p style={{ fontSize: '0.86667rem', color: '#808285' }}>
                    Set up Seal storage for your applications
                  </p>
                </div>
              </a>

              <a
                href="/api-keys"
                className="rounded p-5 transition-all group flex items-start gap-4"
                style={{ border: '1px solid #ebebeb' }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = '#2F7BBF';
                  e.currentTarget.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.1)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = '#ebebeb';
                  e.currentTarget.style.boxShadow = 'none';
                }}
              >
                <div className="text-3xl">🔑</div>
                <div>
                  <h3 className="font-semibold mb-1" style={{ fontSize: '0.93333rem', color: '#333333' }}>
                    API Keys
                  </h3>
                  <p style={{ fontSize: '0.86667rem', color: '#808285' }}>
                    Generate keys to authenticate your apps
                  </p>
                </div>
              </a>
            </div>
          </div>
        </div>

        {/* Account Card */}
        <div
          className="bg-white rounded p-6"
          style={{ border: '1px solid #ebebeb', boxShadow: '0 1px 1px rgba(0, 0, 0, 0.05)' }}
        >
          <h3
            className="uppercase font-semibold mb-4"
            style={{ fontSize: '0.73333rem', color: '#808285', letterSpacing: '0.05em' }}
          >
            Account
          </h3>
          <div className="flex items-center gap-4">
            <div
              className="w-12 h-12 rounded-full flex items-center justify-center font-semibold"
              style={{ backgroundColor: 'rgba(47, 123, 191, 0.1)', color: '#2F7BBF' }}
            >
              {user?.walletAddress.slice(2, 4).toUpperCase()}
            </div>
            <div>
              <div className="font-semibold" style={{ fontSize: '0.86667rem', color: '#333333' }}>
                Wallet Account
              </div>
              <div className="font-mono mt-1" style={{ fontSize: '0.73333rem', color: '#808285' }}>
                {user?.walletAddress}
              </div>
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
