/**
 * Dashboard Home (/)
 * Redirects to /services/seal as per UI_DESIGN.md
 */

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { ProtectedRoute } from '../components/auth/ProtectedRoute';

export const Route = createFileRoute('/')({
  component: DashboardHome,
});

function DashboardHome() {
  return (
    <ProtectedRoute>
      <RedirectToSeal />
    </ProtectedRoute>
  );
}

function RedirectToSeal() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate({ to: '/services/seal' });
  }, [navigate]);

  return (
    <div className="flex items-center justify-center min-h-screen">
      <p className="text-muted-foreground">Loading...</p>
    </div>
  );
}
