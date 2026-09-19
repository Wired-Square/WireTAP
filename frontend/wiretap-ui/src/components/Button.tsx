// The button primitive: renders the `.btn` classes in styles/components.css.
// `Button` is the text button (surface by default), `IconButton` the square
// icon-only one (ghost by default, labelled for assistive tech). `buttonClass`
// is the same class string for the rare non-<button> element styled as one.

import { forwardRef, type ButtonHTMLAttributes } from "react";

export type ButtonVariant = "surface" | "solid" | "outline" | "ghost" | "tonal" | "link";
export type ButtonTone = "neutral" | "primary" | "success" | "danger" | "warning" | "purple" | "cyan";
export type ButtonSize = "xs" | "sm" | "md" | "lg";

export interface ButtonStyleProps {
  variant?: ButtonVariant;
  tone?: ButtonTone;
  size?: ButtonSize;
  /** Square, icon-only sizing */
  icon?: boolean;
}

export function buttonClass(
  { variant = "surface", tone = "neutral", size = "md", icon = false }: ButtonStyleProps = {},
  className = "",
): string {
  return [
    "btn",
    variant !== "surface" && `btn--${variant}`,
    tone !== "neutral" && `btn--toned btn--${tone}`,
    size !== "md" && `btn--${size}`,
    icon && "btn--icon",
    className,
  ]
    .filter(Boolean)
    .join(" ");
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, ButtonStyleProps {
  /** Toggle state, rendered as `aria-pressed`; a lit toggle takes its tone's tint */
  pressed?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant, tone, size, pressed, icon, className = "", type = "button", ...rest }, ref) => (
    <button
      ref={ref}
      type={type}
      aria-pressed={pressed}
      className={buttonClass({ variant, tone, size, icon }, className)}
      {...rest}
    />
  ),
);
Button.displayName = "Button";

export interface IconButtonProps extends ButtonProps {
  /** Accessible name; also the tooltip unless `title` is given */
  label?: string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ label, title, variant = "ghost", ...rest }, ref) => (
    <Button ref={ref} icon variant={variant} aria-label={label ?? title} title={title ?? label} {...rest} />
  ),
);
IconButton.displayName = "IconButton";
