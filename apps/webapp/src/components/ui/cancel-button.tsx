/**
 * Cancel Button - Secondary action button for dialogs/modals
 * Used for dismissive actions like "Cancel", "Close", "Nevermind"
 *
 * Visual hierarchy: Subtle (outline) - less prominent than OK button
 * Semantically correct: Uses <button> for actions
 */

import { ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "@/lib/utils";

export interface CancelButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
}

export const CancelButton = forwardRef<HTMLButtonElement, CancelButtonProps>(
  ({ className, children, disabled, ...props }, ref) => {
    return (
      <button
        ref={ref}
        disabled={disabled}
        className={cn(
          "inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium",
          "rounded-md transition-colors",
          "border-2 border-gray-300 text-gray-700 bg-white",
          "hover:bg-gray-50 hover:border-gray-400",
          "focus:outline-none focus:ring-2 focus:ring-gray-400 focus:ring-offset-2",
          "disabled:opacity-50 disabled:cursor-default disabled:hover:bg-white disabled:hover:border-gray-300",
          "dark:border-gray-600 dark:text-gray-300 dark:bg-gray-800",
          "dark:hover:bg-gray-700 dark:hover:border-gray-500",
          "dark:disabled:hover:bg-gray-800 dark:disabled:hover:border-gray-600",
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

CancelButton.displayName = "CancelButton";
