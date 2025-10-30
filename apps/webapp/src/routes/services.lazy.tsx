/**
 * Services Page
 */

import { createLazyFileRoute } from '@tanstack/react-router';
import { DashboardLayout } from '../components/layout/DashboardLayout';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const Route = createLazyFileRoute('/services')({
  component: ServicesPage,
});

function ServicesPage() {
  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Services</h2>
          <p className="text-muted-foreground mt-2">
            Configure and manage your infrastructure services
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          <a href="/services/seal">
            <Card className="hover:border-primary hover:shadow-md transition-all cursor-pointer h-full">
              <CardHeader>
                <div className="text-5xl mb-3">🔷</div>
                <CardTitle>Seal Storage</CardTitle>
                <CardDescription className="mt-2">
                  Decentralized storage with Walrus protocol
                </CardDescription>
                <div className="mt-4">
                  <span className="inline-flex items-center rounded-full px-3 py-1 text-xs font-medium bg-secondary text-secondary-foreground">
                    Not configured
                  </span>
                </div>
              </CardHeader>
            </Card>
          </a>

          <Card className="opacity-60">
            <CardHeader>
              <div className="text-5xl mb-3">🌐</div>
              <CardTitle>gRPC</CardTitle>
              <CardDescription className="mt-2">
                High-performance RPC endpoints
              </CardDescription>
              <div className="mt-4">
                <span className="inline-flex items-center rounded-full px-3 py-1 text-xs font-medium bg-secondary text-secondary-foreground">
                  Coming Soon
                </span>
              </div>
            </CardHeader>
          </Card>

          <Card className="opacity-60">
            <CardHeader>
              <div className="text-5xl mb-3">📊</div>
              <CardTitle>GraphQL</CardTitle>
              <CardDescription className="mt-2">
                Flexible query language for Sui data
              </CardDescription>
              <div className="mt-4">
                <span className="inline-flex items-center rounded-full px-3 py-1 text-xs font-medium bg-secondary text-secondary-foreground">
                  Coming Soon
                </span>
              </div>
            </CardHeader>
          </Card>
        </div>
      </div>
    </DashboardLayout>
  );
}
