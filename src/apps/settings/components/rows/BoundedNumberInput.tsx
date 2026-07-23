// ui/src/apps/settings/components/rows/BoundedNumberInput.tsx
//
// A number input whose min/max/step come from the shared SETTINGS_BOUNDS. Values
// outside the range are rejected here for immediate feedback; the Rust backend
// clamps authoritatively on save (src-tauri/src/settings.rs `clamp_settings`).

import Input from "../../../../components/forms/Input";
import { SETTINGS_BOUNDS, type SettingsBoundKey } from "../../../../settings/bounds";

interface BoundedNumberInputProps {
  boundKey: SettingsBoundKey;
  value: number;
  onChange: (v: number) => void;
  className?: string;
}

export default function BoundedNumberInput({
  boundKey,
  value,
  onChange,
  className,
}: BoundedNumberInputProps) {
  const { min, max, step } = SETTINGS_BOUNDS[boundKey];
  return (
    <Input
      type="number"
      min={min}
      max={max}
      step={step}
      value={value}
      className={className}
      onChange={(e) => {
        const v = Number(e.target.value);
        if (v >= min && v <= max) onChange(v);
      }}
    />
  );
}
