/**
 * Billing Page
 */

import { createLazyFileRoute } from '@tanstack/react-router';
import { DashboardLayout } from '../components/layout/DashboardLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export const Route = createLazyFileRoute('/billing')({
  component: BillingPage,
});

function BillingPage() {
  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Billing & Payments</h2>
          <p className="text-muted-foreground mt-2">
            Monitor your spending and usage
          </p>
        </div>

        <Card>
          <CardContent className="pt-12 pb-12 text-center">
            <div className="text-6xl mb-4">💳</div>
            <h3 className="text-xl font-semibold mb-2">No Services Configured</h3>
            <p className="text-muted-foreground mb-6">
              Configure a service to start tracking usage and billing
            </p>
            <Button asChild>
              <a href="/services">Configure Services</a>
            </Button>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
