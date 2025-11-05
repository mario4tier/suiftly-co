/**
 * Seal Service Layout
 * Parent route for /services/seal/* routes
 */

import { Outlet, createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/services/seal')({
  component: SealLayout,
});

function SealLayout() {
  return <Outlet />;
}
