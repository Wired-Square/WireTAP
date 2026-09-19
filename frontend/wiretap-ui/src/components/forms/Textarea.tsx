// A `<textarea>` in the `.input` look. Fixed-size by default; add `resize-y`
// to let the user drag it.

import { forwardRef, type TextareaHTMLAttributes } from "react";
import { inputClass, type InputStyleProps } from "./Input";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement>, InputStyleProps {}

const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(({ size, tone, mono, className, ...rest }, ref) => (
  <textarea ref={ref} className={inputClass({ size, tone, mono }, className)} {...rest} />
));
Textarea.displayName = "Textarea";

export default Textarea;
