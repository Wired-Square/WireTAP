// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { InterfaceTraits } from "./InterfaceTraits";
import type { Protocol } from "./Protocol";

/**
 * Configuration for mapping device buses to output buses
 */
export type BusMapping = { 
/**
 * Bus number as reported by the device (0-4)
 */
device_bus: number, 
/**
 * Whether to capture frames from this bus
 */
enabled: boolean, 
/**
 * Bus number to use in emitted frames (0-255)
 */
output_bus: number, 
/**
 * Human-readable interface identifier (e.g., "can0", "serial1")
 */
interface_id: string, 
/**
 * The protocol this bus carries — the *input*. Set from the profile, and
 * overridable per session by the source picker's protocol dropdown.
 */
protocol: Protocol, 
/**
 * What this bus may be set to, for the picker to render. Advisory *output*:
 * Rust answers it from the profile kind, the frontend never sends it.
 */
supported_protocols: Array<Protocol>, 
/**
 * Traits for this specific interface. Derived *output* — always
 * `traits_for_protocol(protocol)`, never what a caller supplied.
 */
traits: InterfaceTraits | null, };
