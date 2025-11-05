/**
 * Activity Logs Route
 * Auth guard handled by __root.tsx global guard
 */

import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/logs')({
  component: () => null, // Actual component in logs.lazy.tsx
});
