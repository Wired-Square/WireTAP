// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Result of probing any real-time device.
 * Provides a unified structure for all device types.
 */
export type DeviceProbeResult = { 
/**
 * Whether the probe was successful (device is online and responding)
 */
success: boolean, 
/**
 * Device type (e.g., "gvret", "slcan", "gs_usb", "socketcan")
 */
source_type: string, 
/**
 * Whether this is a multi-bus device (GVRET can have multiple CAN buses)
 */
is_multi_bus: boolean, 
/**
 * Number of buses available (1 for single-bus devices, 1-5 for GVRET)
 */
bus_count: number, 
/**
 * Primary info line (firmware version, device name, etc.)
 */
primary_info: string | null, 
/**
 * Secondary info line (hardware version, channel count, etc.)
 */
secondary_info: string | null, 
/**
 * Whether device supports CAN FD (gs_usb devices only, None for others)
 */
supports_fd: boolean | null, 
/**
 * Error message if probe failed
 */
error: string | null, };
