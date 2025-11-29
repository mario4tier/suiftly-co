/**
 * Text Action Component
 * Inline text button that looks like a link
 * For actions that don't navigate (onClick handlers)
 *
 * Uses same styling as TextRoute for consistency
 */

interface TextActionProps {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}

export function TextAction({ children, onClick, disabled }: TextActionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 no-underline hover:underline hover:decoration-dotted hover:decoration-1 hover:underline-offset-2 transition-colors focus:outline-none rounded-sm disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:no-underline"
    >
      {children}
      <span className="opacity-60">→</span>
    </button>
  );
}
