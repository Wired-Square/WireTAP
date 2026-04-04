// ui/src/types/common.ts
// Shared type definitions used across multiple components

/**
 * Frame information used in frame pickers and sidebars.
 * Represents metadata about a frame for selection/display purposes.
 * The `id` is a composite frame key (e.g. "can:256", "modbus:5013").
 */
export type FrameInfo = {
  id: string;
  len: number;
  isExtended?: boolean;
  bus?: number;
  lenMismatch?: boolean;
  protocol?: string;
};

/**
 * IO Profile configuration for data sources.
 */
export type IOProfile = {
  id: string;
  name: string;
  kind?: string;
  mode?: string;
};

/**
 * Frame ID display format options.
 */
export type FrameIdFormat = "hex" | "decimal";

/**
 * Time display format options for frame views.
 */
export type TimeDisplayFormat = "delta-last" | "delta-start" | "timestamp" | "human";
