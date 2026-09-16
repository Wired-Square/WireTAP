// ui/src/components/forms/Textarea.tsx

import { TextareaHTMLAttributes, forwardRef } from 'react';
import { focusRing } from '../../styles';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  variant?: 'default' | 'simple';
}

/**
 * Reusable textarea component with consistent styling across the app.
 * - variant='default': Full styling with focus ring (for Settings, IOProfile dialogs)
 * - variant='simple': Minimal styling (for SaveFrames and simple dialogs)
 */
const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ variant = 'default', className = '', ...props }, ref) => {
    // Uses CSS variables for cross-platform dark mode support (Windows WebView)
    const baseClasses = 'w-full border transition-colors text-[color:var(--text-primary)] resize-none';

    const variantClasses = {
      default: `px-4 py-2 bg-[var(--bg-surface)] border-[color:var(--border-default)] rounded-lg ${focusRing}`,
      simple: 'px-3 py-2 bg-[var(--bg-primary)] border-[color:var(--border-default)] rounded',
    };

    return (
      <textarea
        ref={ref}
        className={`${baseClasses} ${variantClasses[variant]} ${className}`}
        {...props}
      />
    );
  }
);

Textarea.displayName = 'Textarea';

export default Textarea;
