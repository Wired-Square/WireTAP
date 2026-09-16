// ui/src/components/Card.tsx

import type { ReactNode } from 'react';
import {
  cardDefault,
  cardElevated,
  cardInteractive,
  cardPadding,
} from '../styles/cardStyles';

type CardVariant = 'default' | 'elevated' | 'interactive';
type CardPadding = 'none' | 'sm' | 'md' | 'lg';

type CardProps = {
  variant?: CardVariant;
  padding?: CardPadding;
  children: ReactNode;
  className?: string;
  onClick?: () => void;
};

const variantStyles: Record<CardVariant, string> = {
  default: cardDefault,
  elevated: cardElevated,
  interactive: cardInteractive,
};

/**
 * Card component for content panels and sections.
 *
 * @example
 * <Card variant="elevated" padding="md">
 *   <h3>Card Title</h3>
 *   <p>Card content</p>
 * </Card>
 */
export default function Card({
  variant = 'default',
  padding = 'md',
  children,
  className = '',
  onClick,
}: CardProps) {
  return (
    <div
      className={`${variantStyles[variant]} ${cardPadding[padding]} ${className}`}
      onClick={onClick}
    >
      {children}
    </div>
  );
}
