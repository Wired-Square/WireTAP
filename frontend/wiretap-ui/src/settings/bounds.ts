// ui/src/settings/bounds.ts
//
// The settings inputs' min/max/step. The ranges are Rust's (`clamp_settings`,
// generated); the step is how the input moves.

import { SETTING_RANGES } from "../generated/settingRanges";

export interface NumericBound {
  min: number;
  max: number;
  step: number;
}

export const SETTINGS_BOUNDS = {
  discoveryHistorySize: { ...SETTING_RANGES.discovery_history_buffer, step: 10_000 },
  queryResultLimit: { ...SETTING_RANGES.query_result_limit, step: 1_000 },
  graphBufferSize: { ...SETTING_RANGES.graph_buffer_size, step: 1_000 },
  decoderMaxUnmatchedFrames: { ...SETTING_RANGES.decoder_max_unmatched_frames, step: 100 },
  decoderMaxFilteredFrames: { ...SETTING_RANGES.decoder_max_filtered_frames, step: 100 },
  decoderMaxDecodedFrames: { ...SETTING_RANGES.decoder_max_decoded_frames, step: 100 },
  decoderMaxDecodedPerSource: { ...SETTING_RANGES.decoder_max_decoded_per_source, step: 500 },
  transmitMaxHistory: { ...SETTING_RANGES.transmit_max_history, step: 100 },
  modbusMaxRegisterErrors: { ...SETTING_RANGES.modbus_max_register_errors, step: 1 },
  smpPort: { ...SETTING_RANGES.smp_port, step: 1 },
  mcpServerPort: { ...SETTING_RANGES.mcp_server_port, step: 1 },
} as const satisfies Record<string, NumericBound>;

export type SettingsBoundKey = keyof typeof SETTINGS_BOUNDS;
