// ui/src/components/Badge.tsx

import type { ReactNode } from 'react';
import {
  badgeSuccess,
  badgeDanger,
  badgeWarning,
  badgeInfo,
  badgeNeutral,
  badgePurple,
} from '../styles/badgeStyles';

type BadgeVariant = 'success' | 'danger' | 'warning' | 'info' | 'neutral' | 'purple';

type BadgeProps = {
  variant?: BadgeVariant;
  children: ReactNode;
  className?: string;
};

const variantStyles: Record<BadgeVariant, string> = {
  success: badgeSuccess,
  danger: badgeDanger,
  warning: badgeWarning,
  info: badgeInfo,
  neutral: badgeNeutral,
  purple: badgePurple,
};

/**
 * Badge component for status indicators and labels.
 *
 * @example
 * <Badge variant="success">Active</Badge>
 * <Badge variant="danger">Error</Badge>
 * <Badge variant="warning">Warning</Badge>
 */
export default function Badge({
  variant = 'neutral',
  children,
  className = '',
}: BadgeProps) {
  return (
    <span className={`${variantStyles[variant]} ${className}`}>
      {children}
    </span>
  );
}
