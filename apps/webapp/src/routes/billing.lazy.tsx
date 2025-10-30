/**
 * Billing Page
 * Cloudflare-inspired with Tailwind + shadcn/ui
 */

import { createLazyFileRoute } from '@tanstack/react-router';
import { DashboardLayout } from '../components/layout/DashboardLayout';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export const Route = createLazyFileRoute('/billing')({
  component: BillingPage,
});

function BillingPage() {
  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-cf-lg font-semibold text-charcoal">Billing & Usage</h1>
          <p className="text-cf-sm text-storm mt-1">
            Monitor your spending and usage
          </p>
        </div>

        <Card className="p-12 border-dust shadow-cf-sm text-center">
          <div className="text-6xl mb-4">💳</div>
          <h2 className="text-cf-base font-semibold text-charcoal mb-2">
            No Services Configured
          </h2>
          <p className="text-cf-sm text-storm mb-6">
            Configure a service to start tracking usage and billing
          </p>
          <Button asChild className="bg-marine hover:bg-marine/90 text-white">
            <a href="/services">Configure Services</a>
          </Button>
        </Card>
      </div>
    </DashboardLayout>
  );
}
