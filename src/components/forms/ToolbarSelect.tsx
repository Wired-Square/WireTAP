// ui/src/components/forms/ToolbarSelect.tsx
//
// A select component styled for toolbars (data view bars, etc.)

import { SelectHTMLAttributes, forwardRef } from 'react';
import { bgDataInput, borderDataView, disabledState, focusRingThin, textDataPrimary } from "../../styles";
import { toolbarElementHeight } from '../../styles/inputStyles';

export interface ToolbarSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  /** Optional size variant */
  variant?: 'default' | 'small';
}

/**
 * Select component for toolbar contexts.
 * Uses CSS variable tokens so it tracks the active theme.
 */
const ToolbarSelect = forwardRef<HTMLSelectElement, ToolbarSelectProps>(
  ({ variant = 'default', className = '', children, ...props }, ref) => {
    const variantClasses = {
      default: 'px-2 py-1 text-xs',
      small: 'px-1.5 py-0.5 text-xs',
    };

    const baseClasses = `rounded border ${borderDataView} ${bgDataInput} ${textDataPrimary} ${focusRingThin} ${toolbarElementHeight} ${disabledState}`;

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
