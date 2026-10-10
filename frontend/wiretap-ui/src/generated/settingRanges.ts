// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

export const SETTING_RANGES = {
  discovery_history_buffer: { min: 1000, max: 10000000 },
  query_result_limit: { min: 100, max: 100000 },
  graph_buffer_size: { min: 1000, max: 100000 },
  decoder_max_unmatched_frames: { min: 100, max: 10000 },
  decoder_max_filtered_frames: { min: 100, max: 10000 },
  decoder_max_decoded_frames: { min: 100, max: 5000 },
  decoder_max_decoded_per_source: { min: 500, max: 20000 },
  transmit_max_history: { min: 100, max: 10000 },
  modbus_max_register_errors: { min: 0, max: 1000 },
  smp_port: { min: 1, max: 65535 },
  mcp_server_port: { min: 1024, max: 65535 },
} as const;
