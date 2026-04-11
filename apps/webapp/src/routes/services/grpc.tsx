/**
 * gRPC Service Layout
 * Parent route for /services/grpc/* routes
 */

import { Outlet, createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/services/grpc')({
  component: GrpcLayout,
});

function GrpcLayout() {
  return <Outlet />;
}
