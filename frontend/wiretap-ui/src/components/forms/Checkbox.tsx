// Checkbox and radio primitives: the `.check` classes in styles/components.css,
// drawn by the app so both platforms show the same box and the theme's accent.

import { forwardRef, type InputHTMLAttributes } from "react";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "type"> {
  /** `sm` is the 14 px box for table rows and dense lists */
  size?: "sm" | "md";
}

const checkClass = (radio: boolean, size: CheckboxProps["size"], className = "") =>
  ["check", radio && "check--radio", size === "sm" && "check--sm", className].filter(Boolean).join(" ");

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(({ size, className, ...rest }, ref) => (
  <input ref={ref} type="checkbox" className={checkClass(false, size, className)} {...rest} />
));
Checkbox.displayName = "Checkbox";

export const Radio = forwardRef<HTMLInputElement, CheckboxProps>(({ size, className, ...rest }, ref) => (
  <input ref={ref} type="radio" className={checkClass(true, size, className)} {...rest} />
));
Radio.displayName = "Radio";
