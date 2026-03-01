// ui/src/components/forms/ToolbarSelect.tsx
//
// A select component styled for dark toolbars (data view bars, etc.)

import { SelectHTMLAttributes, forwardRef } from 'react';
import { disabledState } from "../../styles";
import { toolbarElementHeight } from '../../styles/inputStyles';

export interface ToolbarSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  /** Optional size variant */
  variant?: 'default' | 'small';
}

/**
 * Select component for dark toolbar contexts.
 * Matches the dark theme used in data view toolbars.
 */
const ToolbarSelect = forwardRef<HTMLSelectElement, ToolbarSelectProps>(
  ({ variant = 'default', className = '', children, ...props }, ref) => {
    const variantClasses = {
      default: 'px-2 py-1 text-xs',
      small: 'px-1.5 py-0.5 text-xs',
    };

    const baseClasses = `rounded border border-gray-600 bg-gray-700 text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500 ${toolbarElementHeight} ${disabledState}`;

    return (
      <select
        ref={ref}
        className={`${variantClasses[variant]} ${baseClasses} ${className}`}
        {...props}
      >
        {children}
      </select>
    );
  }
);

ToolbarSelect.displayName = 'ToolbarSelect';

export default ToolbarSelect;
