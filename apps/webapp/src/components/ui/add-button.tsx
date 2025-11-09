/**
 * Add Button - Full blue background with + icon
 * Used for primary "add" actions
 */

import { Plus } from "lucide-react";
import { ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "@/lib/utils";

export interface AddButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
}

export const AddButton = forwardRef<HTMLButtonElement, AddButtonProps>(
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
          "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-blue-600",
          "dark:bg-blue-600 dark:hover:bg-blue-700 dark:focus:ring-offset-gray-900",
          className
        )}
        {...props}
      >
        <Plus className="h-4 w-4" />
        {children}
      </button>
    );
  }
);

AddButton.displayName = "AddButton";
