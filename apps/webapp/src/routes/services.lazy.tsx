/**
 * Services Layout
 * Parent route that renders child routes (/services/seal, /services/grpc, etc.)
 */

import { createLazyFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createLazyFileRoute('/services')({
  component: ServicesLayout,
});

function ServicesLayout() {
  // Render child routes (seal, grpc, graphql)
  return <Outlet />;
}
