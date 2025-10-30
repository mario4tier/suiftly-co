/**
 * GraphQL Service Page
 * Coming Soon placeholder
 */

import { createLazyFileRoute } from '@tanstack/react-router';
import { DashboardLayout } from '../../components/layout/DashboardLayout';
import { Card, CardContent } from '@/components/ui/card';

export const Route = createLazyFileRoute('/services/graphql')({
  component: GraphqlServicePage,
});

function GraphqlServicePage() {
  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">GraphQL</h2>
          <p className="text-muted-foreground mt-2">
            Flexible query language for Sui blockchain data
          </p>
        </div>

        <Card>
          <CardContent className="pt-16 pb-16 text-center">
            <div className="text-7xl mb-6">📊</div>
            <h3 className="text-2xl font-semibold mb-3">Coming Soon</h3>
            <p className="text-muted-foreground max-w-md mx-auto">
              GraphQL API for Sui will be available in a future release.
              For now, focus on Seal storage service.
            </p>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
