// A `<select>` in the `.input` look, wrapped so its chevron is the app's rather
// than the platform's. `className` sizes the wrapper; `ref` reaches the select.

import { forwardRef, type SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { inputClass, type InputStyleProps } from "./Input";

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size">, InputStyleProps {}

const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ size = "md", tone, mono, className, children, ...rest }, ref) => (
    <span className={["select", size !== "md" && `select--${size}`, className].filter(Boolean).join(" ")}>
      <select ref={ref} className={inputClass({ size, tone, mono })} {...rest}>
        {children}
      </select>
      <ChevronDown className="select__icon" aria-hidden />
    </span>
  ),
);
Select.displayName = "Select";

export default Select;
