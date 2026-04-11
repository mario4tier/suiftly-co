/**
 * gRPC Service Index - Redirects to Overview
 */

import { createLazyFileRoute, Navigate } from '@tanstack/react-router';

export const Route = createLazyFileRoute('/services/grpc/')({
  component: GrpcIndexPage,
});

function GrpcIndexPage() {
  return <Navigate to="/services/grpc/overview" replace />;
}
