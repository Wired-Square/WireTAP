// ui/src/types/frame.ts

export interface CANFrame {
  ts: number; // timestamp in seconds
  arbitration_id: number;
  data: number[]; // payload bytes
  is_extended?: boolean;
  is_fd?: boolean;
  bus?: number;
  direction?: "rx" | "tx";
}

export interface CANFrameDisplay extends CANFrame {
  id_hex: string; // formatted like "0x123"
  data_hex: string; // formatted like "01 02 03 04"
}

/**
 * Frame message from streaming sources (GVRET, WireTAP backend, Serial, etc.)
 * This is the common type used across Discovery, Decoder, and buffer storage.
 */
export type FrameMessage = {
  protocol: string;
  timestamp_us: number;
  frame_id: number;
  bus: number;
  dlc: number;
  bytes: number[];
  is_extended?: boolean;
  is_fd?: boolean;
  /** Source address (for protocols like J1939 that embed sender ID in frame) */
  source_address?: number;
  /** True if this frame is incomplete (e.g., trailing bytes with no delimiter) */
  incomplete?: boolean;
  /** Direction: "rx" for received, "tx" for transmitted */
  direction?: "rx" | "tx";
};
