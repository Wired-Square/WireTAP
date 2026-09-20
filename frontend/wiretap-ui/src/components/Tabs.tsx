// The tabs primitive: renders the `.tabs` classes in styles/components.css.
// `Tabs` is the strip — a tablist whose arrow keys move between its tabs and
// select as they go — and `Tab` one choice in it; `TabCount` and `TabDot` are
// the marks a tab can trail. `TabStrip` and `DataViewTabBar` are the
// declarative forms over these.

import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes } from "react";
import { moveFocusAlong } from "./behaviour/focus";

export type TabsVariant = "underline" | "segmented";

export interface TabsProps extends HTMLAttributes<HTMLDivElement> {
  variant?: TabsVariant;
  /** No hairline of its own: the strip sits in a bar that draws one */
  inline?: boolean;
  /** Its own inset and fill: the strip is the first row of a flush body */
  inset?: boolean;
  /** Pinned at the top of the scroller below it */
  sticky?: boolean;
}

const KEYS = { ArrowRight: 1, ArrowLeft: -1, Home: "first", End: "last" } as const;

export function Tabs({ variant = "underline", inline = false, inset = false, sticky = false, className = "", onKeyDown, ...rest }: TabsProps) {
  const classes = [
    "tabs",
    variant !== "underline" && `tabs--${variant}`,
    inline && "tabs--inline",
    inset && "tabs--inset",
    sticky && "tabs--sticky",
    className,
  ];
  return (
    <div
      role="tablist"
      className={classes.filter(Boolean).join(" ")}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        moveFocusAlong(e, KEYS, '[role="tab"]:not(:disabled)')?.click();
      }}
      {...rest}
    />
  );
}

export interface TabProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  selected: boolean;
}

export const Tab = forwardRef<HTMLButtonElement, TabProps>(
  ({ selected, className = "", type = "button", ...rest }, ref) => (
    <button
      ref={ref}
      type={type}
      role="tab"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      className={`tabs__tab ${className}`}
      {...rest}
    />
  ),
);
Tab.displayName = "Tab";

export type TabCountTone = "neutral" | "success" | "warning" | "purple";

export interface TabCountProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: TabCountTone;
}

/** A count after the label, coloured by what it counts */
export function TabCount({ tone = "neutral", className = "", ...rest }: TabCountProps) {
  return <span className={`tabs__count ${tone !== "neutral" ? `tabs__count--${tone} ` : ""}${className}`} {...rest} />;
}

export type TabDotTone = "purple" | "danger" | "warning" | "info";

/** A dot after the label: something is happening on this tab */
export function TabDot({ tone = "purple" }: { tone?: TabDotTone }) {
  return <span aria-hidden="true" className={`tabs__dot${tone !== "purple" ? ` tabs__dot--${tone}` : ""}`} />;
}
