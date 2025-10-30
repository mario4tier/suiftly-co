/**
 * Dashboard Home (/)
 * Overview page - Cloudflare-inspired design with Tailwind + shadcn/ui
 */

import { createFileRoute } from '@tanstack/react-router';
import { DashboardLayout } from '../components/layout/DashboardLayout';
import { useAuth } from '../lib/auth';
import { ProtectedRoute } from '../components/auth/ProtectedRoute';
import { Card } from '@/components/ui/card';

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
        {/* Page Header */}
        <div>
          <h1 className="text-cf-lg font-semibold text-charcoal">Overview</h1>
          <p className="text-cf-sm text-storm mt-1">
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
            <Card key={stat.label} className="p-5 border-dust shadow-cf-sm">
              <div className="text-cf-xs uppercase font-semibold text-storm tracking-wider mb-2">
                {stat.label}
              </div>
              <div className="text-cf-xl font-semibold text-charcoal">
                {stat.value}
              </div>
              <div className="text-cf-xs text-storm mt-1">
                {stat.sublabel}
              </div>
            </Card>
          ))}
        </div>

        {/* Quick Actions */}
        <Card className="border-dust shadow-cf-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-dust bg-white">
            <h2 className="text-cf-base font-semibold text-charcoal">
              Get Started
            </h2>
          </div>

          <div className="p-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <a
                href="/services"
                className="border border-dust rounded-cf p-5 hover:border-marine hover:shadow-cf transition-all flex items-start gap-4"
              >
                <div className="text-3xl">⚙️</div>
                <div>
                  <h3 className="text-cf-base font-semibold text-charcoal hover:text-marine mb-1">
                    Configure Services
                  </h3>
                  <p className="text-cf-sm text-storm">
                    Set up Seal storage for your applications
                  </p>
                </div>
              </a>

              <a
                href="/api-keys"
                className="border border-dust rounded-cf p-5 hover:border-marine hover:shadow-cf transition-all flex items-start gap-4"
              >
                <div className="text-3xl">🔑</div>
                <div>
                  <h3 className="text-cf-base font-semibold text-charcoal hover:text-marine mb-1">
                    API Keys
                  </h3>
                  <p className="text-cf-sm text-storm">
                    Generate keys to authenticate your apps
                  </p>
                </div>
              </a>
            </div>
          </div>
        </Card>

        {/* Account Card */}
        <Card className="p-6 border-dust shadow-cf-sm">
          <h3 className="text-cf-xs uppercase font-semibold text-storm tracking-wider mb-4">
            Account
          </h3>
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-full flex items-center justify-center font-semibold bg-marine/10 text-marine">
              {user?.walletAddress.slice(2, 4).toUpperCase()}
            </div>
            <div>
              <div className="text-cf-sm font-semibold text-charcoal">
                Wallet Account
              </div>
              <div className="text-cf-xs font-mono text-storm mt-1">
                {user?.walletAddress}
              </div>
            </div>
          </div>
        </Card>
      </div>
    </DashboardLayout>
  );
}
