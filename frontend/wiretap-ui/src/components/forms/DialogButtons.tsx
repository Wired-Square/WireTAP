// ui/src/components/forms/DialogButtons.tsx
// The dialog-footer presets: named Button compositions so a footer reads as
// what it does. Any Button prop can still be passed through.

import { forwardRef } from "react";
import { Button, type ButtonProps } from "../Button";

type PresetProps = Omit<ButtonProps, "variant" | "tone">;

const preset = (displayName: string, variant: ButtonProps["variant"], tone: ButtonProps["tone"]) => {
  const Preset = forwardRef<HTMLButtonElement, PresetProps>(({ size = "lg", ...props }, ref) => (
    <Button ref={ref} variant={variant} tone={tone} size={size} {...props} />
  ));
  Preset.displayName = displayName;
  return Preset;
};

/** Save, Confirm, Create … */
export const PrimaryButton = preset("PrimaryButton", "solid", "primary");

/** Cancel, Close, Back … */
export const SecondaryButton = preset("SecondaryButton", "outline", "neutral");

/** Delete, Remove, Discard … */
export const DangerButton = preset("DangerButton", "solid", "danger");

/** Add, Create … */
export const SuccessButton = preset("SuccessButton", "solid", "success");
