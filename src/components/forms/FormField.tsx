// ui/src/components/forms/FormField.tsx

import { ReactNode } from 'react';
import { textMedium } from '../../styles';

export interface FormFieldProps {
  label: string;
  required?: boolean;
  variant?: 'default' | 'simple';
  children: ReactNode;
}

/**
 * Wrapper component that combines a label with form inputs.
 * - variant='default': Block label with medium font (for Settings, IOProfile dialogs)
 * - variant='simple': Inline label with smaller text (for SaveFrames dialogs)
 */
export default function FormField({ label, required, variant = 'default', children }: FormFieldProps) {
  if (variant === 'simple') {
    return (
      <label className="text-sm text-[color:var(--text-secondary)] space-y-1">
        <span>
          {label}
          {required && <span className="text-red-500 ml-1">*</span>}
        </span>
        {children}
      </label>
    );
  }

  // default variant
  return (
    <div>
      <label className={`block ${textMedium} mb-2`}>
        {label}
        {required && <span className="text-red-500 ml-1">*</span>}
      </label>
      {children}
    </div>
  );
}
