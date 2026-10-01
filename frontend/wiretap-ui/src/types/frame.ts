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

export type { FrameMessage } from "../generated/FrameMessage";
