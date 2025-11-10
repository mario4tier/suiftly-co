/**
 * Action Button - Blue outlined button (same size as AddButton)
 * Used for secondary actions like "Manage", "Subscribe"
 */

import { ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "@/lib/utils";

export interface ActionButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
}

export const ActionButton = forwardRef<HTMLButtonElement, ActionButtonProps>(
  ({ className, children, disabled, ...props }, ref) => {
    return (
      <button
        ref={ref}
        disabled={disabled}
        className={cn(
          "inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium",
          "rounded-md transition-colors",
          "border-2 border-blue-600 text-blue-600 bg-white",
          "hover:bg-blue-50",
          "focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2",
          "disabled:opacity-50 disabled:cursor-default disabled:hover:bg-white disabled:hover:border-blue-600",
          "dark:border-blue-500 dark:text-blue-400 dark:bg-gray-900",
          "dark:hover:bg-blue-950",
          "dark:disabled:hover:bg-gray-900 dark:disabled:hover:border-blue-500",
          "dark:focus:ring-offset-gray-900",
          className
        )}
        {...props}
      >
        {children}
      </button>
    );
  }
);

ActionButton.displayName = "ActionButton";
