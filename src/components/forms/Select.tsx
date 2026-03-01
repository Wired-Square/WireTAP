// ui/src/components/forms/Select.tsx

import { SelectHTMLAttributes, forwardRef } from 'react';
import { focusRing } from '../../styles';
import { formElementHeight } from '../../styles/inputStyles';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  variant?: 'default' | 'simple';
}

/**
 * Reusable select component with consistent styling across the app.
 * - variant='default': Full styling with focus ring (for Settings, IOProfile dialogs)
 * - variant='simple': Minimal styling (for SaveFrames and simple dialogs)
 */
const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ variant = 'default', className = '', children, ...props }, ref) => {
    // Uses CSS variables for cross-platform dark mode support (Windows WebView)
    const baseClasses = `w-full border transition-colors text-[color:var(--text-primary)] ${formElementHeight}`;

    const variantClasses = {
      default: `px-4 py-2 bg-[var(--bg-surface)] border-[color:var(--border-default)] rounded-lg ${focusRing}`,
      simple: 'px-3 py-2 bg-[var(--bg-primary)] border-[color:var(--border-default)] rounded',
    };

    return (
      <select
        ref={ref}
        className={`${baseClasses} ${variantClasses[variant]} ${className}`}
        {...props}
      >
        {children}
      </select>
    );
  }
);

Select.displayName = 'Select';

export default Select;
