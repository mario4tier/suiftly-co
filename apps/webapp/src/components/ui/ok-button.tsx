/**
 * OK Button - Primary action button for dialogs/modals
 * Used for confirmative actions like "OK", "Save", "Confirm", "Submit"
 *
 * Visual hierarchy: Prominent (solid blue) - draws user's attention
 * Semantically correct: Uses <button> for actions
 */

import { ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "@/lib/utils";

export interface OKButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
}

export const OKButton = forwardRef<HTMLButtonElement, OKButtonProps>(
  ({ className, children, disabled, ...props }, ref) => {
    return (
      <button
        ref={ref}
        disabled={disabled}
        className={cn(
          "inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium",
          "rounded-md transition-colors",
          "bg-blue-600 text-white",
          "hover:bg-blue-700",
          "focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2",
          "disabled:opacity-50 disabled:cursor-default disabled:hover:bg-blue-600",
          "dark:bg-blue-600 dark:hover:bg-blue-700",
          "dark:disabled:hover:bg-blue-600",
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

OKButton.displayName = "OKButton";
