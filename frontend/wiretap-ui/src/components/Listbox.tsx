// The list primitive: renders the `.listbox` and `.option` classes in
// styles/components.css. `Listbox` is the list a picker or a dialog body
// shows in the page — arrow keys move along its options — and `Option` one
// row in it, lit when selected, coloured by its tone. A row that nests a
// button of its own is `as="div"`. `optionClass` is the same class string for
// a row that must be some other element.

import { forwardRef, type HTMLAttributes } from "react";
import { moveFocusAlong } from "./behaviour/focus";

export interface ListboxProps extends HTMLAttributes<HTMLDivElement> {
  /** `flush` is the list in a flush dialog body: no inset, no rounding */
  variant?: "inset" | "flush";
}

const KEYS = { ArrowDown: 1, ArrowUp: -1, Home: "first", End: "last" } as const;
const OPTIONS = '[role="option"]:not(:disabled, [aria-disabled="true"])';

export const Listbox = forwardRef<HTMLDivElement, ListboxProps>(
  ({ variant = "inset", className = "", onKeyDown, ...rest }, ref) => (
    <div
      ref={ref}
      role="listbox"
      className={`listbox ${variant === "flush" ? "listbox--flush " : ""}${className}`}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        moveFocusAlong(e, KEYS, OPTIONS);
      }}
      {...rest}
    />
  ),
);
Listbox.displayName = "Listbox";

export type OptionTone = "purple" | "success" | "warning" | "cyan";

export interface OptionStyleProps {
  /** Colours the selected state and the hover edge — a source in its kind's hue */
  tone?: OptionTone;
  /** `sm` rows for a nested list */
  size?: "md" | "sm";
  /** The add-row at the end of a list */
  dashed?: boolean;
}

export function optionClass({ tone, size = "md", dashed = false }: OptionStyleProps = {}, className = ""): string {
  return ["option", tone && `option--${tone}`, size === "sm" && "option--sm", dashed && "option--dashed", className]
    .filter(Boolean)
    .join(" ");
}

export interface OptionProps extends OptionStyleProps, HTMLAttributes<HTMLElement> {
  /** The chosen row: the info tint and border, or the tone's */
  selected?: boolean;
  /** The row's own radio or check, lit with the row */
  mark?: "radio" | "check";
  /** A `div` for a row that nests a button; Enter and Space click it */
  as?: "button" | "div";
  disabled?: boolean;
}

export const Option = forwardRef<HTMLElement, OptionProps>(
  ({ selected = false, tone, size, dashed, mark, as = "button", disabled = false, className = "", onClick, onKeyDown, children, ...rest }, ref) => {
    const shared = {
      role: "option",
      "aria-selected": selected,
      className: optionClass({ tone, size, dashed }, className),
      children: (
        <>
          {mark && <span aria-hidden="true" className={`option__mark${mark === "check" ? " option__mark--check" : ""}`} />}
          {children}
        </>
      ),
      ...rest,
    };
    if (as === "div") {
      return (
        <div
          ref={ref as React.Ref<HTMLDivElement>}
          aria-disabled={disabled || undefined}
          tabIndex={disabled ? undefined : 0}
          onClick={disabled ? undefined : onClick}
          onKeyDown={(e) => {
            onKeyDown?.(e);
            if (disabled || e.defaultPrevented || e.target !== e.currentTarget) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.currentTarget.click();
            }
          }}
          {...shared}
        />
      );
    }
    return <button ref={ref as React.Ref<HTMLButtonElement>} type="button" disabled={disabled} onClick={onClick} onKeyDown={onKeyDown} {...shared} />;
  },
);
Option.displayName = "Option";
