// The text-field primitive: renders the `.input` classes in styles/components.css.
// `Select` and `Textarea` share `inputClass`, so the three read as one control.

import { forwardRef, type InputHTMLAttributes } from "react";

export type InputSize = "xs" | "sm" | "md" | "lg";
export type InputTone = "danger" | "warning";

export interface InputStyleProps {
  /** Height: `xs` 20 px · `sm` 26 px · `md` 32 px · `lg` 40 px — the button scale */
  size?: InputSize;
  /** Validation state; `aria-invalid` renders as `danger` on its own */
  tone?: InputTone;
  mono?: boolean;
}

export function inputClass({ size = "md", tone, mono }: InputStyleProps = {}, className = ""): string {
  return ["input", size !== "md" && `input--${size}`, tone && `input--${tone}`, mono && "font-mono", className]
    .filter(Boolean)
    .join(" ");
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size">, InputStyleProps {}

const Input = forwardRef<HTMLInputElement, InputProps>(({ size, tone, mono, className, ...rest }, ref) => (
  <input ref={ref} className={inputClass({ size, tone, mono }, className)} {...rest} />
));
Input.displayName = "Input";

export default Input;
