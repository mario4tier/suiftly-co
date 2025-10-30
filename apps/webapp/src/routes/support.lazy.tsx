/**
 * Support Page
 */

import { createLazyFileRoute } from '@tanstack/react-router';
import { DashboardLayout } from '../components/layout/DashboardLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const Route = createLazyFileRoute('/support')({
  component: SupportPage,
});

function SupportPage() {
  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Support</h2>
          <p className="text-muted-foreground mt-2">
            Get help with Suiftly services
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Contact Us</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm">Email: support@mhax.io</p>
            <p className="text-sm text-muted-foreground mt-1">Response time: 24-48 hours</p>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
