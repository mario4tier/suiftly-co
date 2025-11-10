/**
 * Text Route Component
 * Inline text link for internal routing with arrow
 * Uses TanStack Router's Link component for local navigation
 *
 * For external links, use TextLink component (to be created)
 */

import { Link, LinkProps } from '@tanstack/react-router';

interface TextRouteProps extends LinkProps {
  children: React.ReactNode;
}

export function TextRoute({ children, ...props }: TextRouteProps) {
  return (
    <Link
      {...props}
      className="inline-flex items-center !text-blue-600 dark:!text-blue-400 hover:!text-blue-700 dark:hover:!text-blue-300 !no-underline hover:!underline hover:!decoration-dotted hover:!decoration-1 hover:!underline-offset-2 transition-colors focus:outline-none rounded-sm"
    >
      {children}
      <span className="opacity-60">→</span>
    </Link>
  );
}
