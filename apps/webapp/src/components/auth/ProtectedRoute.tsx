/**
 * Protected Route Component
 * Redirects to login if not authenticated
 */

import { useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAuthStore } from '../../stores/auth';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { isAuthenticated } = useAuthStore();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isAuthenticated) {
      navigate({ to: '/login' });
    }
  }, [isAuthenticated, navigate]);

  if (!isAuthenticated) {
    return null;
  }

  return <>{children}</>;
}
