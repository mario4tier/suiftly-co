/**
 * Settings Link - Minimal settings cog icon for navigation
 *
 * A small, borderless settings icon that navigates to a settings page/tab.
 * Semantically an <a> tag (supports Cmd+Click, right-click, URL on hover).
 * Styled as a subtle icon that darkens on hover -- no button chrome.
 */

import { Link, type LinkProps } from "@tanstack/react-router";
import { forwardRef } from "react";
import { Settings } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SettingsLinkProps extends Omit<LinkProps, 'children'> {
  /** Icon size in Tailwind classes (default: "h-3.5 w-3.5") */
  size?: string;
  className?: string;
}

export const SettingsLink = forwardRef<HTMLAnchorElement, SettingsLinkProps>(
  ({ className, size = "h-3.5 w-3.5", ...props }, ref) => {
    return (
      <Link
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center p-1 rounded",
          "text-gray-400 hover:text-gray-600",
          "dark:text-gray-500 dark:hover:text-gray-300",
          "transition-colors no-underline",
          className
        )}
        {...props}
      >
        <Settings className={size} />
      </Link>
    );
  }
);

SettingsLink.displayName = "SettingsLink";
