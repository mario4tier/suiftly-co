/**
 * Inline Button - Small buttons for table row actions
 * Used for inline commands like "Copy", "Revoke", "Delete"
 */

import { ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "@/lib/utils";

export interface InlineButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
  variant?: "default" | "danger";
}

export const InlineButton = forwardRef<HTMLButtonElement, InlineButtonProps>(
  ({ className, children, disabled, variant = "default", ...props }, ref) => {
    return (
      <button
        ref={ref}
        disabled={disabled}
        className={cn(
          "inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium",
          "rounded transition-colors",
          "border",
          // Default variant
          variant === "default" && [
            "border-gray-300 text-gray-700 bg-white",
            "hover:bg-gray-50 hover:border-gray-400",
            "dark:border-gray-600 dark:text-gray-300 dark:bg-gray-800",
            "dark:hover:bg-gray-700 dark:hover:border-gray-500",
          ],
          // Danger variant
          variant === "danger" && [
            "border-red-300 text-red-600 bg-white",
            "hover:bg-red-50 hover:border-red-400",
            "dark:border-red-800 dark:text-red-400 dark:bg-gray-800",
            "dark:hover:bg-red-900/20 dark:hover:border-red-700",
          ],
          "focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1",
          "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-white dark:disabled:hover:bg-gray-800",
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

InlineButton.displayName = "InlineButton";
