// The card primitive: renders the `.card` classes in styles/components.css.
// A bordered surface with an inset; a tone tints the surface without touching
// the content. `cardClass` is the same class string for a card that must be a
// <button> or a <label>.

import { forwardRef, type HTMLAttributes } from "react";

export type CardTone = "info" | "success" | "warning" | "danger" | "purple" | "cyan";
export type CardPadding = "none" | "sm" | "md" | "lg";

export interface CardStyleProps {
  tone?: CardTone;
  /** Inset: `none` · `sm` 8 px · `md` 12 px · `lg` 16 px */
  padding?: CardPadding;
  /** Answers a click: pointer cursor and a hover lift */
  interactive?: boolean;
  /** The chosen option among interactive cards; takes the accent tint */
  selected?: boolean;
}

export function cardClass(
  { tone, padding = "md", interactive = false, selected = false }: CardStyleProps = {},
  className = "",
): string {
  return [
    "card",
    padding !== "md" && `card--${padding === "none" ? "flush" : padding}`,
    tone && `card--${tone}`,
    interactive && "card--interactive",
    selected && "card--selected",
    className,
  ]
    .filter(Boolean)
    .join(" ");
}

export interface CardProps extends HTMLAttributes<HTMLDivElement>, CardStyleProps {}

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ tone, padding, interactive, selected, className = "", ...rest }, ref) => (
    <div ref={ref} className={cardClass({ tone, padding, interactive, selected }, className)} {...rest} />
  ),
);
Card.displayName = "Card";
