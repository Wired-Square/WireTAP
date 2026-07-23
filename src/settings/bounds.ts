// ui/src/settings/bounds.ts
//
// Numeric bounds for the settings inputs — a single source of truth for the
// min/max/step the UI enforces. The Rust backend clamps the same fields to the
// same ranges on save (src-tauri/src/settings.rs `clamp_settings`), which is the
// authoritative guard; the UI values here just drive the input attributes and
// reject-on-out-of-range behaviour. Keep the two in step.

export interface NumericBound {
  min: number;
  max: number;
  step: number;
}

export const SETTINGS_BOUNDS = {
  discoveryHistorySize: { min: 1_000, max: 10_000_000, step: 10_000 },
  queryResultLimit: { min: 100, max: 100_000, step: 1_000 },
  graphBufferSize: { min: 1_000, max: 100_000, step: 1_000 },
  decoderMaxUnmatchedFrames: { min: 100, max: 10_000, step: 100 },
  decoderMaxFilteredFrames: { min: 100, max: 10_000, step: 100 },
  decoderMaxDecodedFrames: { min: 100, max: 5_000, step: 100 },
  decoderMaxDecodedPerSource: { min: 500, max: 20_000, step: 500 },
  transmitMaxHistory: { min: 100, max: 10_000, step: 100 },
  modbusMaxRegisterErrors: { min: 0, max: 1_000, step: 1 },
  smpPort: { min: 1, max: 65_535, step: 1 },
  mcpServerPort: { min: 1_024, max: 65_535, step: 1 },
} as const satisfies Record<string, NumericBound>;

export type SettingsBoundKey = keyof typeof SETTINGS_BOUNDS;

/** Clamp a value into a named bound's [min, max]. */
export function clampSetting(key: SettingsBoundKey, value: number): number {
  const { min, max } = SETTINGS_BOUNDS[key];
  return Math.min(max, Math.max(min, value));
}
