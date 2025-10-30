/**
 * Seal Service Configuration Page
 * Phase 10: Full configuration form with live pricing
 */

import { createLazyFileRoute } from '@tanstack/react-router';
import { DashboardLayout } from '../../components/layout/DashboardLayout';
import { SealConfigForm } from '../../components/services/SealConfigForm';

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

        <SealConfigForm />
      </div>
    </DashboardLayout>
  );
}
