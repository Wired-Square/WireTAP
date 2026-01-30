// ui/src/components/Alert.tsx

import type { ReactNode } from 'react';
import { AlertTriangle, Info, CheckCircle, XCircle } from 'lucide-react';
import { iconLg } from '../styles/spacing';
import {
  alertInfo,
  alertWarning,
  alertDanger,
  alertSuccess,
} from '../styles/cardStyles';

type AlertVariant = 'info' | 'warning' | 'danger' | 'success';

type AlertProps = {
  variant?: AlertVariant;
  title?: string;
  children: ReactNode;
  className?: string;
  showIcon?: boolean;
};

const variantStyles: Record<AlertVariant, string> = {
  info: alertInfo,
  warning: alertWarning,
  danger: alertDanger,
  success: alertSuccess,
};

const variantIcons: Record<AlertVariant, typeof Info> = {
  info: Info,
  warning: AlertTriangle,
  danger: XCircle,
  success: CheckCircle,
};

// Uses CSS variables for cross-platform dark mode support (Windows WebView)
const iconColors: Record<AlertVariant, string> = {
  info: 'text-[color:var(--status-info-text)]',
  warning: 'text-[color:var(--status-warning-text)]',
  danger: 'text-[color:var(--status-danger-text)]',
  success: 'text-[color:var(--status-success-text)]',
};

const titleColors: Record<AlertVariant, string> = {
  info: 'text-[color:var(--status-info-text)]',
  warning: 'text-[color:var(--status-warning-text)]',
  danger: 'text-[color:var(--status-danger-text)]',
  success: 'text-[color:var(--status-success-text)]',
};

const textColors: Record<AlertVariant, string> = {
  info: 'text-[color:var(--status-info-text)]',
  warning: 'text-[color:var(--status-warning-text)]',
  danger: 'text-[color:var(--status-danger-text)]',
  success: 'text-[color:var(--status-success-text)]',
};

/**
 * Alert component for displaying messages with context.
 *
 * @example
 * <Alert variant="warning" title="Warning">
 *   This action cannot be undone.
 * </Alert>
 */
export default function Alert({
  variant = 'info',
  title,
  children,
  className = '',
  showIcon = true,
}: AlertProps) {
  const Icon = variantIcons[variant];

  return (
    <div className={`${variantStyles[variant]} ${className}`}>
      <div className="flex gap-3">
        {showIcon && (
          <Icon className={`${iconLg} flex-shrink-0 ${iconColors[variant]}`} />
        )}
        <div className="flex-1">
          {title && (
            <h4 className={`font-medium mb-1 ${titleColors[variant]}`}>
              {title}
            </h4>
          )}
          <div className={textColors[variant]}>{children}</div>
        </div>
      </div>
    </div>
  );
}
