/**
 * Seal Service Index - Redirects to Config
 */

import { createLazyFileRoute, Navigate } from '@tanstack/react-router';

export const Route = createLazyFileRoute('/services/seal/')({
  component: SealIndexPage,
});

function SealIndexPage() {
  return <Navigate to="/services/seal/config" replace />;
}
