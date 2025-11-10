/**
 * Link Button - Blue outlined button for navigation
 * Used for navigation actions that look like buttons but go to different pages
 *
 * Semantically correct: Uses <a> tag for navigation (not <button>)
 * Supports Cmd+Click, right-click "Open in new tab", shows URL on hover
 * Always shows discrete → arrow for visual navigation hint
 */

import { Link, LinkProps } from "@tanstack/react-router";
import { forwardRef } from "react";
import { cn } from "@/lib/utils";

export interface LinkButtonProps extends Omit<LinkProps, 'children'> {
  children: React.ReactNode;
  className?: string;
}

export const LinkButton = forwardRef<HTMLAnchorElement, LinkButtonProps & { showArrow?: never }>(
  ({ className, children, showArrow: _showArrow, ...props }, ref) => {
    return (
      <Link
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center gap-1.5 p-1.5 text-sm font-medium",
          "rounded-md transition-colors",
          "border-2 border-blue-600 bg-white",
          "!text-blue-600 no-underline",
          "hover:bg-blue-50 hover:!text-blue-700 hover:no-underline",
          "focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2",
          "dark:border-blue-500 dark:bg-gray-900",
          "dark:!text-blue-400",
          "dark:hover:bg-blue-950 dark:hover:!text-blue-300",
          "dark:focus:ring-offset-gray-900",
          className
        )}
        {...props}
      >
        {children}
        <span className="opacity-60">→</span>
      </Link>
    );
  }
);

LinkButton.displayName = "LinkButton";
