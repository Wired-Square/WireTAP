// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Parsed frame message - the main data structure emitted by all readers
 */
export type FrameMessage = { protocol: string, 
/**
 * Host UNIX timestamp in microseconds.
 */
timestamp_us: number, frame_id: number, bus: number, dlc: number, bytes: Array<number>, is_extended: boolean, is_fd: boolean, 
/**
 * Source address (for protocols like J1939, TWC that embed sender ID in frame)
 */
source_address?: number, 
/**
 * Indicates incomplete frame (e.g., no delimiter found at end of stream)
 */
incomplete?: boolean, 
/**
 * Direction: "rx" for received, "tx" for transmitted
 */
direction?: "rx" | "tx", };
