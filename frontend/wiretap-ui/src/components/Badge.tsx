// The badge primitive: renders the `.badge` classes in styles/components.css.
// A badge is a label, not a control — one that answers a click is a
// `<Button variant="tonal">`. `badgeClass` is the same class string for an
// element that cannot be a <span>.

import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import type { ButtonTone } from "./Button";

export type BadgeTone = ButtonTone;
export type BadgeVariant = "tonal" | "outline";
export type BadgeSize = "sm" | "md" | "lg";

export interface BadgeStyleProps {
  tone?: BadgeTone;
  variant?: BadgeVariant;
  /** Height: `sm` 16 px · `md` 20 px · `lg` 24 px */
  size?: BadgeSize;
  mono?: boolean;
}

export function badgeClass(
  { tone = "neutral", variant = "tonal", size = "md", mono = false }: BadgeStyleProps = {},
  className = "",
): string {
  return [
    "badge",
    variant !== "tonal" && `badge--${variant}`,
    tone !== "neutral" && `badge--${tone}`,
    size !== "md" && `badge--${size}`,
    mono && "font-mono",
    className,
  ]
    .filter(Boolean)
    .join(" ");
}

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, BadgeStyleProps {}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ tone, variant, size, mono, className = "", ...rest }, ref) => (
    <span ref={ref} className={badgeClass({ tone, variant, size, mono }, className)} {...rest} />
  ),
);
Badge.displayName = "Badge";

export interface SummaryBadgeProps extends Omit<BadgeProps, "children"> {
  label: ReactNode;
  value: ReactNode;
}

/** A `label: value` pair — the value in monospace, the label dimmed beside it. */
export function SummaryBadge({ label, value, size = "lg", ...rest }: SummaryBadgeProps) {
  return (
    <Badge size={size} {...rest}>
      <span className="opacity-70">{label}:</span>
      <span className="font-mono text-[color:var(--text-primary)]">{value}</span>
    </Badge>
  );
}
