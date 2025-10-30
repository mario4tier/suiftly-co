/**
 * Seal Service Configuration Page
 * Main service page for Phase 10
 */

import { createLazyFileRoute } from '@tanstack/react-router';
import { DashboardLayout } from '../../components/layout/DashboardLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const Route = createLazyFileRoute('/services/seal')({
  component: SealServicePage,
});

function SealServicePage() {
  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Seal Storage</h2>
          <p className="text-muted-foreground mt-2">
            Decentralized storage powered by Walrus protocol
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Service Configuration</CardTitle>
            <CardDescription>
              Configure Seal storage for your applications
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">
              Service configuration coming in Phase 10...
            </p>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
