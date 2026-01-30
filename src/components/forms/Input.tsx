// ui/src/components/forms/Input.tsx

import { InputHTMLAttributes, forwardRef } from 'react';
import { focusRing } from '../../styles';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  variant?: 'default' | 'simple';
}

/**
 * Reusable input component with consistent styling across the app.
 * - variant='default': Full styling with focus ring (for Settings, IOProfile dialogs)
 * - variant='simple': Minimal styling (for SaveFrames and simple dialogs)
 */
const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ variant = 'default', className = '', ...props }, ref) => {
    // Uses CSS variables for cross-platform dark mode support (Windows WebView)
    const baseClasses = 'w-full border transition-colors text-[color:var(--text-primary)]';

    const variantClasses = {
      default: `px-4 py-2 bg-[var(--bg-surface)] border-[color:var(--border-default)] rounded-lg ${focusRing}`,
      simple: 'px-3 py-2 bg-[var(--bg-primary)] border-[color:var(--border-default)] rounded',
    };

    return (
      <input
        ref={ref}
        className={`${baseClasses} ${variantClasses[variant]} ${className}`}
        {...props}
      />
    );
  }
);

Input.displayName = 'Input';

export default Input;
