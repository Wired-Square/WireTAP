// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0
//
// BRGB colour picker — native colour wheel for RGB, brightness slider,
// and hex input. Writes to the device only on committed changes.

import { useState, useCallback, useEffect, useRef } from "react";
import { textSecondary, textTertiary } from "../../../styles";
import { inputSimple } from "../../../styles/inputStyles";
import { brgbComponents, cssToBrgb } from "../utils/brgbColour";

interface ColourPickerProps {
  /** BRGB u32 value */
  value: number;
  onChange: (brgb: number) => void;
}

export default function ColourPicker({ value, onChange }: ColourPickerProps) {
  const { brightness, r, g, b } = brgbComponents(value);
  const [hexInput, setHexInput] = useState("");
  const [localBrightness, setLocalBrightness] = useState(brightness);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Sync hex input and brightness when value changes externally
  useEffect(() => {
    setHexInput(
      ((r << 16) | (g << 8) | b).toString(16).toUpperCase().padStart(6, "0"),
    );
    setLocalBrightness(brightness);
  }, [r, g, b, brightness]);

  // Native colour wheel — fires onChange on commit (not on every movement)
  const handleColourInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const hex = e.target.value.replace(/^#/, "");
      const parsed = parseInt(hex, 16);
      if (!isNaN(parsed)) {
        const nr = (parsed >> 16) & 0xff;
        const ng = (parsed >> 8) & 0xff;
        const nb = parsed & 0xff;
        setHexInput(hex.toUpperCase().padStart(6, "0"));
        onChange(cssToBrgb(nr, ng, nb, localBrightness));
      }
    },
    [localBrightness, onChange],
  );

  // Hex text input — write on valid 6-char input
  const handleHexChange = useCallback(
    (raw: string) => {
      const clean = raw.replace(/^#/, "");
      setHexInput(clean.toUpperCase());
      if (clean.length === 6) {
        const parsed = parseInt(clean, 16);
        if (!isNaN(parsed)) {
          onChange(cssToBrgb(
            (parsed >> 16) & 0xff,
            (parsed >> 8) & 0xff,
            parsed & 0xff,
            localBrightness,
          ));
        }
      }
    },
    [localBrightness, onChange],
  );

  // Brightness slider — update local state immediately, debounce device write
  const handleBrightnessChange = useCallback(
    (v: number) => {
      setLocalBrightness(v);
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        onChange(cssToBrgb(r, g, b, v));
      }, 200);
    },
    [r, g, b, onChange],
  );

  const rgbHex = `#${hexInput.padStart(6, "0")}`;
  const dimmedR = Math.round(r * localBrightness / 255);
  const dimmedG = Math.round(g * localBrightness / 255);
  const dimmedB = Math.round(b * localBrightness / 255);
  const dimmedColour = `rgb(${dimmedR}, ${dimmedG}, ${dimmedB})`;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        {/* Native colour wheel */}
        <input
          type="color"
          value={rgbHex}
          onChange={handleColourInput}
          className="h-9 w-9 cursor-pointer bg-transparent border border-white/20 rounded-lg p-0"
          title="Pick colour"
        />
        {/* Dimmed preview swatch */}
        <div
          className="w-9 h-9 rounded-lg border border-white/20 shrink-0"
          style={{ backgroundColor: dimmedColour }}
          title={`Dimmed preview (brightness ${localBrightness})`}
        />
        {/* Hex input */}
        <input
          type="text"
          className={`${inputSimple} font-mono w-24 text-xs py-1 px-2`}
          value={`#${hexInput}`}
          onChange={(e) => handleHexChange(e.target.value)}
          placeholder="#FF0000"
        />
      </div>

      {/* Brightness slider */}
      <div className="flex items-center gap-2">
        <span className={`text-[10px] w-12 ${textTertiary}`}>Brightness</span>
        <input
          type="range"
          min={0}
          max={255}
          value={localBrightness}
          onChange={(e) => handleBrightnessChange(parseInt(e.target.value))}
          className="flex-1 h-1.5 accent-amber-400"
        />
        <span className={`text-[10px] w-6 text-right font-mono ${textSecondary}`}>
          {localBrightness}
        </span>
      </div>
    </div>
  );
}
