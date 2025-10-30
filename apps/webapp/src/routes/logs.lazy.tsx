/**
 * Logs Page
 */

import { createLazyFileRoute } from '@tanstack/react-router';
import { DashboardLayout } from '../components/layout/DashboardLayout';
import { Card, CardContent } from '@/components/ui/card';

export const Route = createLazyFileRoute('/logs')({
  component: LogsPage,
});

function LogsPage() {
  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Activity Logs</h2>
          <p className="text-muted-foreground mt-2">
            Audit trail of configuration changes and billing events
          </p>
        </div>

        <Card>
          <CardContent className="pt-12 pb-12 text-center">
            <div className="text-6xl mb-4">📝</div>
            <h3 className="text-xl font-semibold mb-2">No Activity Yet</h3>
            <p className="text-muted-foreground">
              Activity logs will appear after you configure services
            </p>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
